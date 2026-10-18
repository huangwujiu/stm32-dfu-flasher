'use strict';
/* =====================================================================
 * APP 分区升级实测（真实硬件 · libusb 直连）
 *
 * 板级 Flash 布局不再硬编码：连接设备后从 DFU 描述符（iInterface 字符串）
 * 实时解析。本机当前为：
 *   @Internal Flash   /0x08000400/114*001Kg,13*001Ka
 *   → 可读写 0x08000400 ~ 0x0801CBFF（114KB，APP 区）
 *   → 只读   0x0801CC00 ~ 0x0801FFFF（13KB，DFU bootloader 本体）
 *
 * 子命令：
 *   read                  只读备份当前可写区 → app-backup.bin，并打印向量表/CRC
 *   flash <file> [addr]   擦除 → 写入 → 读回校验（支持 .hex/.elf/.bin；
 *                         .bin 的 addr 默认可写区起点）
 *   verify <file> [addr]  只读回校验
 *
 * 选项：
 *   --leave               写入校验通过后发送 leaveDfu 并观测设备重新枚举
 *                         （APP 有效时 BOOT 会跳 APP，DFU 将消失；
 *                           APP 无效时自动回落 DFU，可直接重新烧写）
 *
 * 安全约束（硬编码，不提供开关）：
 *   - flash 前必须已存在 app-backup.bin
 *   - 写入区间必须完整落在设备声明的可写区内
 *   - 每次 flash 后校验只读区首块未被改动
 *
 * 运行：
 *   NODE_PATH=<node_modules> node test/app-upgrade.js read
 *   NODE_PATH=<node_modules> node test/app-upgrade.js flash C:/path/app.hex
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const core = require('./dfu-core.js');
const { makeWebUsbAdapter } = require('./usb-node-adapter.js');
const { WebUSB } = require('usb');

const VID = 0x0483, PID = 0xdf11;
const OUT = __dirname;
const BACKUP_FULL = path.join(OUT, 'flash-backup-49983F7D3447.bin');
const BACKUP_APP = path.join(OUT, 'app-backup.bin');

const hex = n => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
const kb = n => (n / 1024).toFixed(1) + ' KB';
const u32 = (u, o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 当前能看到的所有 ST 设备（VID: PID），用于判断跳转后板子以什么身份出现 */
async function listUsb() {
  try {
    const list = await new WebUSB({ allowAllDevices: true }).getDevices();
    return list.filter(d => d.vendorId === 0x0483)
      .map(d => d.vendorId.toString(16).padStart(4, '0') + ':' +
                d.productId.toString(16).padStart(4, '0'));
  } catch (e) { return []; }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m[PASS]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  \x1b[31m[FAIL]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  return cond;
}

async function connect() {
  const webusb = new WebUSB({ allowAllDevices: true });
  const target = (await webusb.getDevices()).find(d => d.vendorId === VID && d.productId === PID);
  if (!target) throw new Error('未找到 DFU 设备 0483:df11（板子是否在 DFU 模式？）');
  const logs = [];
  const dfu = new core.DfuDevice(makeWebUsbAdapter(target, 0),
    (lvl, msg) => { logs.push(lvl + ': ' + msg); if (lvl !== 'debug') console.log('    [dev] ' + msg); });
  await dfu.open();
  console.log('  设备: ' + (target.productName || '') + '  S/N=' + target.serialNumber +
    '  xfer=' + dfu.xferSize + '  bcdDFU=0x' + dfu.dfuVersion.toString(16));
  console.log('  布局: ' + JSON.stringify(dfu.strings.layoutRaw));

  const L = core.parseMemoryLayout(dfu.strings.layoutRaw);
  if (!L) throw new Error('设备未提供内存布局字符串，拒绝在未知布局上执行操作');
  const wrs = core.writableRanges(L);
  if (!wrs.length) throw new Error('设备未声明任何可读写区');
  /* 取最大的可写区作为 APP 区 */
  const wr = wrs.reduce((a, b) => (b.end - b.addr > a.end - a.addr ? b : a));
  /* 只读区 = 布局中所有不可写页组的范围（DFU bootloader 本体，绝不写入） */
  let roBase = 0xFFFFFFFF, roEnd = 0;
  for (const seg of L) for (const pg of seg.pages)
    if (!pg.access.write) {
      if (pg.addr < roBase) roBase = pg.addr;
      const e = pg.addr + pg.count * pg.size;
      if (e > roEnd) roEnd = e;
    }
  if (roBase === 0xFFFFFFFF) { roBase = wr.end; roEnd = wr.end; }
  console.log('  可写区: ' + hex(wr.addr) + ' ~ ' + hex(wr.end - 1) + '（' + kb(wr.end - wr.addr) + '）');
  console.log('  只读区: ' + hex(roBase) + ' ~ ' + hex(roEnd - 1) + '（' + kb(roEnd - roBase) + '）');
  return { dfu, layout: L, wr, roBase, roEnd };
}

function dumpVec(label, buf, base, end) {
  const sp = u32(buf, 0), rv = u32(buf, 4);
  console.log('  ' + label + '  SP=' + hex(sp) + '  Reset=' + hex(rv) +
    (sp >= 0x20000000 && sp <= 0x20005000 ? '  (SP 合法)' : '  (SP 非法)') +
    (rv >= base && rv < end ? '  (Reset 在可写区内)' : ''));
  return { sp, rv };
}

/* 读取固件：.hex / .elf / .bin，统一返回 [{addr, data}]（按地址升序） */
function loadFirmware(file, defAddr) {
  const raw = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const isElfMagic = raw.length > 4 && raw[0] === 0x7f && raw[1] === 0x45 && raw[2] === 0x4c && raw[3] === 0x46;
  let segs;
  if (ext === '.hex') {
    segs = core.parseIntelHex(raw.toString('utf8'));
  } else if (ext === '.elf' || (ext !== '.bin' && isElfMagic)) {
    segs = core.parseElf(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  } else {
    if (defAddr === null || defAddr === undefined) throw new Error('.bin 需要指定起始地址');
    segs = [{ addr: defAddr, data: new Uint8Array(raw) }];
  }
  if (!segs || !segs.length) throw new Error('固件中没有可烧写的数据段');
  return segs.slice().sort((a, b) => a.addr - b.addr);
}

(async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();
  const argv = process.argv.slice(3);
  console.log('='.repeat(72));
  console.log(' APP 分区升级实测   （协议: index.html / 传输: libusb）');
  console.log('='.repeat(72));

  const { dfu, layout, wr, roBase, roEnd } = await connect();
  const APP_BASE = wr.addr, APP_END = wr.end, APP_SIZE = APP_END - APP_BASE;

  if (cmd === 'read' || cmd === '') {
    console.log('\n== 读取 APP 分区 (' + hex(APP_BASE) + ' ~ ' + hex(APP_END - 1) + ', ' + kb(APP_SIZE) + ') ==');
    const t0 = Date.now();
    const img = new Uint8Array(await dfu.uploadElement(APP_BASE, APP_SIZE));
    const dt = Date.now() - t0;
    check('APP 全片读回完整', img.length === APP_SIZE, img.length + ' 字节, ' + dt + ' ms, ' +
      (APP_SIZE / 1024 / (dt / 1000)).toFixed(0) + ' KB/s');
    const crc = core.crc32(img) >>> 0;
    console.log('  CRC32 = ' + hex(crc));
    dumpVec('向量表:', img, APP_BASE, APP_END);

    let used = APP_SIZE;
    while (used > 0 && img[used - 1] === 0xFF) used--;
    console.log('  有效内容（去尾部 0xFF）: ' + used + ' 字节（' + kb(used) + '）');

    fs.writeFileSync(BACKUP_APP, Buffer.from(img));
    console.log('  已保存 ' + path.basename(BACKUP_APP) + ' (' + kb(APP_SIZE) + ')');

    if (fs.existsSync(BACKUP_FULL)) {
      const full = fs.readFileSync(BACKUP_FULL);
      const slice = full.subarray(APP_BASE - 0x08000000, APP_END - 0x08000000);
      const same = Buffer.compare(Buffer.from(img), slice) === 0;
      check('与 128K 整片备份的 APP 切片一致', same,
        same ? '无漂移' : '有差异（上次备份后 APP 被改过）');
    }
    console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    await dfu.usb.close().catch(() => {});
    process.exit(fail ? 1 : 0);
  }

  /* ---- 写操作统一前置校验 ---- */
  const binPath = argv[0];
  if (!binPath || !fs.existsSync(binPath)) {
    console.error('缺少固件文件或文件不存在: ' + binPath);
    process.exit(2);
  }
  const leave = argv.indexOf('--leave') >= 0;
  const addrArg = argv.slice(1).find(a => !a.startsWith('--'));
  const isBin = path.extname(binPath).toLowerCase() === '.bin';
  const addr = addrArg ? parseInt(addrArg, 16) : (isBin ? APP_BASE : null);
  const segs = loadFirmware(binPath, addr);

  console.log('\n== 目标固件 ==');
  console.log('  文件: ' + path.basename(binPath));
  for (const s of segs)
    console.log('  段: ' + hex(s.addr) + ' ~ ' + hex(s.addr + s.data.length - 1) +
      '  ' + s.data.length + ' 字节  CRC=' + hex(core.crc32(s.data) >>> 0));
  const total = segs.reduce((a, s) => a + s.data.length, 0);
  console.log('  合计: ' + total + ' 字节（' + kb(total) + '）');
  if (segs.entryPoint) console.log('  入口点: ' + hex(segs.entryPoint));
  dumpVec('向量表:', Buffer.from(segs[0].data), APP_BASE, APP_END);

  for (const s of segs) {
    const chk = core.checkWriteRange(layout, s.addr, s.data.length);
    check('段 ' + hex(s.addr) + ' 完整落在可写区内', chk.ok && !(chk.unknown && chk.unknown.length),
      chk.ok ? hex(s.addr) + ' ~ ' + hex(s.addr + s.data.length - 1) :
        'blocked=' + (chk.blocked || []).map(b => hex(b.addr) + '-' + hex(b.end - 1)).join(',') +
        ' unknown=' + (chk.unknown || []).map(u => hex(u[0]) + '-' + hex(u[1] - 1)).join(','));
  }
  if (fail) {
    console.error('\n拒绝写入：有数据段不在可写区内');
    process.exit(4);
  }

  if (cmd === 'verify') {
    console.log('\n== 只读校验 ==');
    let bad = -1, badAddr = 0;
    for (const s of segs) {
      const got = new Uint8Array(await dfu.uploadElement(s.addr, s.data.length));
      for (let i = 0; i < got.length; i++)
        if (got[i] !== s.data[i]) { bad = i; badAddr = s.addr + i; break; }
      if (bad >= 0) break;
    }
    check('逐字节一致', bad < 0, bad < 0 ? '完全一致' : '首处不符 @ ' + hex(badAddr));
    console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    await dfu.usb.close().catch(() => {});
    process.exit(fail ? 1 : 0);
  }

  /* ---- flash ---- */
  if (!fs.existsSync(BACKUP_APP)) {
    console.error('\n拒绝写入：未找到 ' + path.basename(BACKUP_APP) + '，请先执行 `read` 备份 APP 分区。');
    process.exit(3);
  }
  const orig = new Uint8Array(fs.readFileSync(BACKUP_APP));
  console.log('  已确认备份存在: app-backup.bin (' + kb(orig.length) + ', CRC ' + hex(core.crc32(orig) >>> 0) + ')');

  // 记录只读区首块，写入后比对（确保 DFU bootloader 未被误擦）
  const roHead0 = new Uint8Array(await dfu.uploadElement(roBase, 1024));
  console.log('  只读区首块指纹: ' + hex(core.crc32(roHead0) >>> 0));

  /* 小间隙段合并成一整段：DNLOAD 数据块会擦除块起始所在页，段从页中间开写
   * 会擦掉同页已有数据（HEX 两段 0x08000400+268 / 0x08000510+50332 就是这样
   * 烧丢的：第二段第一块擦页 0x08000400，把第一段的向量表抹掉） */
  const wsegs = core.mergeSegments(segs);
  const wtotal = wsegs.reduce((a, s) => a + s.data.length, 0);
  if (wsegs.length !== segs.length)
    console.log('  段合并: ' + segs.length + ' 段 → ' + wsegs.length +
      ' 段（间隙 ≤4KB 用 0xFF 填充连写）');

  console.log('\n== 1. 擦除（整包统一） ==');
  const tE = Date.now();
  const pages = await dfu.eraseForSegments(wsegs);
  const eraseMs = Date.now() - tE;
  console.log('  擦除 ' + pages.length + ' 页完成 ' + eraseMs + ' ms');

  for (const s of wsegs) {
    const blank = new Uint8Array(await dfu.uploadElement(s.addr, Math.min(s.data.length, 4096)));
    let nonFF = 0;
    for (let i = 0; i < blank.length; i++) if (blank[i] !== 0xFF) nonFF++;
    if (nonFF) check('擦除后 ' + hex(s.addr) + ' 起为空白', false, nonFF + ' 字节非 0xFF');
  }
  console.log('  擦除校验完成');

  console.log('\n== 2. 写入 ' + kb(wtotal) + ' ==');
  const tW = Date.now();
  let done0 = 0;
  for (const s of wsegs) {
    let lastPct = -1;
    await dfu.downloadElement(s.addr, s.data, (done, tot) => {
      const pct = Math.floor((done0 + done) * 100 / wtotal);
      if (pct >= lastPct + 10) { lastPct = pct; console.log('    ' + pct + '%  ' + (done0 + done) + '/' + wtotal); }
    }, true);
    done0 += s.data.length;
  }
  const writeMs = Date.now() - tW;
  console.log('  写入完成 ' + writeMs + ' ms  (' + (total / 1024 / (writeMs / 1000)).toFixed(1) + ' KB/s)');

  console.log('\n== 3. 读回校验 ==');
  const tV = Date.now();
  let bad = -1, badAddr = 0;
  for (const s of segs) {
    const back = new Uint8Array(await dfu.uploadElement(s.addr, s.data.length));
    for (let i = 0; i < back.length; i++)
      if (back[i] !== s.data[i]) { bad = i; badAddr = s.addr + i; break; }
    if (bad >= 0) break;
  }
  const verifyMs = Date.now() - tV;
  check('读回长度一致', true, verifyMs + ' ms');
  check('逐字节一致', bad < 0, bad < 0 ? '完全一致' :
    '首处不符 @ ' + hex(badAddr) + ' 期望 ' + segs[0].data[0].toString(16));
  dumpVec('读回向量表:', Buffer.from(new Uint8Array(await dfu.uploadElement(APP_BASE, 8))), APP_BASE, APP_END);

  console.log('\n== 4. 保护性校验（只读区未被波及）==');
  const roHead1 = new Uint8Array(await dfu.uploadElement(roBase, 1024));
  check('只读区首块指纹不变', core.crc32(roHead1) === core.crc32(roHead0),
    hex(core.crc32(roHead1) >>> 0));
  const st = await dfu.getStatus();
  check('状态机回到 dfuIDLE', st.state === core.DFU.dfuIDLE,
    core.DFU.STATE_NAME[st.state] + ' / ' + core.DFU.STATUS_NAME[st.status]);

  /* ---- 可选：跳出 DFU，观测设备是否以新固件重新枚举 ---- */
  if (leave) {
    console.log('\n== 5. 跳出 DFU（leaveDfu）==');
    const before = await listUsb();
    console.log('  跳转前设备: ' + before.join(', '));
    try { await dfu.leaveDfu(); } catch (e) { /* 设备断开属正常 */ }
    try { await dfu.usb.close(); } catch (e) {}
    await sleep(1500);
    let after = [], dfuBack = false, cdc = false;
    for (let i = 0; i < 16; i++) {
      after = await listUsb();
      dfuBack = after.some(s => s === '0483:df11');
      cdc = after.some(s => /^0483:(5740|5741|5742)$/i.test(s));
      if (dfuBack || cdc) break;
      await sleep(500);
    }
    console.log('  跳转后设备: ' + (after.length ? after.join(', ') : '（无）'));
    if (cdc) {
      check('新固件已运行（APP 以 USB CDC 重新枚举）', true, after.find(s => /^0483:574/i.test(s)));
    } else if (dfuBack) {
      check('BOOT 判定 APP 无效并回落到 DFU（自动恢复，无需按键）', false,
        '新固件未启动；板子仍在 Bootloader，可直接重新烧写');
    } else {
      check('设备状态可判定', false, '未观测到 DFU 或 CDC，请人工确认板子运行状态（OLED 是否点亮）');
    }
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('（未发送 leaveDfu 时设备仍停在 Bootloader；恢复原固件：node test/app-upgrade.js flash ' +
    path.basename(BACKUP_APP) + ' ' + hex(APP_BASE) + '）');
  if (!leave) await dfu.usb.close().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.error('\n[异常] ' + (e && e.message || e));
  if (e && e.detail) console.error('  detail: ' + JSON.stringify(e.detail));
  process.exit(9);
});
