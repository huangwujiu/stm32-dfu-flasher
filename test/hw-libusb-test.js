'use strict';
/* =====================================================================
 * 真实 DFU 设备实测（libusb 直连，绕过浏览器 UI）
 *
 * 验证对象：index.html 内联的 dfu-core.js（页面与测试同源，由 test/sync-core.js 抽取）
 * 传输适配：node-usb v3 的 WebUSB 实现 + usb-node-adapter（预 claim 接口）
 *
 * 测试范围（全部只读，不写 Flash、不擦除、不 leaveDfu）：
 *   1. 枚举 / 打开 / DFU 功能描述符
 *   2. UM0424 内存布局解析
 *   3. GETSTATUS 状态机
 *   4. UPLOAD 读回：单块、多块、确定性、跨段
 *   5. 整片 Flash 读回 + 区域图 + 向量表识别 + 备份落盘
 *
 * 运行：
 *   NODE_PATH=<node_modules> node test/hw-libusb-test.js
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const core = require('./dfu-core.js');
const { makeWebUsbAdapter } = require('./usb-node-adapter.js');
const { WebUSB } = require('usb');

const VID = 0x0483, PID = 0xdf11;
const OUT = __dirname;
const hex = n => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
const bufHex = (u, n) => Array.from(u.slice(0, n === undefined ? 16 : n))
  .map(b => b.toString(16).padStart(2, '0')).join(' ');
const u32 = (u, o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m[PASS]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  \x1b[31m[FAIL]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
}

(async function main() {
  console.log('='.repeat(72));
  console.log(' STM32 DFU 真实硬件测试   （协议层: index.html / 传输层: libusb）');
  console.log('='.repeat(72));

  /* ---------- 1. 枚举 ---------- */
  console.log('\n== 1. 设备枚举 ==');
  const webusb = new WebUSB({ allowAllDevices: true });
  const all = await webusb.getDevices();
  const target = all.find(d => d.vendorId === VID && d.productId === PID);
  if (!target) {
    console.error('  未找到 DFU 设备 0483:df11');
    process.exit(1);
  }
  check('VID:PID 匹配 0483:df11', true);
  check('产品名可读', !!target.productName, target.productName);
  check('序列号可读', !!target.serialNumber, target.serialNumber);

  /* ---------- 2. 打开 + 描述符 ---------- */
  console.log('\n== 2. 打开设备 / DFU 描述符 ==');
  const logLines = [];
  const dfu = new core.DfuDevice(makeWebUsbAdapter(target, 0), function (lvl, msg) { logLines.push(lvl + ': ' + msg); });
  const t0 = Date.now();
  await dfu.open();
  console.log('  open() 耗时 ' + (Date.now() - t0) + ' ms');
  check('DFU 接口 (bInterfaceClass=0xFE)', typeof dfu.intf === 'number', 'interface #' + dfu.intf);
  check('wTransferSize 在合理范围', dfu.xferSize >= 64 && dfu.xferSize <= 65536, dfu.xferSize + ' B');
  check('bcdDFU 有效', dfu.dfuVersion > 0, '0x' + dfu.dfuVersion.toString(16).padStart(4, '0'));
  console.log('    manufacturer : ' + (dfu.strings.manufacturer || '(空)'));
  console.log('    product      : ' + (dfu.strings.product || '(空)'));
  console.log('    serial       : ' + (dfu.strings.serial || '(空)'));
  console.log('    layout       : ' + (dfu.strings.layoutRaw || '(空)'));
  check('序列号与设备描述符一致', dfu.strings.serial === target.serialNumber,
    dfu.strings.serial + ' vs ' + target.serialNumber);

  /* ---------- 3. 内存布局 ---------- */
  console.log('\n== 3. UM0424 内存布局解析 ==');
  const layout = dfu.memLayout || [];
  check('布局解析出至少 1 个段', layout.length >= 1, layout.length + ' 段');
  let seg = null;
  for (const s of layout) {
    const pages = s.pages.reduce((a, p) => a + p.count, 0);
    const span = s.end - s.base;
    const pageSum = s.pages.reduce((a, p) => a + p.count * p.size, 0);
    console.log('    ' + s.name + '  ' + hex(s.base) + ' ~ ' + hex(s.end - 1) +
      '   ' + pages + ' 页, span=' + span + ' B, 可擦除=' + s.erasable);
    for (const p of s.pages) console.log('      · ' + p.count + ' × ' + p.size + ' B');
    check('段「' + s.name + '」页尺寸之和等于段跨度', pageSum === span, pageSum + ' vs ' + span);
    check('段「' + s.name + '」页大小是 2 的幂且 ≥ 256',
      s.pages.every(p => (p.size & (p.size - 1)) === 0 && p.size >= 256));
    if (!seg && s.erasable) seg = s;
  }
  check('存在可擦除段', !!seg, seg ? seg.name + ' @ ' + hex(seg.base) : 'none');

  /* ---------- 3b. 访问权限（只读区 / 可读写区） ---------- */
  console.log('\n== 3b. 描述符访问权限（可读写 / 只读） ==');
  const perms = [];
  for (const s of layout)
    for (const p of s.pages)
      perms.push({
        addr: p.addr, end: p.addr + p.count * p.size, count: p.count,
        label: core.accessLabel(p.access), acc: p.access
      });
  for (const p of perms)
    console.log('    ' + hex(p.addr) + ' ~ ' + hex(p.end - 1) +
      '   ' + p.count + ' 页   ' + p.label);
  check('每个页组都解析出访问权限', perms.length >= 1 && perms.every(p => p.acc),
    perms.length + ' 个页组');
  check('权限字母都合法（read/erase/write 全为布尔）',
    perms.every(p => typeof p.acc.read === 'number' || typeof p.acc.read === 'boolean'));
  const roGroups = perms.filter(p => !(p.acc.write && p.acc.erase));
  if (roGroups.length) {
    console.log('    只读区: ' + roGroups.map(p => hex(p.addr) + ' ~ ' + hex(p.end - 1) + '  ' + p.label).join('; '));
    check('只读区不产生任何擦除页', roGroups.every(p =>
      core.pagesToErase(layout, p.addr, p.end - p.addr).length === 0));
    const b = roGroups[0];
    const chk = core.checkWriteRange(layout, b.addr, 0x400);
    check('写入只读区被本地拦下（不会下发 erase/download）',
      !chk.ok && chk.blocked.length === 1,
      chk.blocked.map(x => hex(x.addr) + '-' + hex(x.end - 1) + ' ' + x.label).join(', '));
    const cross = core.checkWriteRange(layout, b.addr - 0x400, 0x800);
    check('跨边界的范围只允许可写侧', !cross.ok && cross.blocked[0].addr === b.addr,
      cross.blocked.map(x => hex(x.addr) + '-' + hex(x.end - 1)).join(', '));
  } else {
    console.log('    （该设备未在描述符里声明只读区）');
  }
  const wr = core.writableRanges(layout);
  check('可写范围非空', wr.length >= 1, wr.map(r => hex(r.addr) + '-' + hex(r.end - 1)).join(', '));
  const appChk = core.checkWriteRange(layout, 0x08001000, 0x17000);
  check('APP 区 92KB（0x08001000+0x17000）整段可写',
    appChk.ok && !appChk.blocked.length && !appChk.unknown.length,
    'blocked=' + appChk.blocked.length + ' unknown=' + appChk.unknown.length);

  /* ---------- 4. GETSTATUS ---------- */
  console.log('\n== 4. GETSTATUS 状态机 ==');
  let st = await dfu.getStatus();
  console.log('    bStatus=' + st.status + ' (' + core.DFU.STATUS_NAME[st.status] + ')' +
    '  bState=' + st.state + ' (' + core.DFU.STATE_NAME[st.state] + ')' +
    '  bwPollTimeout=' + st.pollTimeout + 'ms');
  check('状态机处于 dfuIDLE', st.state === core.DFU.dfuIDLE, core.DFU.STATE_NAME[st.state]);
  check('bStatus == 0', st.status === 0, core.DFU.STATUS_NAME[st.status]);
  check('bwPollTimeout ≤ 65535', st.pollTimeout >= 0 && st.pollTimeout <= 65535, st.pollTimeout + ' ms');

  /* ---------- 5. UPLOAD 读回 ---------- */
  console.log('\n== 5. UPLOAD 读回（只读） ==');
  const READ = seg ? seg.base : 0x08000000;

  const tA = Date.now();
  const d512 = new Uint8Array(await dfu.uploadElement(READ, 512));
  const usedPath = logLines.filter(l => l.indexOf('读回序列') >= 0).map(l => l.replace(/^warn: /, ''));
  console.log('  首块耗时 ' + (Date.now() - tA) + ' ms');
  console.log('  读回路径: ' + (usedPath.length ? usedPath.join(' → ') : '标准序列（一次成功）'));
  check('UPLOAD 512B @' + hex(READ), d512.length === 512, d512.length + ' B');
  console.log('    CRC32 = 0x' + core.crc32(d512).toString(16).toUpperCase().padStart(8, '0'));
  console.log('    head  = ' + bufHex(d512, 16));

  // 向量表合理性（若该地址确实是程序起始）
  const sp = u32(d512, 0), rv = u32(d512, 4);
  const spOk = sp >= 0x20000000 && sp <= 0x20020000 && (sp & 3) === 0;
  const rvOk = (rv & 1) === 1 && seg && rv >= seg.base && rv < seg.end;
  const isVector = spOk && rvOk;
  console.log('    解析: 初始SP=' + hex(sp) + (spOk ? ' ✓' : ' ✗') +
    '  Reset_Handler=' + hex(rv) + (rvOk ? ' ✓' : ' ✗') +
    (isVector ? '   => 认定向量表' : '   => 非向量表'));
  check('首段起始处是有效向量表（SP 在 SRAM、Reset 指向段内且为 Thumb 地址）', isVector);

  // 确定性
  const d512b = new Uint8Array(await dfu.uploadElement(READ, 512));
  check('同区间重复读回一致（确定性）',
    d512b.length === d512.length && d512.every((v, i) => v === d512b[i]));

  // 多块
  const multiLen = dfu.xferSize * 3 + 777;
  const tB = Date.now();
  const dMulti = new Uint8Array(await dfu.uploadElement(READ, multiLen));
  const dtB = Date.now() - tB;
  check('UPLOAD ' + multiLen + 'B（' + Math.ceil(multiLen / dfu.xferSize) + ' 块跨块读）',
    dMulti.length === multiLen, dMulti.length + ' B, ' + dtB + ' ms');
  check('多块读前 512B 与单独读 512B 一致',
    d512.every((v, i) => dMulti[i] === v));

  // 非零偏移
  const off2 = READ + (seg ? seg.pages[0].size * 4 : 4096);
  const dOff = new Uint8Array(await dfu.uploadElement(off2, 256));
  check('UPLOAD 256B @' + hex(off2) + '（偏离段首）', dOff.length === 256, dOff.length + ' B');
  console.log('    head  = ' + bufHex(dOff, 16));

  /* ---------- 6. 整片读回 ---------- */
  console.log('\n== 6. 整片 Flash 读回 + 区域分析 ==');
  const base = 0x08000000, end = seg ? seg.end : 0x08020000;
  const tC = Date.now();
  const full = new Uint8Array(await dfu.uploadElement(base, end - base));
  const dtC = Date.now() - tC;
  console.log('  读回 ' + full.length + ' B (' + (full.length / 1024).toFixed(0) + ' KB) 耗时 ' +
    dtC + ' ms, 速率 ' + (full.length / dtC * 1000 / 1024).toFixed(0) + ' KB/s');
  check('整片读回长度正确', full.length === end - base, full.length + ' / ' + (end - base));
  console.log('    CRC32 = 0x' + core.crc32(full).toString(16).toUpperCase().padStart(8, '0'));

  // 备份落盘
  const bak = path.join(OUT, 'flash-backup-' + (dfu.strings.serial || 'unknown') + '.bin');
  fs.writeFileSync(bak, Buffer.from(full));
  check('固件备份已保存', fs.statSync(bak).size === full.length, path.basename(bak));

  // 区域图（按页分类）
  const PS = seg ? seg.pages[0].size : 1024;
  const cls = [];
  for (let a = base; a < end; a += PS) {
    const c = full.subarray(a - base, a - base + PS);
    let kind;
    if (c.every(b => b === 0xFF)) kind = '擦除FF';
    else if (c.every(b => b === 0x00)) kind = '全零00';
    else {
      const s0 = u32(c, 0), r0 = u32(c, 4);
      kind = (s0 >= 0x20000000 && s0 <= 0x20020000 && (s0 & 3) === 0 &&
              (r0 & 1) === 1 && r0 >= base && r0 < end) ? '向量表' : '数据';
    }
    cls.push({ a, kind });
  }
  const runs = [];
  for (const c of cls) {
    const last = runs[runs.length - 1];
    if (last && last.kind === c.kind && c.a === last.end + PS) last.end = c.a;
    else runs.push({ start: c.a, end: c.a, kind: c.kind });
  }
  console.log('  区域图:');
  for (const r of runs) {
    const sz = (r.end - r.start + PS) / 1024;
    console.log('    ' + hex(r.start) + ' ~ ' + hex(r.end + PS - 1) +
      '  ' + String(sz).padStart(4) + ' KB  ' + r.kind);
  }
  const vecs = cls.filter(c => c.kind === '向量表').map(c => c.a);
  check('识别到至少 1 个向量表', vecs.length >= 1,
    vecs.map(v => hex(v)).join(', '));
  for (const va of vecs) {
    const o = va - base;
    console.log('    向量表 @' + hex(va) + ': SP=' + hex(u32(full, o + 0)) +
      '  Reset=' + hex(u32(full, o + 4)));
  }

  /* ---------- 7. 收尾 ---------- */
  console.log('\n== 7. 收尾 ==');
  const stEnd = await dfu.getStatus();
  check('测试后状态机仍为 dfuIDLE', stEnd.state === core.DFU.dfuIDLE, core.DFU.STATE_NAME[stEnd.state]);
  check('测试后 bStatus == 0', stEnd.status === 0, core.DFU.STATUS_NAME[stEnd.status]);
  console.log('  （未执行 erase / download / leaveDfu：这些会改动 Flash 或退出 Bootloader）');
  try { await target.close(); } catch (e) { }

  console.log('\n' + '='.repeat(72));
  console.log(' 结果: ' + pass + ' 通过 / ' + fail + ' 失败 / ' + (pass + fail) + ' 项');
  console.log('='.repeat(72));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n[异常] ' + (e && e.message ? e.message : e));
  if (e && e.detail) console.error('  detail: ' + JSON.stringify(e.detail));
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
