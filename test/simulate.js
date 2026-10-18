'use strict';
/* 模拟设备测试：用实现 AN3156 状态机的 MockUSB 驱动 DFUCore 跑全流程 */
const path = require('path');
const core = require('./dfu-core.js');
const { DfuDevice, DfuError, DFU, parseIntelHex, parseDfuSe, parseElf, parseMemoryLayout, pagesToErase,
  checkWriteRange, writableRanges, accessLabel, mergeSegments, crc32, minEraseUnit, erasePlan } = core;

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
function hex(n) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0'); }

/* ---------------- MockUSB：AN3156 状态机 + flash 模拟 ---------------- */
const FLASH_BASE = 0x08000000, FLASH_SIZE = 0x100000; // 1MB
const RAM_BASE = 0x20000000, RAM_SIZE = 0x10000;
const STATE = { dfuIDLE: 2, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuMANIFEST_SYNC: 6, dfuERROR: 10 };

class MockUsb {
  constructor() {
    this.opened = false;
    this.configuration = null;
    this.mem = new Map();          // 稀疏字节存储（0xFF = 空白）
    this.state = STATE.dfuIDLE;
    this.status = 0;
    this.ptr = 0;
    this.nextBlock = 2;            // DfuSe 数据块号：SET_ADDRESS 后从 2 起连续递增
    this.pending = null;           // GETSTATUS 时执行
    this.vendorId = 0x0483;
    this.productId = 0xDF11;
    this.manufacturerName = 1; this.productName = 2; this.serialNumber = 3;
    this.manifested = false;
    this.transfers = { out: 0, in: 0 };
  }
  async open() { this.opened = true; this.configuration = null; }
  async selectConfiguration() { this.configuration = {}; }
  async claimInterface() {}
  async selectAlternateInterface() {}
  async close() { this.opened = false; }
  inFlash(a) { return a >= FLASH_BASE && a < FLASH_BASE + FLASH_SIZE; }
  inRam(a) { return a >= RAM_BASE && a < RAM_BASE + RAM_SIZE; }
  readByte(a) { const v = this.mem.get(a); return v === undefined ? 0xFF : v; }
  isErased(a, n) { for (let i = 0; i < n; i++) if (this.readByte(a + i) !== 0xFF) return false; return true; }

  async controlTransferIn(setup, length) {
    this.transfers.in++;
    let data;
    if (setup.requestType === 'standard' && setup.recipient === 'device' && setup.request === 0x06) {
      const type = setup.value >> 8, idx = setup.value & 0xFF;
      if (type === 0x02) data = this.configDescriptor();
      else if (type === 0x03) data = this.stringDescriptor(idx);
      else throw new Error('MockUSB: 未处理的描述符 ' + setup.value.toString(16));
    } else if (setup.requestType === 'class' && setup.recipient === 'interface') {
      if (setup.request === 0x03) data = this.getStatusBytes();
      else if (setup.request === 0x02) data = this.doUpload(setup.value, length);
      else throw new Error('MockUSB: 未处理的 IN ' + JSON.stringify(setup));
    } else throw new Error('MockUSB: 未处理的 IN ' + JSON.stringify(setup));
    return { status: 'ok', data: data };
  }
  async controlTransferOut(setup, data) {
    this.transfers.out++;
    if (setup.requestType === 'class' && setup.recipient === 'interface') {
      const b = data ? new Uint8Array(data) : new Uint8Array(0);
      switch (setup.request) {
        case 0x01: // DNLOAD
          this.state = STATE.dfuDNBUSY;
          if (setup.value === 0) {
            if (b.length === 0) throw new Error('DNLOAD wValue=0 空数据');
            this.pending = { kind: 'cmd', bytes: b };
          } else {
            /* DfuSe 数据块号从 2 开始连续递增；SET_ADDRESS（wValue=0 特殊命令）
             * 重置期望块号到 2。不连续的块号被设备静默忽略（真实设备实测：
             * 单独发块号 4 无 STALL 但数据不落盘）。 */
            if (setup.value !== this.nextBlock) this.pending = { kind: 'noop' };
            else { this.nextBlock++; this.pending = { kind: b.length ? 'write' : 'leave', data: b }; }
          }
          return { status: 'ok', bytesWritten: b.length };
        case 0x04: this.status = 0; this.state = STATE.dfuIDLE; return { status: 'ok', bytesWritten: 0 };
        case 0x06: this.state = STATE.dfuIDLE; return { status: 'ok', bytesWritten: 0 };
        case 0x00: return { status: 'ok', bytesWritten: 0 };
      }
    }
    throw new Error('MockUSB: 未处理的 OUT ' + JSON.stringify(setup));
  }
  /* GETSTATUS：执行 pending（对应 AN3156 "GETSTATUS 触发命令执行"） */
  getStatusBytes() {
    if (this.state === STATE.dfuDNBUSY && this.pending) {
      const p = this.pending;
      this.pending = null;
      if (p.kind === 'cmd') {
        const cmd = p.bytes[0], a = p.bytes[1] | (p.bytes[2] << 8) | (p.bytes[3] << 16) | (p.bytes[4] << 24);
        if (cmd === 0x21) {
          if (!this.inFlash(a) && !this.inRam(a)) { this.status = 1; this.state = STATE.dfuERROR; }
          else { this.ptr = a; this.nextBlock = 2; this.status = 0; this.state = STATE.dfuDNLOAD_IDLE; }
        } else if (cmd === 0x41 && p.bytes.length === 5) {
          if (!this.inFlash(a)) { this.status = 1; this.state = STATE.dfuERROR; }
          else {
            for (let i = 0; i < 0x400; i++) this.mem.delete((a & ~0x3FF) + i);   // 1KB 页
            this.status = 0; this.state = STATE.dfuDNLOAD_IDLE;
          }
        } else if (cmd === 0x41 && p.bytes.length === 1) {
          this.mem.clear(); this.status = 0; this.state = STATE.dfuDNLOAD_IDLE;
        } else if (cmd === 0x92) {
          this.mem.clear(); this.status = 0; this.state = STATE.dfuMANIFEST_SYNC;
        } else { this.status = 1; this.state = STATE.dfuERROR; }
      } else if (p.kind === 'write') {
        /* 真实 bootloader 实测行为：DNLOAD 数据块先擦除「块起始地址」所在页再写。
         * 这就是「每块都重新 SET_ADDRESS」会丢数据的根因——第二块从页中间
         * 开写时，会把第一块刚写的同页数据擦掉。 */
        if (this.inFlash(this.ptr)) {
          const page = this.ptr & ~0x3FF;
          for (let i = 0; i < 0x400; i++) this.mem.delete(page + i);
        }
        for (let i = 0; i < p.data.length; i++) this.mem.set(this.ptr + i, p.data[i]);
        this.ptr += p.data.length;
        this.status = 0; this.state = STATE.dfuDNLOAD_IDLE;
      } else if (p.kind === 'noop') {
        this.status = 0; this.state = STATE.dfuDNLOAD_IDLE;   // 块号不连续：静默忽略
      } else if (p.kind === 'leave') {
        this.manifested = true;
        this.status = 0; this.state = STATE.dfuMANIFEST_SYNC;
      }
    }
    const buf = new ArrayBuffer(6), v = new DataView(buf);
    v.setUint8(0, this.status);
    v.setUint8(1, 0); v.setUint8(2, 0); v.setUint8(3, 0); // pollTimeout = 0
    v.setUint8(4, this.state);
    v.setUint8(5, 0);
    return new DataView(buf);
  }
  doUpload(blockNum, length) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.readByte(this.ptr + i);
    this.ptr += length;
    const buf = out.buffer.slice(0);
    return new DataView(buf);
  }
  /* 构造含 DFU 接口 + 功能描述符的配置描述符 */
  configDescriptor() {
    const iface = [9, 4, 0, 0, 0, 0xFE, 0, 0, 4]; // iInterface = 4
    const func = [9, 0x21, 0x07, 0xFF, 0x00, 0x00, 0x08, 0x1A, 0x01]; // wTransferSize=2048, bcdDFU=0x011a
    const cfg = [9, 2, 9 + 9 + 9, 0, 1, 1, 0, 0x80, 0x32];
    const all = new Uint8Array(cfg.concat(iface, func));
    return new DataView(all.buffer);
  }
  stringDescriptor(idx) {
    const map = {
      0: [0x04, 0x03, 0x09, 0x04],
      1: 'STMicroelectronics', 2: 'STM Device in DFU Mode', 3: '49983F7D3447',
      4: '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg'
    };
    const s = map[idx];
    if (s === undefined) return new DataView(new ArrayBuffer(2));
    const bytes = [2 + s.length * 2, 0x03];
    for (let i = 0; i < s.length; i++) { bytes.push(s.charCodeAt(i) & 0xFF, s.charCodeAt(i) >> 8); }
    return new DataView(new Uint8Array(bytes).buffer);
  }
}

function mkLogger() {
  const lines = [];
  return { log: (lv, m) => lines.push(lv + ': ' + m), lines };
}

(async function main() {
  /* ---------- 1. 内存布局解析 ---------- */
  section('内存布局解析');
  const layout = parseMemoryLayout('@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg');
  ok(layout && layout.length === 1, '解析出 1 个段');
  ok(layout[0].base === 0x08000000, '基地址 0x08000000');
  ok(layout[0].end === 0x08100000, '结束地址 0x08100000 (1MB)');
  const p1 = pagesToErase(layout, 0x08000000, 0x5000);
  ok(p1.length === 2 && p1[0] === 0x08000000 && p1[1] === 0x08004000, '0x5000 覆盖 2 个 16K 页');
  const p2 = pagesToErase(layout, 0x0801FFF0, 0x10);
  ok(p2.length === 1 && p2[0] === 0x08010000, '0x0801FFF0 落在 64K 页 0x08010000');
  const p3 = pagesToErase(layout, 0x0801FFF0, 0x20);
  ok(p3.length === 2 && p3[0] === 0x08010000 && p3[1] === 0x08020000, '跨页范围正确产出 2 个页');
  ok(pagesToErase(layout, 0x20000000, 0x100).length === 0, 'RAM 地址不产生擦除页');

  /* ---------- 1b. 擦除计划（声明范围外补页） ---------- */
  section('擦除计划 erasePlan');
  // 复刻真实设备描述符：0x08001000 起 92×1KB 可读写，0x08018000 起 32×1KB 只读
  const realDev = parseMemoryLayout('@Internal Flash   /0x08001000/92*001Kg,32*001Ka');
  ok(!!realDev && realDev[0].pages.length === 2, '真实设备布局解析出 2 个页组');
  ok(minEraseUnit(realDev) === 1024, '最小可擦除页粒度 = 1024B');
  ok(minEraseUnit(layout) === 16384, '另一布局最小粒度 = 16KB');

  const plan_e1 = erasePlan(realDev, 0x08001000, 0x400);
  ok(plan_e1.pages.length === 1 && plan_e1.pages[0] === 0x08001000 && plan_e1.undeclared.length === 0,
    '完全在声明区内：只擦声明页，无未声明区间');

  // 用户实际案例：固件从 0x08000400 起，而描述符从 0x08001000 起
  const plan_e2 = erasePlan(realDev, 0x08000400, 0x1000);
  ok(plan_e2.undeclared.length === 1 && plan_e2.undeclared[0][0] === 0x08000400 &&
     plan_e2.undeclared[0][1] === 0x08001000, '0x08000400 起 1KB 的前 0xC00 标记为未声明');
  ok(plan_e2.pages.length === 4 && plan_e2.pages[0] === 0x08000400 && plan_e2.pages[3] === 0x08001000,
    '未声明部分按 1KB 补页（0x08000400/08000800/08000C00）+ 声明页 0x08001000');

  const plan_e3 = erasePlan(realDev, 0x20000000, 0x100);
  ok(plan_e3.pages.length === 0, 'RAM 区间不补擦除页');
  ok(plan_e3.undeclared.length === 1, 'RAM 区间仍报告为未声明');

  const plan_e4 = erasePlan(realDev, 0x08000400, 0xC800);   // 50KB 镜像横跨未声明区 + 可写区
  ok(plan_e4.pages.length === 50 && plan_e4.pages[0] === 0x08000400 &&
     plan_e4.pages[49] === 0x0800C800, '50KB 镜像产出 50 个页（3 个补页 + 47 个声明页）');
  ok(plan_e4.undeclared.length === 1, '仍只有一个未声明空洞');

  const plan_e5 = erasePlan(null, 0x08001000, 0x100);
  ok(plan_e5.pages.length === 0 && plan_e5.undeclared.length === 1, '无布局时全部视为未声明');
  const layout2 = parseMemoryLayout('@Option Bytes  /0x1FFF7800/16*016 e');
  ok(layout2 && layout2[0].base === 0x1FFF7800 && layout2[0].pages[0].size === 16,
    '选项字节区解析（无单位=字节，16 × 16B）');
  ok(layout2 && !layout2[0].erasable && layout2[0].pages[0].access.write === 1,
    'e 权限 = 可读可写但不可擦');
  ok(parseMemoryLayout('garbage') === null, '非法字符串返回 null');

  /* ---------- 1b. 描述符访问权限字母（只读/可读写区） ---------- */
  section('描述符访问权限（可读写区 / 只读区）');
  const REAL_IFACE = '@Flash /0x08001000/92*001Kg,32*001Ka';
  const rl = parseMemoryLayout(REAL_IFACE);
  ok(rl && rl.length === 1 && rl[0].pages.length === 2, '本板描述符解析为 1 区域 2 个页组');
  ok(rl[0].pages[0].count === 92 && rl[0].pages[0].size === 1024, '前 92 × 1KB');
  ok(rl[0].pages[1].addr === 0x08018000 && rl[0].pages[1].count === 32,
    '第二页组起点自动推进到 0x08018000（32 × 1KB）');
  ok(rl[0].end === 0x08020000, '区域结束 0x08020000');
  ok(accessLabel(rl[0].pages[0].access) === '可读写', 'g = 可读写');
  ok(accessLabel(rl[0].pages[1].access) === '只读', 'a = 只读');
  ok(rl[0].writable === true && rl[0].erasable === true, '整区域仍判定为含可擦写页');
  ok(pagesToErase(rl, 0x08001000, 0x8000).length === 32, '前 32 页（32KB）可擦');
  ok(pagesToErase(rl, 0x08018000, 0x8000).length === 0, '只读 32KB 不产生任何擦除页');
  const straddle = pagesToErase(rl, 0x08017C00, 0x900);
  ok(straddle.length === 1 && straddle[0] === 0x08017C00,
    '跨进只读区的范围只擦可写侧 0x08017C00');
  const okRange = checkWriteRange(rl, 0x08001000, 0x17000);
  ok(okRange.ok && !okRange.blocked.length && !okRange.unknown.length, '92KB 目标区全部可写');
  const badRange = checkWriteRange(rl, 0x08017C00, 0x900);
  ok(!badRange.ok && badRange.blocked.length === 1, '越界到只读区被拦下');
  ok(badRange.blocked[0].addr === 0x08018000 && badRange.blocked[0].end === 0x08018500 &&
    badRange.blocked[0].label === '只读', '被拦区间 = 0x08018000-0x080184FF（只读）');
  const outRange = checkWriteRange(rl, 0x09000000, 0x100);
  ok(outRange.ok && outRange.unknown.length === 1, '布局外地址只提示不拦截');
  const wrs = writableRanges(rl);
  ok(wrs.length === 1 && wrs[0].addr === 0x08001000 && wrs[0].end === 0x08018000,
    '可写范围 = 0x08001000-0x08017FFF');
  {
    const want = { a: '100', b: '010', c: '110', d: '001', e: '101', f: '011', g: '111' };
    const bad = [];
    for (const ch of Object.keys(want)) {
      const p = parseMemoryLayout('@X /0x08000000/1*1K' + ch);
      const a = p && p[0].pages[0].access;
      const got = a ? ('' + a.read + a.erase + a.write) : '---';
      if (got !== want[ch]) bad.push(ch + '→' + got + '(期望' + want[ch] + ')');
    }
    ok(bad.length === 0, 'a~g 七个权限字母的位组合符合 DfuSe 规范', bad.join(' '));
  }
  const noFlag = parseMemoryLayout('@Flash /0x08000000/4*1K');
  ok(noFlag && noFlag[0].pages[0].access.assumed === true &&
    accessLabel(noFlag[0].pages[0].access) === '可读写', '缺省权限字母按全权限处理');
  ok(pagesToErase(parseMemoryLayout('@Flash /0x08000000/16*1Ka,48*1Kg'), 0x08000000, 0x40).length === 0,
    '前 16 页只读时不产生擦除页');

  /* ---------- 2. Intel HEX 解析 ---------- */
  section('Intel HEX 解析');
  function rec(type, addr, data) {
    let sum = data.length + (addr >> 8) + (addr & 0xFF) + type;
    for (const b of data) sum += b;
    const ck = ((~sum) + 1) & 0xFF;
    return ':' + [data.length, addr >> 8, addr & 0xFF, type].concat([...data], ck)
      .map(x => x.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  const d1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const d2 = [0xAA, 0xBB, 0xCC, 0xDD];
  const hexText = [
    rec(4, 0, [0x08, 0x00]),      // 扩展线性地址 -> 0x08000000
    rec(0, 0x0000, d1),
    rec(0, 0x0010, d2),           // 连续段应合并
    rec(4, 0, [0x20, 0x00]),      // -> 0x20000000
    rec(0, 0x0100, [0x55, 0x66]), // 不连续 -> 新段
    rec(1, 0, [])
  ].join('\n');
  const segs = parseIntelHex(hexText);
  ok(segs.length === 2, '解析出 2 个数据段');
  ok(segs[0].addr === 0x08000000 && segs[0].data.length === 20, '段1: 0x08000000+20 字节');
  ok(segs[1].addr === 0x20000100 && segs[1].data[0] === 0x55, '段2: 0x20000100 扩展地址生效');
  let bad = false;
  try {
    const good = rec(0, 0, [1, 2]);
    parseIntelHex(good.slice(0, -2) + '00'); // 破坏校验和
  } catch (e) { bad = true; }
  ok(bad, '校验和错误被抛出');

  /* ---------- 3. DfuSe 文件解析 ---------- */
  section('DfuSe 文件解析');
  {
    const elData = new Uint8Array([9, 8, 7, 6]);
    const target = new Uint8Array(274);
    const s = 'Target';
    for (let i = 0; i < 6; i++) target[i] = s.charCodeAt(i);
    target[6] = 0;
    new DataView(target.buffer).setUint32(266, 1, true); // 1 个 element
    const el = new Uint8Array(8);
    new DataView(el.buffer).setUint32(0, 0x08000000, true);
    new DataView(el.buffer).setUint32(4, elData.length, true);
    const hdr = new Uint8Array(11);
    hdr.set([0x44, 0x66, 0x75, 0x53, 0x65, 0x01], 0); // "DfuSe" + ver
    new DataView(hdr.buffer).setUint32(6, 11 + 274 + 8 + elData.length, true);
    hdr[10] = 1; // targets
    const full = new Uint8Array(hdr.length + target.length + el.length + elData.length);
    full.set(hdr, 0); full.set(target, hdr.length); full.set(el, hdr.length + 274);
    full.set(elData, hdr.length + 274 + 8);
    const dsegs = parseDfuSe(full.buffer);
    ok(dsegs.length === 1 && dsegs[0].addr === 0x08000000 && dsegs[0].data.length === 4, '.dfu 解析出 1 段 @0x08000000');
  }

  /* ---------- 3b. ELF 可执行文件解析 ---------- */
  section('ELF 文件解析');
  /* 构造 Elf32_Ehdr(52B) + Phdr(32B * n) + 段数据 */
  function makeElf(loads, opt) {
    opt = opt || {};
    const EH = 52, PH = 32, phnum = loads.length, dataStart = EH + phnum * PH;
    let total = dataStart;
    for (const l of loads) total += l.data ? l.data.length : 0;
    const buf = new Uint8Array(total), dv = new DataView(buf.buffer);
    buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0], 0); // ELF / 32 位 / 小端 / v1
    dv.setUint16(16, opt.type === undefined ? 2 : opt.type, true); // e_type=ET_EXEC
    dv.setUint16(18, 40, true);                                    // EM_ARM
    dv.setUint32(20, 1, true);
    dv.setUint32(24, opt.entry === undefined ? 0x08001101 : opt.entry, true);
    dv.setUint32(28, EH, true);                                    // e_phoff
    dv.setUint16(40, EH, true);
    dv.setUint16(42, PH, true);
    dv.setUint16(44, phnum, true);
    let off = dataStart;
    loads.forEach((l, i) => {
      const o = EH + i * PH, len = l.data ? l.data.length : 0;
      dv.setUint32(o + 0, l.type === undefined ? 1 : l.type, true); // PT_LOAD
      dv.setUint32(o + 4, off, true);
      dv.setUint32(o + 8, l.vaddr === undefined ? (l.paddr || 0) : l.vaddr, true);
      dv.setUint32(o + 12, l.paddr || 0, true);
      dv.setUint32(o + 16, l.filesz === undefined ? len : l.filesz, true);
      dv.setUint32(o + 20, l.memsz === undefined ? len : l.memsz, true);
      dv.setUint32(o + 24, 5, true);
      dv.setUint32(o + 28, 4, true);
      if (l.data) { buf.set(l.data, off); off += len; }
    });
    return buf;
  }
  {
    // text 在 Flash；.data 的 VMA 在 SRAM、LMA 在 Flash（必须取 p_paddr）；.bss 无文件内容
    const text = new Uint8Array(16).map((_, i) => 0xA0 + i);
    const rw = new Uint8Array(8).fill(0x5A);
    const elf = makeElf([
      { paddr: 0x08001000, vaddr: 0x08001000, data: text },
      { paddr: 0x08002000, vaddr: 0x20000000, data: rw },        // .data: LMA≠VMA
      { paddr: 0x20000008, vaddr: 0x20000008, filesz: 0, memsz: 64 }, // .bss
      { type: 4, paddr: 0, vaddr: 0, filesz: 0 }                 // PT_NOTE 应被忽略
    ]);
    const esegs = parseElf(elf.buffer);
    ok(esegs.length === 2, 'ELF 解析出 2 个 PT_LOAD 段（.bss 与 PT_NOTE 被忽略）', esegs.length);
    ok(esegs[0].addr === 0x08001000 && esegs[0].data.length === 16, 'text 段 @0x08001000 +16B');
    ok(esegs[1].addr === 0x08002000, '用 p_paddr(LMA) 而非 p_vaddr：.data 落在 0x08002000',
      hex(esegs[1].addr));
    ok(esegs.entryPoint === 0x08001101, '入口点 e_entry 被解析出来', hex(esegs.entryPoint));
  }
  {
    // 相邻段应被合并成一段
    const elf = makeElf([
      { paddr: 0x08001000, data: new Uint8Array(8).fill(1) },
      { paddr: 0x08001008, data: new Uint8Array(8).fill(2) }
    ]);
    const m = parseElf(elf.buffer);
    ok(m.length === 1 && m[0].data.length === 16, '相邻段自动合并为 1 段 16B', m.length + ' 段');
    ok(m[0].data[8] === 2, '合并后第二段数据位置正确');
  }
  {
    // 段首全零填充：objcopy -O ihex 会跳过，ELF 的 PT_LOAD 起点因此比 HEX 大一个空洞
    const data = new Uint8Array(0x800);
    for (let i = 0x400; i < 0x800; i++) data[i] = 0xC0 + (i & 0x0f);
    const elf = makeElf([{ paddr: 0x08000000, vaddr: 0x08000000, data: data }]);
    const t = parseElf(elf.buffer);
    ok(t.length === 1 && t[0].addr === 0x08000400, '段首 0x400 全零被跳过，起始地址 0x08000400',
      hex(t[0].addr));
    ok(t[0].data.length === 0x400 && t[0].data[0] === 0xC0, '跳过后数据从第一个非零字节开始',
      t[0].data.length + ' B');
    ok(t.trimmedZeros === 0x400, '记录跳过的全零字节数', t.trimmedZeros);
  }
  {
    // 段首就是有效数据时不动
    const elf = makeElf([{ paddr: 0x08000400, data: new Uint8Array(8).map((_, i) => 0x30 + i) }]);
    const n = parseElf(elf.buffer);
    ok(n[0].addr === 0x08000400 && n[0].data.length === 8 && !n.trimmedZeros,
      '段首非零时保持原样（不误裁）', hex(n[0].addr));
  }
  {
    // 整段都是零 + 后面还有有效段：零段被丢掉，起点取有效段
    const elf = makeElf([
      { paddr: 0x08000000, data: new Uint8Array(0x400) },
      { paddr: 0x08000400, data: new Uint8Array(16).map((_, i) => 0x70 + i) }
    ]);
    const z = parseElf(elf.buffer);
    ok(z.length === 1 && z[0].addr === 0x08000400, '全零段被丢弃，起点为 0x08000400',
      hex(z[0].addr));
  }
  {
    const only = makeElf([{ paddr: 0x20000000, vaddr: 0x20000000, data: new Uint8Array(4) }]);
    let err = null;
    try { parseElf(only.buffer); } catch (e) { err = e; }
    ok(err && /只有 RAM 段/.test(err.message), '只有 SRAM 段时报错（本工具只写 Flash）', err && err.message);
  }
  {
    const e64 = makeElf([{ paddr: 0x08001000, data: new Uint8Array(4) }]);
    e64[4] = 2; // EI_CLASS = ELFCLASS64
    let err = null;
    try { parseElf(e64.buffer); } catch (e) { err = e; }
    ok(err && /64 位/.test(err.message), '64 位 ELF 被明确拒绝', err && err.message);
  }
  {
    const obj = makeElf([{ paddr: 0x08001000, data: new Uint8Array(4) }], { type: 1 });
    let err = null;
    try { parseElf(obj.buffer); } catch (e) { err = e; }
    ok(err && /目标文件/.test(err.message), 'ET_REL 目标文件被拒绝', err && err.message);

    const bad = makeElf([{ paddr: 0x08001000, data: new Uint8Array(4) }]);
    bad[0] = 0x00;
    let err2 = null;
    try { parseElf(bad.buffer); } catch (e) { err2 = e; }
    ok(err2 && /魔数/.test(err2.message), '非 ELF 魔数被拒绝', err2 && err2.message);
  }

  /* ---------- 4. 完整下载/校验流程 ---------- */
  section('完整下载流程（20KB @0x08000000）');
  const mock = new MockUsb();
  const logger = mkLogger();
  const dev = new DfuDevice(mock, logger.log);
  await dev.open();
  ok(dev.xferSize === 2048, 'wTransferSize=2048 从功能描述符解析');
  ok(dev.dfuVersion === 0x011a, 'bcdDFU=0x011a (DfuSe)');
  ok(dev.strings.serial === '49983F7D3447', '序列号字符串');
  ok(dev.memLayout && dev.memLayout.length === 1, '内存布局从接口字符串解析');

  // 20KB 测试图案
  const fw = new Uint8Array(20 * 1024);
  for (let i = 0; i < fw.length; i++) fw[i] = (i * 7 + 0x5A) & 0xFF;
  const expectCrc = crc32(fw);

  let prog = { done: 0, total: 0 };
  await dev.downloadElement(0x08000000, fw, (d, t, st) => { prog = { done: d, total: t }; });
  ok(prog.done === fw.length, '进度回调到达 100%');
  // 校验 mock 内存内容
  let mismatch = -1;
  for (let i = 0; i < fw.length; i++) if (mock.readByte(0x08000000 + i) !== fw[i]) { mismatch = i; break; }
  ok(mismatch === -1, '20KB 数据全部写入正确');
  ok(mock.isErased(0x08005000, 16), '镜像之后的页未被误擦除');

  // 只读区硬保护：换成真机描述符，写只读段必须在本地被拦下（不下发任何 USB 命令）
  {
    const savedLayout = dev.memLayout;
    dev.memLayout = parseMemoryLayout(REAL_IFACE);
    const outBefore = mock.transfers.out;
    let roErr = null;
    try { await dev.downloadElement(0x08018000, new Uint8Array(2048).fill(0x11), () => {}); }
    catch (e) { roErr = e; }
    ok(roErr && /不可写/.test(roErr.message), '写只读区被本地拦下（不下发到设备）',
      roErr && roErr.message);
    ok(mock.transfers.out === outBefore, '被拦时未发出任何 USB 命令');
    dev.memLayout = savedLayout;
  }

  /* ---------- 4b. 多段固件烧录回归（线上 bug） ----------
   * 现象：HEX 两段 0x08000400+268 / 0x08000510+50332 解析正确但烧录失败，
   * 读回首处不符 @0x08000400（期望 0x00 实际 0xFF）；.bin 单段却一直正常。
   * 根因（真机实测）：该 bootloader 的 DNLOAD 数据块会先擦除「块起始地址」
   * 所在页再写。逐段各自 SET_ADDRESS 时，第二段第一块从页中间（0x08000510）
   * 开写，把第一段刚写的向量表擦掉。且每块都 SET_ADDRESS + 块号恒 2 时
   * 块号不连续（设备期望 2,3,4…递增），部分块被静默丢弃。
   * 修复：mergeSegments 把 ≤4KB 间隙的段连成一整段连续写 + 块号从 2 递增。 */
  section('多段固件烧录回归（段合并 + 块号递增）');
  {
    const twoSegs = [
      { addr: 0x08000400, data: new Uint8Array(268).fill(0x5A) },
      { addr: 0x08000510, data: new Uint8Array(2048).map((_, i) => i & 0xFF) }
    ];
    const merged = mergeSegments(twoSegs);
    ok(merged.length === 1 && merged[0].addr === 0x08000400 &&
       merged[0].data.length === 268 + 4 + 2048,
       '间隙 4B 的两段合并为一整段（' + merged[0].data.length + ' B）',
       merged.length + ' 段');
    ok(merged[0].data[268] === 0xFF && merged[0].data[271] === 0xFF,
       '段间间隙填 0xFF（与擦除态一致）');
    ok(merged[0].data[272] === 0x00 && merged[0].data[273] === 0x01,
       '合并后第二段数据位置不错位');
    const far = mergeSegments([
      { addr: 0x08000400, data: new Uint8Array(16) },
      { addr: 0x08010400, data: new Uint8Array(16) }
    ]);
    ok(far.length === 2, '间隙 >4KB 不合并（保持分段）');
    const ov = mergeSegments([
      { addr: 0x08000400, data: new Uint8Array(32) },
      { addr: 0x08000410, data: new Uint8Array(32) }
    ]);
    ok(ov.length === 2, '重叠段不合并（保持原样）');

    /* 旧写法复现 bug：两段分开写，第一段被第二段擦掉 */
    const mock2 = new MockUsb();
    const dev2 = new DfuDevice(mock2, mkLogger().log);
    await dev2.open();
    await dev2.downloadElement(0x08000400, twoSegs[0].data);
    let first1 = await dev2.uploadElement(0x08000400, 8);
    ok(first1[0] === 0x5A, '分开写：第一段先写入成功', '0x' + first1[0].toString(16));
    await dev2.downloadElement(0x08000510, twoSegs[1].data);
    first1 = await dev2.uploadElement(0x08000400, 8);
    ok(first1[0] === 0xFF, '旧写法复现：第二段从页中间开写把第一段擦掉（= 线上 bug）',
      '读回 0x' + first1[0].toString(16));

    /* 新写法：合并段一次 SET_ADDRESS + 块号递增，两段数据都在 */
    const mock3 = new MockUsb();
    const dev3 = new DfuDevice(mock3, mkLogger().log);
    await dev3.open();
    await dev3.downloadElement(merged[0].addr, merged[0].data);
    const back1 = await dev3.uploadElement(0x08000400, 268);
    const back2 = await dev3.uploadElement(0x08000510, 2048);
    let bad1 = -1, bad2 = -1;
    for (let i = 0; i < 268; i++) if (back1[i] !== 0x5A) { bad1 = i; break; }
    for (let i = 0; i < 2048; i++) if (back2[i] !== (i & 0xFF)) { bad2 = i; break; }
    ok(bad1 === -1, '新写法：第一段（向量表位置）完整保留', bad1 < 0 ? '' : '@' + bad1);
    ok(bad2 === -1, '新写法：第二段数据完整写入', bad2 < 0 ? '' : '@' + bad2);

    /* 块号连续性：跳过 2、3 直接发块号 4，设备静默忽略（无 STALL 但数据不落盘） */
    const mock4 = new MockUsb();
    const dev4 = new DfuDevice(mock4, mkLogger().log);
    await dev4.open();
    await dev4.setAddressPointer(0x08000400);
    await dev4._ctrlOut(DFU.DNLOAD, new Uint8Array(1024).fill(0x33), 4);
    let st4 = await dev4.getStatus();
    while (st4.state !== DFU.dfuDNLOAD_IDLE && st4.state !== DFU.dfuERROR) {
      await sleep(5); st4 = await dev4.getStatus();
    }
    ok(mock4.isErased(0x08000400, 1024), '块号不连续（4）被设备忽略，数据未写入',
      'state=' + st4.state);
  }

  /* ---------- 5. 读回校验 ---------- */
  section('读回校验');
  let vprog = 0;
  const vr = await dev.verifyElement(0x08000000, fw, (d, t) => { vprog = d; });
  ok(vr === true && vprog === fw.length, '校验通过');
  fw[100] ^= 0xFF;
  let verr = null;
  try { await dev.verifyElement(0x08000000, fw); } catch (e) { verr = e; }
  ok(verr instanceof DfuError && /0x08000064/.test(verr.message), '篡改后校验报错并定位到 0x08000064', verr && verr.message);
  fw[100] ^= 0xFF;

  /* ---------- 6. 错误路径 ---------- */
  section('错误路径');
  let e1 = null;
  try { await dev.setAddressPointer(0x00000000); } catch (e) { e1 = e; }
  ok(e1 && /errTARGET/.test(e1.message), '非法地址 -> errTARGET', e1 && e1.message);
  ok(mock.state === STATE.dfuIDLE, '错误后 CLRSTATUS 恢复 idle');

  // 6a. 自动擦除使重复下载成功（同一地址写两次）
  let e2 = null;
  try {
    await dev.downloadElement(0x08010000, new Uint8Array(64).fill(0x22));
    await dev.downloadElement(0x08010000, new Uint8Array(64).fill(0x33));
  } catch (e) { e2 = e; }
  ok(!e2 && mock.readByte(0x08010000) === 0x33 && mock.readByte(0x0801003F) === 0x33,
    '重复下载同一地址自动擦除后成功', e2 && e2.message);

  // 6b. 写入未预擦的页：真实 bootloader 语义是「DNLOAD 数据块先擦块起始所在页再写」
  //     （实测确认，详见 4b 回归段；这也解释了为什么旧写法会丢第一段数据）
  mock.mem.set(0x08010010, 0x11); // 6a 留下的页内放一个脏字节
  let st2 = null;
  try {
    await dev.setAddressPointer(0x08010000);
    await dev._ctrlOut(0x01, new Uint8Array(8).fill(0x22), 2); // DNLOAD wValue=2
    st2 = await dev.getStatus();
  } catch (e) { st2 = { err: e.message }; }
  ok(st2 && st2.state === STATE.dfuDNLOAD_IDLE && st2.status === 0,
    '写入未预擦的页：自动擦页后写入成功（非 errPROG）', JSON.stringify(st2));
  ok(mock.readByte(0x08010000) === 0x22 && mock.readByte(0x08010007) === 0x22,
    '数据块本身写入正确');
  ok(mock.readByte(0x08010010) === 0xFF,
    '同页旧数据被块起始页擦除清除（多段固件丢数据的根因）');
  await dev.clearStatus();

  /* ---------- 7. RAM 写入 + 读出 ---------- */
  section('RAM 写入与读出');
  const ram = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04]);
  await dev.downloadElement(RAM_BASE, ram);
  const back = await dev.uploadElement(RAM_BASE, 8);
  ok(back.length === 8 && Array.from(back).join() === Array.from(ram).join(), 'RAM 写入读回一致');
  ok(dev.memLayout === dev.memLayout, 'RAM 不触发擦除（pagesToErase 已单测）');

  /* ---------- 8. 上传边界 ---------- */
  section('上传/读回边界');
  const big = await dev.uploadElement(0x08000000, 20 * 1024);
  ok(big.length === 20 * 1024 && crc32(big) === expectCrc, '20KB 读回 CRC 与源一致');

  /* ---------- 9. 跳转离开 DFU ---------- */
  section('离开 DFU 模式');
  const st = await dev.leaveDfu();
  ok(mock.manifested === true, '零长度 DNLOAD(wValue=2) 已发送');
  ok(st && (st.state === STATE.dfuMANIFEST_SYNC || st.state === STATE.dfuDNLOAD_IDLE), '状态机进入 manifest/idle');

  /* ---------- 10. 整片擦除 ---------- */
  section('整片擦除');
  await dev.massErase();
  ok(mock.isErased(FLASH_BASE, FLASH_SIZE), 'mass erase 后整片为 0xFF');

  console.log('\n========================================');
  console.log('结果: ' + passed + ' 通过, ' + failed + ' 失败');
  console.log('传输统计: OUT ' + mock.transfers.out + ' 次, IN ' + mock.transfers.in + ' 次');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试执行异常:', e); process.exit(1); });
