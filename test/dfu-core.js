'use strict';
/* =====================================================================
 * STM32 DFU 升级工具
 * 协议依据：AN3156《USB DFU protocol used in the STM32 bootloader》
 *           + dfu-util DfuSe 实现（块号恒为 2，每块前发 SET_ADDRESS）
 * ===================================================================== */

/* ---------------- 基础工具 ---------------- */
var DFUCore = {};
function $(id) { return document.getElementById(id); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function hex(n, w) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w || 8, '0'); }
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function fmtSpeed(bps) {
  if (!isFinite(bps) || bps <= 0) return '--';
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(2) + ' MB/s';
}
function fmtEta(s) {
  if (!isFinite(s) || s <= 0) return '--';
  if (s < 60) return Math.ceil(s) + ' 秒';
  return Math.floor(s / 60) + ' 分 ' + Math.ceil(s % 60) + ' 秒';
}
function crc32(buf) {
  var c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function u8(arrBufferOrView) {
  if (arrBufferOrView instanceof Uint8Array) return arrBufferOrView;
  if (arrBufferOrView && arrBufferOrView.buffer)
    return new Uint8Array(arrBufferOrView.buffer, arrBufferOrView.byteOffset, arrBufferOrView.byteLength);
  return new Uint8Array(arrBufferOrView);
}

/* ---------------- DFU 协议常量 ---------------- */
var DFU = {
  // bRequest
  DETACH: 0x00, DNLOAD: 0x01, UPLOAD: 0x02, GETSTATUS: 0x03,
  CLRSTATUS: 0x04, GETSTATE: 0x05, ABORT: 0x06,
  // bState
  appIDLE: 0, appDETACH: 1, dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4,
  dfuDNLOAD_IDLE: 5, dfuMANIFEST_SYNC: 6, dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8, dfuUPLOAD_IDLE: 9, dfuERROR: 10,
  STATE_NAME: ['appIDLE', 'appDETACH', 'dfuIDLE', 'dfuDNLOAD-SYNC', 'dfuDNBUSY',
    'dfuDNLOAD-IDLE', 'dfuMANIFEST-SYNC', 'dfuMANIFEST', 'dfuMANIFEST-WAIT-RESET',
    'dfuUPLOAD-IDLE', 'dfuERROR'],
  STATUS_NAME: ['OK', 'errTARGET', 'errFILE', 'errWRITE', 'errERASE', 'errCHECK_ERASED',
    'errPROG', 'errVERIFY', 'errADDRESS', 'errNOTDONE', 'errFIRMWARE', 'errVENDOR',
    'errUSB', 'errPOR', 'errUNKNOWN', 'errSTALLEDPKT'],
  // ST DfuSe 扩展命令（作为 DNLOAD(wValue=0) 的第一个字节）
  CMD_SET_ADDRESS: 0x21,
  CMD_ERASE_PAGE: 0x41,
  CMD_READ_UNPROTECT: 0x92
};
function dfuStateName(s) { return DFU.STATE_NAME[s] || ('state' + s); }
function dfuStatusName(s) { return DFU.STATUS_NAME[s] || ('status' + s); }

/* ---------------- 内存布局解析（UM0424 §4.3.2，iInterface 字符串） ----------------
 * 形如："@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg"
 * 也见于："@Option Bytes  /0x1FFF7800/16*016 e"、"/0x1FFFF800/16*016Kg" 等
 *
 * 每组「页数*页大小」后面可以带一个访问权限字母，按位组合：
 *   a=只读(001)  b=仅擦除(010)  c=读+擦(011)  d=仅写(100)
 *   e=读+写(101) f=擦+写(110)    g=读+擦+写(111)
 * 字母缺省时按「全权限」处理（老描述符常省略）。例如本板：
 *   "@Flash /0x08001000/92*001Kg,32*001Ka"
 *   → 0x08001000 起 92KB 可擦可写；0x08018000 起 32KB 只读（bootloader 自保护区）
 */
var DFU_ACCESS = {
  a: { read: 1, erase: 0, write: 0 },
  b: { read: 0, erase: 1, write: 0 },
  c: { read: 1, erase: 1, write: 0 },
  d: { read: 0, erase: 0, write: 1 },
  e: { read: 1, erase: 0, write: 1 },
  f: { read: 0, erase: 1, write: 1 },
  g: { read: 1, erase: 1, write: 1 }
};
/* 解析权限字母 → {read,erase,write,flag,assumed} */
function accessOf(ch) {
  if (!ch) return { read: 1, erase: 1, write: 1, flag: '', assumed: true };
  var f = DFU_ACCESS[String(ch).toLowerCase()];
  if (!f) return { read: 1, erase: 1, write: 1, flag: String(ch).toLowerCase(), unknown: true };
  return { read: f.read, erase: f.erase, write: f.write, flag: String(ch).toLowerCase() };
}
function accessLabel(acc) {
  if (!acc) return '未知';
  if (acc.read && acc.erase && acc.write) return '可读写';
  if (acc.read && !acc.erase && !acc.write) return '只读';
  if (acc.read && acc.erase && !acc.write) return '只读·可擦';
  if (acc.read && !acc.erase && acc.write) return '可读·可写';
  if (!acc.read && acc.erase && !acc.write) return '仅擦除';
  if (!acc.read && !acc.erase && acc.write) return '仅写入';
  return '擦+写';
}
/* 能否整段烧写（必须先擦后写） */
function accessProgrammable(acc) { return !!(acc && acc.write && acc.erase); }

function parseMemoryLayout(str) {
  if (!str || str.charAt(0) !== '@') return null;
  var segs = [], cur = null;
  var parts = str.slice(1).replace(/，/g, ',').split(',');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) continue;
    var m = part.match(/^(.*?)\s*\/\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)\s*\/\s*(.*)$/);
    if (m) {
      cur = { name: m[1].trim(), base: parseInt(m[2], 16), pages: [], end: 0, raw: part };
      segs.push(cur);
      addLayoutEntry(m[3], cur);
    } else if (cur) {
      addLayoutEntry(part, cur);
    }
  }
  for (var j = 0; j < segs.length; j++) {
    var s = segs[j], addr = s.base;
    for (var p = 0; p < s.pages.length; p++) {
      s.pages[p].addr = addr;
      addr += s.pages[p].count * s.pages[p].size;
    }
    s.end = addr;
    // RAM 段永远不做擦除（本板甚至拒绝 SRAM 写入）
    var ramLike = s.base >= 0x20000000 && !/flash|eeprom|otp|option/i.test(s.name);
    s.erasable = !ramLike && s.pages.some(function (pg) { return pg.access.erase; });
    s.writable = !ramLike && s.pages.some(function (pg) { return accessProgrammable(pg.access); });
    s.readable = s.pages.some(function (pg) { return pg.access.read; });
    s.readOnly = !ramLike && !s.writable;   // 整段没有任何「可擦+可写」页
  }
  return segs.length ? segs : null;
}
function addLayoutEntry(str, seg) {
  // 页数 * 页大小 [单位 K/M/G，缺省为字节] [权限字母 a-g]
  var m = str.match(/^\s*(\d+)\s*\*\s*(\d+)\s*([kKmMgG])?\s*([a-gA-G])?\s*$/);
  if (!m) return;
  var unit = m[3] ? m[3].toLowerCase() : '';
  var mult = unit === 'k' ? 1024 : (unit === 'm' ? 1048576 : (unit === 'g' ? 1073741824 : 1));
  seg.pages.push({
    count: parseInt(m[1], 10),
    size: parseInt(m[2], 10) * mult,
    unit: unit || 'B',
    access: accessOf(m[4])
  });
}
/* 返回覆盖 [addr, addr+len) 的所有「可擦除」页地址；只读页、RAM/未知区域返回空数组 */
function pagesToErase(layout, addr, len) {
  if (!layout || len <= 0) return [];
  var end = addr + len, out = [], seen = {};
  for (var i = 0; i < layout.length; i++) {
    var seg = layout[i];
    if (!seg.erasable || !seg.pages.length) continue;
    for (var j = 0; j < seg.pages.length; j++) {
      var pg = seg.pages[j];
      if (!pg.access.erase) continue;             // 设备报告为只读的页不能擦
      for (var k = 0; k < pg.count; k++) {
        var ps = pg.addr + k * pg.size;
        if (ps < end && ps + pg.size > addr && !seen[ps]) { seen[ps] = 1; out.push(ps); }
      }
    }
  }
  out.sort(function (x, y) { return x - y; });
  return out;
}
/* 布局中最小的「可擦除」页大小，用作声明范围外的补页粒度 */
function minEraseUnit(layout) {
  var u = 0;
  if (!layout) return 0;
  for (var i = 0; i < layout.length; i++) {
    for (var j = 0; j < layout[i].pages.length; j++) {
      var pg = layout[i].pages[j];
      if (!pg.access || !pg.access.erase) continue;
      if (!u || pg.size < u) u = pg.size;
    }
  }
  return u;
}
/* 擦除计划：声明范围内的页用 pagesToErase；
 * 完全落在声明范围外的部分（设备没报告的地址）按最小页粒度补页，
 * 并通过 undeclared 告诉上层「这些页设备没声明，擦了也可能白擦/有风险」。
 * 不补页的后果：跳过擦除直接写非空 flash，设备必然报错（表现为「地址对但烧录失败」）。 */
function erasePlan(layout, addr, len) {
  var pages = pagesToErase(layout, addr, len);
  if (!layout || !layout.length || !(len > 0))
    return { pages: pages, undeclared: [[addr, addr + len]] };
  var declared = [];
  for (var i = 0; i < layout.length; i++) {
    for (var j = 0; j < layout[i].pages.length; j++) {
      var pg = layout[i].pages[j];
      if (!pg.access || !pg.access.erase) continue;
      declared.push([pg.addr, pg.addr + pg.count * pg.size]);
    }
  }
  var holes = [[addr, addr + len]];
  for (var k = 0; k < declared.length; k++)
    holes = cutRange(holes, declared[k][0], declared[k][1]);
  if (!holes.length) return { pages: pages, undeclared: [] };
  var unit = minEraseUnit(layout) || 1024, seen = {};
  for (var m = 0; m < pages.length; m++) seen[pages[m]] = 1;
  for (var h = 0; h < holes.length; h++) {
    if (holes[h][0] >= 0x20000000 && holes[h][1] <= 0x40000000) continue;  // RAM 不擦
    var s = Math.floor(holes[h][0] / unit) * unit;
    for (var p = s; p < holes[h][1]; p += unit)
      if (!seen[p]) { seen[p] = 1; pages.push(p); }
  }
  pages.sort(function (x, y) { return x - y; });
  return { pages: pages, undeclared: holes };
}
/* 合并相邻数据段：间隙 ≤ maxGap（默认 4KB）时用 0xFF 填充连成一整段。
 * 为什么需要：DNLOAD 数据块会先擦除「块起始地址」所在页再写（实测该
 * bootloader 行为），段从页中间开始就会擦掉同页里已有数据——HEX 两段
 * 0x08000400+268 / 0x08000510+50332 若分开写，第二段第一块擦页 0x08000400
 * 会把第一段的向量表抹掉（读回首处不符 @0x08000400）。合并成一段连续写
 * 则每块都从页对齐地址推进，不会擦已写内容。 */
function mergeSegments(segs, maxGap) {
  if (!segs || !segs.length) return [];
  var sorted = segs.slice().sort(function (a, b) { return a.addr - b.addr; });
  var limit = maxGap === undefined || maxGap === null ? 4096 : maxGap;
  var out = [{ addr: sorted[0].addr, data: new Uint8Array(sorted[0].data) }];
  for (var i = 1; i < sorted.length; i++) {
    var last = out[out.length - 1];
    var end = last.addr + last.data.length;
    var gap = sorted[i].addr - end;
    if (gap >= 0 && gap <= limit) {
      var merged = new Uint8Array(last.data.length + gap + sorted[i].data.length);
      merged.fill(0xFF);                                     // 间隙 = 擦除态
      merged.set(last.data);
      merged.set(sorted[i].data, last.data.length + gap);
      last.data = merged;
    } else {
      out.push({ addr: sorted[i].addr, data: new Uint8Array(sorted[i].data) });
    }
  }
  return out;
}
function cutRange(list, a, b) {   // 从区间集合里挖掉 [a,b)
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i][0], e = list[i][1];
    if (b <= s || a >= e) { out.push([s, e]); continue; }
    if (s < a) out.push([s, a]);
    if (b < e) out.push([b, e]);
  }
  return out;
}
function pushMergedRange(list, a, b, name, label) {
  var last = list[list.length - 1];
  if (last && last.end === a && last.name === name && last.label === label) { last.end = b; return last; }
  var item = { addr: a, end: b, name: name, label: label };
  list.push(item);
  return item;
}
/* 判定 [addr, addr+len) 是否落在可擦写区内
 * 返回 { checked, ok, blocked:[{addr,end,name,label}], unknown:[[a,b]] }
 *   blocked = 被只读/不可擦页挡住的区间（硬错误）
 *   unknown = 布局里完全没有描述的地址（写入通常也会失败，仅提示） */
function checkWriteRange(layout, addr, len) {
  var res = { checked: false, ok: true, blocked: [], unknown: [] };
  if (!layout || !layout.length || !(len > 0)) return res;
  res.checked = true;
  var end = addr + len, holes = [[addr, end]];
  for (var i = 0; i < layout.length; i++) {
    var seg = layout[i];
    for (var j = 0; j < seg.pages.length; j++) {
      var pg = seg.pages[j];
      var ps = pg.addr, pe = pg.addr + pg.count * pg.size;
      if (!(pe > addr && ps < end)) continue;
      var a = Math.max(ps, addr), b = Math.min(pe, end);
      holes = cutRange(holes, a, b);
      if (!accessProgrammable(pg.access))
        pushMergedRange(res.blocked, a, b, seg.name, accessLabel(pg.access));
    }
  }
  res.unknown = holes;
  res.ok = res.blocked.length === 0;
  return res;
}
/* 布局中所有「可擦写」区间（用于提示用户正确目标地址） */
function writableRanges(layout) {
  var out = [];
  if (!layout) return out;
  for (var i = 0; i < layout.length; i++) {
    var seg = layout[i];
    for (var j = 0; j < seg.pages.length; j++) {
      var pg = seg.pages[j];
      if (!accessProgrammable(pg.access)) continue;
      pushMergedRange(out, pg.addr, pg.addr + pg.count * pg.size, seg.name, '可读写');
    }
  }
  return out;
}
function segmentOf(layout, addr) {
  if (!layout) return null;
  for (var i = 0; i < layout.length; i++)
    if (addr >= layout[i].base && addr < layout[i].end) return layout[i];
  return null;
}

/* ---------------- Intel HEX 解析 ---------------- */
function parseIntelHex(text) {
  var lines = text.split(/\r?\n/);
  var upper = 0, extSeg = 0;
  var segs = [];
  function push(addr, data) {
    var last = segs[segs.length - 1];
    if (last && last.addr + last.data.length === addr) {
      var merged = new Uint8Array(last.data.length + data.length);
      merged.set(last.data); merged.set(data, last.data.length);
      last.data = merged;
    } else {
      segs.push({ addr: addr, data: data.slice() });
    }
  }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    if (line.charAt(0) !== ':')
      throw new Error('第 ' + (i + 1) + ' 行不是有效的 HEX 记录');
    var hexpart = line.slice(1);
    if (hexpart.length % 2) throw new Error('第 ' + (i + 1) + ' 行长度错误');
    var b = [];
    for (var j = 0; j < hexpart.length; j += 2) b.push(parseInt(hexpart.substr(j, 2), 16));
    var sum = 0;
    for (var s = 0; s < b.length; s++) sum += b[s];
    if ((sum & 0xFF) !== 0)
      throw new Error('第 ' + (i + 1) + ' 行校验和错误');
    var len = b[0], addr = (b[1] << 8) | b[2], type = b[3];
    var data = b.slice(4, 4 + len);
    if (type === 0x00) {
      push(extSeg * 16 + upper * 0x10000 + addr, new Uint8Array(data));
    } else if (type === 0x01) {
      return segs;
    } else if (type === 0x02) {
      extSeg = (data[0] << 8) | data[1];
    } else if (type === 0x04) {
      upper = (data[0] << 8) | data[1];
    }
    // 0x03 / 0x05 等忽略
  }
  return segs;
}

/* ---------------- DfuSe (.dfu) 文件解析（UM0391） ---------------- */
function parseDfuSe(buf) {
  var d = new DataView(buf);
  var sig = '';
  for (var i = 0; i < 5; i++) sig += String.fromCharCode(d.getUint8(i));
  if (sig !== 'DfuSe') throw new Error('不是有效的 DfuSe 文件（签名错误）');
  var targets = d.getUint8(10);
  var off = 11, segs = [];
  for (var t = 0; t < targets && off + 274 <= buf.byteLength; t++) {
    var tsig = '';
    for (var k = 0; k < 6; k++) tsig += String.fromCharCode(d.getUint8(off + k));
    if (tsig !== 'Target') throw new Error('DfuSe target 签名错误 @' + off);
    var nElem = d.getUint32(off + 266, true);
    off += 274;
    for (var e = 0; e < nElem && off + 8 <= buf.byteLength; e++) {
      var ea = d.getUint32(off, true), es = d.getUint32(off + 4, true);
      off += 8;
      if (off + es > buf.byteLength) throw new Error('DfuSe element 数据越界');
      segs.push({ addr: ea, data: new Uint8Array(buf, off, es) });
      off += es;
    }
  }
  if (!segs.length) throw new Error('DfuSe 文件中没有数据段');
  return segs;
}

/* ---------------- ELF 文件解析（.elf） ---------------- */
/* 只取 PT_LOAD 段，且地址用 p_paddr（LMA）：
   Cortex-M 的 .data 其 VMA 在 SRAM(0x2000xxxx)、LMA 才在 Flash，
   用 p_vaddr 会把数据写到错误地址。p_filesz=0 的段（.bss）无需写入。 */
function parseElf(buf) {
  var u8 = new Uint8Array(buf);
  if (buf.byteLength < 52) throw new Error('文件太小，不是有效的 ELF');
  if (!(u8[0] === 0x7f && u8[1] === 0x45 && u8[2] === 0x4c && u8[3] === 0x46))
    throw new Error('不是有效的 ELF 文件（魔数错误）');
  var cls = u8[4], endian = u8[5];
  if (cls !== 1) throw new Error('暂不支持 64 位 ELF，请提供 32 位 ARM 可执行文件');
  if (endian !== 1 && endian !== 2) throw new Error('ELF 字节序字段无效');
  var le = endian === 1;
  var d = new DataView(buf);

  var etype = d.getUint16(16, le);
  var entry = d.getUint32(24, le);
  var phoff = d.getUint32(28, le);
  var phentsize = d.getUint16(42, le);
  var phnum = d.getUint16(44, le);
  if (etype === 1) throw new Error('这是 ELF 目标文件（.o），不是可执行文件');
  if (!phnum || !phoff) throw new Error('ELF 中没有程序头，无法定位代码段');
  if (phentsize < 32) throw new Error('ELF 程序头大小异常（' + phentsize + '）');
  if (phoff + phnum * phentsize > buf.byteLength) throw new Error('ELF 程序头超出文件范围');

  var segs = [], skipped = 0, phList = [], lmaMap = [];
  for (var i = 0; i < phnum; i++) {
    var o = phoff + i * phentsize;
    if (d.getUint32(o, le) !== 1) continue;              // 只要 PT_LOAD
    var poff = d.getUint32(o + 4, le);
    var vaddr = d.getUint32(o + 8, le);
    var paddr = d.getUint32(o + 12, le);
    var filesz = d.getUint32(o + 16, le);
    phList.push({ idx: i, vaddr: vaddr, paddr: paddr, filesz: filesz, offset: poff });
    if (!filesz) continue;                               // .bss 无需写入
    if (poff + filesz > buf.byteLength) throw new Error('ELF 段数据越界（offset ' + poff + '）');
    lmaMap.push({ vaddr: vaddr, paddr: paddr, filesz: filesz });
  }
  /* VMA → LMA：.data 的 VMA 在 SRAM，LMA 才在 Flash（程序头的 p_paddr） */
  function toLma(v) {
    for (var m = 0; m < lmaMap.length; m++)
      if (v >= lmaMap[m].vaddr && v < lmaMap[m].vaddr + lmaMap[m].filesz)
        return lmaMap[m].paddr + (v - lmaMap[m].vaddr);
    return v;
  }
  function isSram(a) { return a >= 0x20000000 && a < 0x40000000; }

  /* 优先按节表（SHF_ALLOC）取段：与 objcopy -O ihex/binary 的输出完全一致，
   * 且天然避开 ld 圈进第一个 PT_LOAD 的 ELF 头（p_offset=0 时段内包含文件头），
   * .data 也能通过 VMA→LMA 映射拿到 Flash 加载地址。 */
  var shoff = d.getUint32(32, le);
  var shentsize = d.getUint16(46, le);
  var shnum = d.getUint16(48, le);
  var usedSections = false;
  if (shoff && shnum && shentsize >= 40 && shoff + shnum * shentsize <= buf.byteLength) {
    for (var s = 0; s < shnum; s++) {
      var so = shoff + s * shentsize;
      var shType = d.getUint32(so + 4, le);
      var shFlags = d.getUint32(so + 8, le);
      var shAddr = d.getUint32(so + 12, le);
      var shOff = d.getUint32(so + 16, le);
      var shSize = d.getUint32(so + 20, le);
      if (shType === 0 || shType === 8) continue;          // SHT_NULL / SHT_NOBITS(.bss)
      if (!(shFlags & 0x2)) continue;                      // 非 SHF_ALLOC
      if (!shSize || !shAddr) continue;
      if (shOff + shSize > buf.byteLength) continue;
      var a = toLma(shAddr);
      if (isSram(a)) { skipped++; continue; }
      segs.push({ addr: a, data: u8.subarray(shOff, shOff + shSize) });
    }
    usedSections = segs.length > 0;
  }
  if (!usedSections) {
    /* 回退：只有程序头（strip 过的 ELF）。ld 常把 ELF 头 + 程序头表圈进第一个
     * PT_LOAD（p_offset=0），这些字节不是固件内容（objcopy 也不会输出），
     * 必须跳过，否则会把 0x7F 'E' 'L' 'F' 当向量表写到 flash 起始地址，
     * 表现为「ELF 起始地址比 HEX 大出一个文件头 + 零填充」（0x08000000 vs 0x08000400）。 */
    var hdrEnd = phoff + phnum * phentsize;
    for (var j = 0; j < phnum; j++) {
      var o2 = phoff + j * phentsize;
      if (d.getUint32(o2, le) !== 1) continue;
      var poff2 = d.getUint32(o2 + 4, le);
      var vaddr2 = d.getUint32(o2 + 8, le);
      var paddr2 = d.getUint32(o2 + 12, le);
      var filesz2 = d.getUint32(o2 + 16, le);
      if (!filesz2) continue;
      var addr2 = paddr2 || vaddr2;
      if (poff2 < hdrEnd) {
        var skip = Math.min(hdrEnd - poff2, filesz2);
        poff2 += skip; filesz2 -= skip; addr2 += skip;
        if (!filesz2) continue;
      }
      if (!addr2 || isSram(addr2)) { skipped++; continue; }
      segs.push({ addr: addr2, data: u8.subarray(poff2, poff2 + filesz2) });
    }
  }
  if (!segs.length)
    throw new Error(skipped ? 'ELF 中只有 RAM 段，没有可烧写的 Flash 段' : 'ELF 中没有可加载的数据段');

  segs.sort(function (a, b) { return a.addr - b.addr; });
  var out = [];
  for (var k = 0; k < segs.length; k++) {
    var last = out[out.length - 1];
    if (last && last.addr + last.data.length === segs[k].addr) {
      var merged = new Uint8Array(last.data.length + segs[k].data.length);
      merged.set(last.data); merged.set(segs[k].data, last.data.length);
      last.data = merged;
    } else {
      out.push({ addr: segs[k].addr, data: new Uint8Array(segs[k].data) });
    }
  }
  out.entryPoint = entry;   // 供界面显示（数组附加属性，不影响遍历）
  out.ptLoad = phList;      // 程序头明细，供界面诊断「起始地址对不上」
  /* 仅回退路径需要跳过段首全零填充：objcopy -O ihex 不输出全零段，所以同一份工程的
   * HEX 起始地址会比 ELF 的 PT_LOAD 起点大出一个空洞（典型 0x08000000 vs 0x08000400）。
   * 向下取齐到 4 字节——向量表项都是 4 字节对齐的，真实数据的前导零不足 4 字节，
   * 取齐后不会把 SP 的低字节（如 0x20005000 的首字节 0x00）误吞。 */
  if (!usedSections) {
    var lead = 0;
    while (lead < out[0].data.length && out[0].data[lead] === 0) lead++;
    lead &= ~3;
    if (lead > 0) {
      out[0].addr += lead;
      out[0].data = out[0].data.subarray(lead);
      out.trimmedZeros = lead;
      if (!out[0].data.length) out.shift();
    }
  }
  return out;
}
/* 按魔数判断，防止扩展名写错（.elf.txt 之类）走成裸 bin */
function looksLikeElf(buf) {
  var u = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return u.length === 4 && u[0] === 0x7f && u[1] === 0x45 && u[2] === 0x4c && u[3] === 0x46;
}

/* ---------------- DFU 设备类 ---------------- */
function DfuError(msg, detail) { this.name = 'DfuError'; this.message = msg; this.detail = detail; }
DfuError.prototype = Object.create(Error.prototype);

function DfuDevice(usbDevice, logger) {
  this.usb = usbDevice;
  this.intf = 0;
  this.xferSize = 2048;
  this.dfuVersion = 0;
  this.memLayout = null;
  this.strings = {};
  this.cancelFlag = false;
  this.log = logger || function () {};
}
DfuDevice.prototype.throwIfCancelled = function () {
  if (this.cancelFlag) throw new DfuError('操作已取消');
};
DfuDevice.prototype._ctrlOut = function (request, data, wValue) {
  var self = this;
  return this.usb.controlTransferOut({
    requestType: 'class', recipient: 'interface', request: request,
    value: wValue || 0, index: this.intf
  }, data).then(function (r) {
    if (r.status !== 'ok') throw new DfuError('控制传输失败: ' + r.status);
    return r.bytesWritten;
  }, function (e) { throw new DfuError('控制传输失败: ' + e); });
};
DfuDevice.prototype._ctrlIn = function (request, length, wValue, type, recipient) {
  return this.usb.controlTransferIn({
    requestType: type || 'class', recipient: recipient || 'interface', request: request,
    value: wValue || 0, index: this.intf
  }, length).then(function (r) {
    if (r.status !== 'ok') throw new DfuError('控制传输失败: ' + r.status);
    return r.data;
  }, function (e) { throw new DfuError('控制传输失败: ' + e); });
};
DfuDevice.prototype.getStringDescriptor = async function (idx) {
  var d = (await this.usb.controlTransferIn({
    requestType: 'standard', recipient: 'device', request: 0x06,
    value: 0x0300 | idx, index: 0
  }, 255)).data;
  var u = u8(d), n = u[0] || 2, out = '';
  for (var i = 2; i + 1 < n; i += 2) out += String.fromCharCode(u[i] | (u[i + 1] << 8));
  return out;
};

DfuDevice.prototype.open = async function () {
  await this.usb.open();
  if (this.usb.configuration === null) await this.usb.selectConfiguration(1);

  // 通过原始配置描述符定位 DFU 接口与功能描述符（WebUSB 不直接暴露 0x21 描述符）
  var raw = (await this.usb.controlTransferIn({
    requestType: 'standard', recipient: 'device', request: 0x06,
    value: 0x0200, index: 0
  }, 512)).data;
  var d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  var dfuIntf = null, off = 0;
  while (off + 2 <= raw.byteLength) {
    var len = d.getUint8(off), type = d.getUint8(off + 1);
    if (len < 2 || off + len > raw.byteLength) break;
    if (type === 0x04 && len >= 9 && d.getUint8(off + 5) === 0xFE && !dfuIntf) {
      dfuIntf = { number: d.getUint8(off + 2), alt: d.getUint8(off + 3), iInterface: d.getUint8(off + 8) };
    }
    if (type === 0x21 && len >= 9) { // DFU functional descriptor
      this.xferSize = d.getUint16(off + 5, true) || 2048;
      this.dfuVersion = d.getUint16(off + 7, true);
    }
    off += len;
  }
  if (!dfuIntf) throw new DfuError('未找到 DFU 接口（interface class 0xFE）');
  this.intf = dfuIntf.number;
  await this.usb.claimInterface(this.intf);
  try { await this.usb.selectAlternateInterface(this.intf, 0); } catch (e) { /* 单接口设备可忽略 */ }

  // 读取字符串描述符（含内存布局）
  try { this.strings.manufacturer = await this.getStringDescriptor(this.usb.manufacturerName ? 1 : 0); } catch (e) {}
  try { this.strings.product = await this.getStringDescriptor(this.usb.productName ? 2 : 0); } catch (e) {}
  try { this.strings.serial = await this.getStringDescriptor(this.usb.serialNumber ? 3 : 0); } catch (e) {}
  try { this.strings.layoutRaw = await this.getStringDescriptor(dfuIntf.iInterface); } catch (e) {}
  this.memLayout = parseMemoryLayout(this.strings.layoutRaw || '');
  return this;
};

DfuDevice.prototype.getStatus = async function () {
  var d = await this._ctrlIn(DFU.GETSTATUS, 6);
  var v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { status: v.getUint8(0), pollTimeout: v.getUint32(1, true) & 0xFFFFFF, state: v.getUint8(4) };
};
DfuDevice.prototype.clearStatus = async function () {
  await this._ctrlOut(DFU.CLRSTATUS, new ArrayBuffer(0), 0);
};
DfuDevice.prototype.abort = async function () {
  await this._ctrlOut(DFU.ABORT, new ArrayBuffer(0), 0);
};
/* 发送 ST 扩展命令（DNLOAD wValue=0），并轮询 GETSTATUS 至执行完毕 */
DfuDevice.prototype.specialCommand = async function (bytes, label, timeoutMs) {
  await this._ctrlOut(DFU.DNLOAD, bytes, 0);
  var t0 = Date.now(), st;
  for (;;) {
    st = await this.getStatus();
    if (st.state === DFU.dfuDNLOAD_IDLE || st.state === DFU.dfuUPLOAD_IDLE) {
      if (st.status !== 0)
        throw new DfuError(label + ' 失败: ' + dfuStatusName(st.status), st);
      return st;
    }
    if (st.state === DFU.dfuERROR) {
      var code = st.status;
      await this.clearStatus();
      throw new DfuError(label + ' 失败: ' + dfuStatusName(code), st);
    }
    if (Date.now() - t0 > (timeoutMs || 30000))
      throw new DfuError(label + ' 超时（state=' + dfuStateName(st.state) + '）', st);
    await sleep(Math.min(Math.max(st.pollTimeout, 5), 500));
    this.throwIfCancelled();
  }
};
DfuDevice.prototype.setAddressPointer = function (addr) {
  var b = new Uint8Array(5);
  b[0] = DFU.CMD_SET_ADDRESS;
  b[1] = addr & 0xFF; b[2] = (addr >>> 8) & 0xFF;
  b[3] = (addr >>> 16) & 0xFF; b[4] = (addr >>> 24) & 0xFF;
  return this.specialCommand(b, '设置地址指针 ' + hex(addr), 15000);
};
DfuDevice.prototype.erasePage = function (addr) {
  var b = new Uint8Array(5);
  b[0] = DFU.CMD_ERASE_PAGE;
  b[1] = addr & 0xFF; b[2] = (addr >>> 8) & 0xFF;
  b[3] = (addr >>> 16) & 0xFF; b[4] = (addr >>> 24) & 0xFF;
  return this.specialCommand(b, '擦除页 ' + hex(addr), 60000);
};
DfuDevice.prototype.massErase = function () {
  // F405 等器件上报 100ms 实际需 ~35s，放宽超时
  return this.specialCommand(new Uint8Array([DFU.CMD_ERASE_PAGE]), '整片擦除', 150000);
};
DfuDevice.prototype.readUnprotect = async function () {
  // 设备会立即断开并全片擦除后复位
  try { await this._ctrlOut(DFU.DNLOAD, new Uint8Array([DFU.CMD_READ_UNPROTECT]), 0); } catch (e) { /* 设备可能已断开 */ }
  try { await this.getStatus(); } catch (e) { /* 预期断开 */ }
};

/* 下载一个数据段：先擦除涉及页，再分块写入（wValue 恒为 2，每块前 SET_ADDRESS）
 * noErase=true 时跳过擦除——供「多段整包已统一擦除」的批量写入使用 */
DfuDevice.prototype.downloadElement = async function (addr, data, onProgress, noErase) {
  data = u8(data);
  this.throwIfCancelled();
  var chk = checkWriteRange(this.memLayout, addr, data.length);
  if (!chk.ok) {
    throw new DfuError('目标区间不可写：' + chk.blocked.map(function (b) {
      return hex(b.addr) + '-' + hex(b.end - 1) + '（' + b.label + '）';
    }).join('，') + '；设备可写区为 ' + writableRanges(this.memLayout).map(function (r) {
      return hex(r.addr) + '-' + hex(r.end - 1);
    }).join('，'));
  }
  await this.recoverToIdle(3);   // 上一次操作若留下脏状态，先复位
  if (!noErase) {
    var plan = erasePlan(this.memLayout, addr, data.length);
    if (plan.undeclared.length) {
      this.log('warn', hex(addr) + ' 起 ' + data.length + ' 字节不在设备声明的布局内，' +
        '改按 ' + (minEraseUnit(this.memLayout) || 1024) + 'B 页擦除后写入，设备可能拒绝');
    }
    var pages = plan.pages;
    for (var i = 0; i < pages.length; i++) {
      this.throwIfCancelled();
      this.log('debug', '擦除页 ' + hex(pages[i]));
      await this.erasePage(pages[i]);
      if (onProgress) onProgress(0, data.length, '擦除 ' + (i + 1) + '/' + pages.length);
    }
  }
  var off = 0, blk = 2;
  while (off < data.length) {
    this.throwIfCancelled();
    var cur = addr + off;
    var n = Math.min(this.xferSize, data.length - off);
    /* 标准 DfuSe 语义：一次 SET_ADDRESS 后块号从 2 连续递增。
     * 不能每块都重新 SET_ADDRESS + 块号恒 2——实测该 bootloader 的 DNLOAD
     * 数据块会先擦除「块起始地址」所在页再写，每块重设地址等于把前一块
     * 刚写的页擦掉（多段固件从页中间开写时，还会擦掉同页里别的段的数据）。 */
    if (off === 0) await this.setAddressPointer(cur);
    await this._ctrlOut(DFU.DNLOAD, data.subarray(off, off + n).slice(), blk++);
    var st = await this.getStatus();
    var t0 = Date.now();
    while (st.state !== DFU.dfuDNLOAD_IDLE && st.state !== DFU.dfuERROR &&
           st.state !== DFU.dfuMANIFEST) {
      if (st.state === DFU.dfuERROR) {
        var code = st.status;
        await this.clearStatus();
        throw new DfuError('写入 ' + hex(cur) + ' 失败: ' + dfuStatusName(code), st);
      }
      if (Date.now() - t0 > 30000)
        throw new DfuError('写入 ' + hex(cur) + ' 超时', st);
      await sleep(Math.min(Math.max(st.pollTimeout, 5), 500));
      st = await this.getStatus();
    }
    off += n;
    if (onProgress) onProgress(off, data.length, '写入 ' + hex(cur));
  }
};
/* 统一擦除多个数据段涉及的所有页（去重、排序）。
 * 多段固件（HEX 段间有空洞、ELF 多 PT_LOAD）必须整包擦除后再逐段写：
 * 若每段各自擦除，后段的擦除范围会覆盖先写好的段——典型如 HEX 两段
 * 0x08000400+268 / 0x08000510+50332，第二段擦除会把第一段刚写的 268 字节
 * 抹掉（读回首处不符 @0x08000400）。.bin 是单段所以从不触发，极具迷惑性。 */
DfuDevice.prototype.eraseForSegments = async function (segs, onProgress) {
  var pageSet = {}, i, j;
  for (i = 0; i < segs.length; i++) {
    var plan = erasePlan(this.memLayout, segs[i].addr, segs[i].data.length);
    for (j = 0; j < plan.pages.length; j++) pageSet[plan.pages[j]] = 1;
  }
  var pages = Object.keys(pageSet).map(Number).sort(function (a, b) { return a - b; });
  this.throwIfCancelled();
  await this.recoverToIdle(3);
  for (i = 0; i < pages.length; i++) {
    this.throwIfCancelled();
    this.log('debug', '擦除页 ' + hex(pages[i]));
    await this.erasePage(pages[i]);
    if (onProgress) onProgress(i + 1, pages.length, '擦除 ' + (i + 1) + '/' + pages.length);
  }
  return pages;
};
/* 把状态机拉回 dfuIDLE。不同 bootloader 在 STALL 后停留的状态不同
   （实测某 DfuSe 定制 bootloader 会停在 dfuDNLOAD_IDLE 且 bStatus=0），
   必须同时尝试 ABORT 与 CLRSTATUS 才能可靠复位。 */
DfuDevice.prototype.recoverToIdle = async function (tries) {
  var max = tries || 6, i;
  for (i = 0; i < max; i++) {
    var st = null;
    try { st = await this.getStatus(); } catch (e) { st = null; }
    if (st && st.state === DFU.dfuIDLE && st.status === 0) return true;
    try { await this.abort(); } catch (e) { /* 当前状态可能不允许 ABORT */ }
    try { await this.clearStatus(); } catch (e) { /* 同上 */ }
    await sleep(10);
  }
  var last = null;
  try { last = await this.getStatus(); } catch (e) { last = null; }
  return !!(last && last.state === DFU.dfuIDLE && last.status === 0);
};
/* 连续读回一个内存段：一次 SET_ADDRESS，之后按块号（wValue=2,3,4…）递增读。
   abortAfterSetAddr=true 时在 SET_ADDRESS 后补一个 ABORT —— 部分定制 bootloader
   在 SET_ADDRESS 后会停在 dfuDNLOAD_IDLE，此时不允许发 UPLOAD，必须先回到 dfuIDLE；
   ABORT 会把状态机拉回 dfuIDLE 且不影响已设置的地址指针。 */
DfuDevice.prototype.uploadBurst = async function (addr, length, out, onProgress, abortAfterSetAddr) {
  await this.recoverToIdle(3);
  await this.setAddressPointer(addr);
  if (abortAfterSetAddr) {
    try { await this.abort(); } catch (e) { /* 只为回到 dfuIDLE */ }
  }
  var got = 0, txn = 2, guard = 0;
  while (got < length && guard++ < 100000) {
    this.throwIfCancelled();
    var want = Math.min(this.xferSize, length - got);
    var d = await this._ctrlIn(DFU.UPLOAD, want, txn++);
    var n = Math.min(u8(d).length, want);
    if (n === 0) {
      /* 首块就返回 0 字节：设备可能因块号与其内部 DNLOAD/UPLOAD 状态冲突而拒读
       * （实测刚写完 DNLOAD 立刻 UPLOAD、块号从 2 开始会被拒）。此时必须抛错
       * 让上层降级重试，不能当成「读完了」——否则返回空数组，调用方无法区分。 */
      if (got === 0) throw new DfuError('UPLOAD 首块返回 0 字节（块号 ' + (txn - 1) + '）');
      break;
    }
    out.set(u8(d).subarray(0, n), got);
    got += n;
    if (onProgress) onProgress(got, length, '读出 ' + hex(addr + got));
    if (n < want) break; // 短包表示结束
  }
  try { await this.abort(); } catch (e) { /* 部分设备自动回 idle */ }
  return got;
};
/* 逐块读回（最兼容、最慢）：每块前 SET_ADDRESS + ABORT + UPLOAD */
DfuDevice.prototype.uploadPerBlock = async function (addr, length, out, onProgress) {
  var got = 0;
  while (got < length) {
    this.throwIfCancelled();
    var want = Math.min(this.xferSize, length - got);
    await this.recoverToIdle();
    await this.setAddressPointer(addr + got);
    try { await this.abort(); } catch (e) { /* 指针已生效，ABORT 只为回到 dfuIDLE */ }
    var d = await this._ctrlIn(DFU.UPLOAD, want, 2);
    var n = Math.min(u8(d).length, want);
    if (n === 0) {
      if (got === 0) throw new DfuError('UPLOAD 首块返回 0 字节（' + hex(addr + got) + '）');
      break;
    }
    out.set(u8(d).subarray(0, n), got);
    got += n;
    if (onProgress) onProgress(got, length, '读出 ' + hex(addr + got));
    if (n < want) break; // 短包表示结束
  }
  try { await this.abort(); } catch (e) { /* 忽略 */ }
  return got;
};
/* 上传（读回）一个内存段。三级渐进降级：
   ① 标准 dfu-util 序列（一次 SET_ADDRESS + 递增块号）
   ② 同 ①，但 SET_ADDRESS 后补一个 ABORT（兼容要求 UPLOAD 前回 dfuIDLE 的 bootloader）
   ③ 逐块 SET_ADDRESS + ABORT（最兼容，速率约为 ① 的 1/4） */
DfuDevice.prototype.uploadElement = async function (addr, length, onProgress) {
  this.throwIfCancelled();
  var out = new Uint8Array(length);
  var prog = { got: 0 };
  var cb = function (g, t, m) { prog.got = g; if (onProgress) onProgress(g, t, m); };
  var plan = [
    { abort: false, perBlock: false, label: '标准序列' },
    { abort: true, perBlock: false, label: 'SET_ADDRESS 后补 ABORT' },
    { abort: true, perBlock: true, label: '逐块读回' }
  ];
  for (var i = 0; i < plan.length; i++) {
    prog.got = 0;
    try {
      if (plan[i].perBlock) await this.uploadPerBlock(addr, length, out, cb);
      else await this.uploadBurst(addr, length, out, cb, plan[i].abort);
    } catch (e) {
      if (prog.got > 0 || !(e instanceof DfuError)) throw e;
      if (i === plan.length - 1) throw e;
      this.log('warn', '读回序列「' + plan[i].label + '」被设备拒绝，改用「' + plan[i + 1].label + '」');
      continue;
    }
    return out.subarray(0, prog.got);
  }
  return out.subarray(0, 0);
};
/* 读回比对 */
DfuDevice.prototype.verifyElement = async function (addr, expected, onProgress) {
  expected = u8(expected);
  var got = await this.uploadElement(addr, expected.length, onProgress);
  if (got.length < expected.length)
    throw new DfuError('校验失败: 只读回 ' + got.length + '/' + expected.length + ' 字节');
  for (var i = 0; i < expected.length; i++) {
    if (got[i] !== expected[i])
      throw new DfuError('校验失败: 首处不匹配 @ ' + hex(addr + i) +
        '（期望 ' + hex(expected[i], 2) + '，实际 ' + hex(got[i], 2) + '）');
  }
  return true;
};
/* 离开 DFU 模式（零长度 DNLOAD, wValue=2），设备随后复位跳转到用户代码 */
DfuDevice.prototype.leaveDfu = async function () {
  try {
    await this._ctrlOut(DFU.DNLOAD, new ArrayBuffer(0), 2);
    var t0 = Date.now(), st;
    for (;;) {
      st = await this.getStatus();
      if (st.state === DFU.dfuMANIFEST_SYNC || st.state === DFU.dfuMANIFEST ||
          st.state === DFU.dfuMANIFEST_WAIT_RESET) return st;
      if (st.state === DFU.dfuDNLOAD_IDLE) return st;
      if (st.state === DFU.dfuERROR) {
        await this.clearStatus();
        throw new DfuError('跳转失败: ' + dfuStatusName(st.status), st);
      }
      if (Date.now() - t0 > 10000) return st;
      await sleep(50);
    }
  } catch (e) {
    // 设备已断开 = 跳转成功
    this.log('debug', 'leaveDfu: 设备已断开（' + e.message + '）');
    return null;
  }
};

/* =====================================================================
 * 以下为 UI 层（仅在浏览器环境执行）
 * ===================================================================== */
var state = {
  dev: null,
  fw: null,          // { name, size, segments:[{addr,data}], baseAddr }
  fwFile: null,      // 原始 File 对象（云端上传需要原始字节）
  busy: false,
  cancel: false,
  t0: 0,
  bytesDone: 0,
  bytesTotal: 0,
  lastError: '',
  addrDirty: false    // 用户手动改过 .bin 起始地址 -> 不再自动按描述符纠正
};

if (typeof document !== 'undefined' && typeof navigator !== 'undefined' &&
    document.getElementById && $('btn-connect')) {
  initUI();
}

function initUI() {
  /* ---------- 日志 ---------- */
  var logEl = $('log');
  var logCount = 0;
  function appendLog(level, msg) {
    var line = document.createElement('div');
    var t = new Date();
    var ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' +
      ('0' + t.getSeconds()).slice(-2);
    var spanT = document.createElement('span');
    spanT.className = 't'; spanT.textContent = '[' + ts + '] ';
    var spanL = document.createElement('span');
    spanL.className = 'lv-' + level; spanL.textContent = msg;
    line.appendChild(spanT); line.appendChild(spanL);
    logEl.appendChild(line);
    if (++logCount > 600) { logEl.removeChild(logEl.firstChild); logCount--; }
    logEl.scrollTop = logEl.scrollHeight;
  }
  window.appendLog = appendLog;
  function log(level, msg) { appendLog(level, msg); }

  /* ---------- 模态确认框 ---------- */
  var modalMask = $('modal-mask');
  function confirmDialog(title, bodyHtml, okLabel) {
    return new Promise(function (resolve) {
      $('modal-title').textContent = title;
      $('modal-body').innerHTML = bodyHtml;
      $('modal-ok').textContent = okLabel || '确认';
      modalMask.classList.add('show');
      function done(v) {
        modalMask.classList.remove('show');
        $('modal-ok').onclick = null; $('modal-cancel').onclick = null;
        resolve(v);
      }
      $('modal-ok').onclick = function () { done(true); };
      $('modal-cancel').onclick = function () { done(false); };
    });
  }

  /* ---------- 连接状态 ---------- */
  function setConn(status, text) {
    var pill = $('conn-pill');
    pill.className = 'pill' + (status ? ' ' + status : '');
    $('conn-text').textContent = text;
    $('dev-status-tag').textContent = text;
  }
  function setButtons() {
    var has = !!state.dev;
    ['btn-erase', 'btn-write', 'btn-verify', 'btn-readout', 'btn-jump',
      'btn-masserase', 'btn-unprotect'].forEach(function (id) { $(id).disabled = !has || state.busy; });
    $('btn-flash').disabled = !has || !state.fw || state.busy;
    $('btn-connect').textContent = has ? '断开连接' : '连接设备';
  }

  /* ---------- 浏览器检查 ---------- */
  if (!navigator.usb) {
    $('browser-warn').style.display = 'block';
    $('btn-connect').disabled = true;
    log('error', '当前浏览器不支持 WebUSB，请使用 Chrome / Edge');
  }

  /* ---------- 连接 ---------- */
  $('btn-connect').onclick = async function () {
    if (state.dev) { await disconnect(); return; }
    try {
      var dev = await navigator.usb.requestDevice({ filters: [{ classCode: 0xFE }] });
      log('info', '已选择设备: ' + (dev.productName || '') + ' (' + hex(dev.vendorId, 4) + ':' + hex(dev.productId, 4) + ')');
      await connectDevice(dev);
    } catch (e) {
      if (e && e.name === 'NotFoundError') log('info', '未选择设备');
      else log('error', '连接失败: ' + (e.message || e));
    }
  };
  async function connectDevice(usbDev) {
    var dfu = new DfuDevice(usbDev, log);
    await dfu.open();
    state.dev = dfu;
    setConn('on', '已连接');
    log('success', 'DFU 设备已连接，传输块大小 ' + dfu.xferSize + ' 字节');
    await refreshInfo();
    setButtons();
  }
  async function disconnect() {
    if (state.dev) {
      try { await state.dev.usb.close(); } catch (e) {}
      state.dev = null;
    }
    setConn('', '未连接');
    log('info', '已断开连接');
    setButtons();
  }
  navigator.usb.addEventListener('disconnect', function (e) {
    if (state.dev && state.dev.usb === e.device) {
      state.dev = null;
      setConn('err', '设备已断开');
      log('warn', 'USB 设备已断开');
      setButtons();
    }
  });

  /* ---------- 设备信息 ---------- */
  async function refreshInfo() {
    var d = state.dev;
    var rows = [
      ['制造商', d.strings.manufacturer || '—'],
      ['产品', d.strings.product || d.usb.productName || '—'],
      ['序列号', d.strings.serial || d.usb.serialNumber || '—'],
      ['VID / PID', hex(d.usb.vendorId, 4) + ' / ' + hex(d.usb.productId, 4)],
      ['DFU 版本', '0x' + d.dfuVersion.toString(16)],
      ['传输块大小', d.xferSize + ' 字节']
    ];
    var html = '';
    for (var i = 0; i < rows.length; i++)
      html += '<tr><td>' + esc(rows[i][0]) + '</td><td class="mono">' + esc(String(rows[i][1])) + '</td></tr>';
    $('dev-info').innerHTML = html;

    var lt = $('layout-table');
    if (d.memLayout) {
      var lh = '<tr><th>区域</th><th>基地址</th><th>页数 × 大小</th><th>范围</th><th>权限</th></tr>';
      var permTxt = [], roGroups = [];
      for (var s = 0; s < d.memLayout.length; s++) {
        var seg = d.memLayout[s];
        if (!seg.pages.length) {
          lh += '<tr><td>' + esc(seg.name) + '</td><td>' + hex(seg.base) + '</td><td>—</td><td>' +
            hex(seg.base) + ' - ' + hex(seg.end - 1) + '</td><td><span class="perm wo">未声明</span></td></tr>';
          continue;
        }
        for (var g = 0; g < seg.pages.length; g++) {
          var pg = seg.pages[g];
          var start = pg.addr, stop = pg.addr + pg.count * pg.size;
          var label = accessLabel(pg.access);
          var cls = accessProgrammable(pg.access) ? 'rw' : (pg.access.read ? 'ro' : 'wo');
          lh += '<tr><td>' + esc(seg.name) + '</td><td>' + hex(start) + '</td><td>' +
            pg.count + ' × ' + fmtBytes(pg.size) + '</td><td>' + hex(start) + ' - ' + hex(stop - 1) +
            '</td><td><span class="perm ' + cls + '">' + esc(label) + '</span></td></tr>';
          permTxt.push(hex(start) + '+' + fmtBytes(stop - start) + ' ' + label);
          if (!accessProgrammable(pg.access))
            roGroups.push({ addr: start, end: stop, name: seg.name, label: label });
        }
      }
      var wrs = writableRanges(d.memLayout);
      if (wrs.length) {
        lh += '<tr><td colspan="5" style="color:var(--text-2);background:#fafbfc">可擦写范围：' +
          '<span class="mono">' + wrs.map(function (r) {
            return hex(r.addr) + ' - ' + hex(r.end - 1);
          }).join('，') + '</span></td></tr>';
      }
      lt.innerHTML = lh;
      $('layout-details').style.display = 'block';
      log('info', '内存布局: ' + permTxt.join(' | '));
      if (roGroups.length) {
        log('warn', '设备把 ' + roGroups.map(function (r) {
          return hex(r.addr) + '-' + hex(r.end - 1) + '（' + r.label + (r.name ? ' · ' + r.name : '') + '）';
        }).join('，') + ' 报告为不可写，这些页不会参与擦除，写入会被拒绝');
      }
    } else {
      $('layout-details').style.display = 'none';
      log('warn', '设备未提供内存布局字符串，将按 1KB 页擦除推断（失败时可改用整片擦除）');
    }
    if (applyDefaultAddr())
      if (state.fwFile && /\.bin$/i.test(state.fwFile.name)) loadFile(state.fwFile);
    refreshTargetCheck();
  }

  /* .bin 没有自带地址 -> 默认取设备描述符里第一个可写页组的起点
   * hex/elf/dfu 的地址来自文件本身，不覆盖（用户可在地址框里手动平移） */
  function applyDefaultAddr(silent) {
    if (state.addrDirty || !state.dev || !state.dev.memLayout) return false;
    if (state.fw && !/\.bin$/i.test(state.fw.name)) return false;
    var wrs = writableRanges(state.dev.memLayout);
    if (!wrs.length) return false;
    var cur = parseAddr($('fw-addr').value);
    if (cur !== null && cur !== undefined) {
      var r = checkWriteRange(state.dev.memLayout, cur, 1);
      if (r.checked && r.ok && !(r.unknown && r.unknown.length)) return false;  // 已在可写页内
    }
    $('fw-addr').value = hex(wrs[0].addr);
    var src = $('addr-src');
    if (src) src.textContent = '← 来自设备描述符';
    if (!silent) log('info', '起始地址默认取设备描述符的可写区起点 ' + hex(wrs[0].addr));
    return true;
  }

  /* 选中固件后/连上设备后，检查目标地址是否落在设备声明的可写区内 */
  function refreshTargetCheck() {
    var w = $('fw-warn');
    if (!state.fw || !state.dev || !state.dev.memLayout) {
      w.style.display = 'none';
      return;
    }
    var fw = state.fw, blocked = [], unknown = [];
    for (var i = 0; i < fw.segments.length; i++) {
      var r = checkWriteRange(state.dev.memLayout, fw.segments[i].addr, fw.segments[i].data.length);
      blocked = blocked.concat(r.blocked);
      unknown = unknown.concat(r.unknown || []);
    }
    var wrs = writableRanges(state.dev.memLayout);
    var rwTxt = wrs.map(function (r) { return hex(r.addr) + ' - ' + hex(r.end - 1); }).join('，或 ');
    if (blocked.length) {
      w.className = 'hint';
      w.style.display = 'block';
      w.style.color = 'var(--danger)';
      w.innerHTML = '⚠ 目标区间含 <b>' + blocked.map(function (b) {
        return hex(b.addr) + ' - ' + hex(b.end - 1) + '（' + esc(b.label) + '）';
      }).join('，') + '</b>，设备会拒绝擦/写。' + (rwTxt ? '请把地址改到可写区：<span class="mono">' + rwTxt + '</span>' : '');
      appendAddrFix(w, wrs);
      return;
    }
    if (unknown.length) {
      w.className = 'hint warn';
      w.style.display = 'block';
      w.style.color = 'var(--warn)';
      w.textContent = '⚠ ' + unknown.map(function (u) {
        return hex(u[0]) + ' - ' + hex(u[1] - 1);
      }).join('，') + ' 不在设备声明的内存布局内，写入可能失败。' + (rwTxt ? '可写区：' + rwTxt : '');
      appendAddrFix(w, wrs);
      return;
    }
    w.className = 'hint ok';
    w.style.display = 'block';
    w.style.color = 'var(--ok)';
    w.textContent = '✓ 目标区间在设备声明的可写区内';
  }
  /* .bin 可一键把起始地址改到可写区起点 */
  function appendAddrFix(el, wrs) {
    if (!wrs.length || $('addr-field').style.display === 'none') return;
    var btn = document.createElement('button');
    btn.textContent = '用 ' + hex(wrs[0].addr);
    btn.style.cssText = 'font-size:11px;padding:2px 8px;margin-left:6px';
    btn.onclick = function () {
      $('fw-addr').value = hex(wrs[0].addr);
      log('info', '起始地址改为可写区起点 ' + hex(wrs[0].addr));
      applyAddrChange();
    };
    el.appendChild(document.createTextNode(' '));
    el.appendChild(btn);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 固件加载 ---------- */
  var dz = $('dropzone'), fi = $('file-input');
  dz.onclick = function () { fi.click(); };
  dz.ondragover = function (e) { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = function () { dz.classList.remove('over'); };
  dz.ondrop = function (e) {
    e.preventDefault(); dz.classList.remove('over');
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  };
  fi.onchange = function () { if (fi.files.length) loadFile(fi.files[0]); };
  /* .bin 的起始地址是用户填的；hex/elf/dfu 的地址来自文件。
   * 改地址时统一按「整体平移」处理：所有数据段一起偏移，保持相对间距不变。 */
  function applyAddrChange() {
    if (state.busy || !state.fw) { refreshTargetCheck(); return; }
    var want = parseAddr($('fw-addr').value);
    if (want === null) {
      $('fw-warn').className = 'hint warn';
      $('fw-warn').style.color = 'var(--danger)';
      $('fw-warn').textContent = '起始地址格式错误（示例：0x08001000）';
      $('fw-warn').style.display = 'block';
      $('fw-addr').value = hex(state.fw.baseAddr);
      return;
    }
    state.addrDirty = true;   // 手动指定即视为用户意图，不再自动纠正
    var src = $('addr-src');
    if (src) src.textContent = '';
    var delta = want - state.fw.baseAddr;
    if (delta !== 0) {
      for (var i = 0; i < state.fw.segments.length; i++) state.fw.segments[i].addr += delta;
      state.fw.baseAddr = want;
      log('info', '镜像整体平移 ' + (delta > 0 ? '+' : '') + hex(delta) +
        '，起始地址变为 ' + hex(want) + '（段内绝对地址未改写）');
      renderFwInfo();
    }
    refreshTargetCheck();
  }
  $('fw-addr').onchange = applyAddrChange;
  $('fw-addr').oninput = function () { state.addrDirty = true; };

  async function loadFile(file) {
    try {
      var buf = await file.arrayBuffer();
      var name = file.name, segs = null, warn = '';
      if (/\.hex$/i.test(name)) {
        segs = parseIntelHex(new TextDecoder().decode(buf));
        if (!segs.length) throw new Error('HEX 文件中没有数据段');
      } else if (/\.dfu$/i.test(name)) {
        segs = parseDfuSe(buf);
      } else if (/\.elf$/i.test(name) || looksLikeElf(buf)) {
        segs = parseElf(buf);
      } else {
        var addr = parseAddr($('fw-addr').value);
        if (addr === null) throw new Error('起始地址格式错误');
        /* 地址不在设备声明的可写页内（典型：0x08000000 而描述符从 0x08001000 起），
         * 按描述符的可写区起点纠正——仅当用户没手动改过地址 */
        if (state.dev && state.dev.memLayout) {
          var chk = checkWriteRange(state.dev.memLayout, addr, buf.byteLength);
          if (!chk.ok || (chk.unknown && chk.unknown.length)) {
            var oldAddr = addr;
            if (applyDefaultAddr(true)) {
              addr = parseAddr($('fw-addr').value);
              log('info', '起始地址 ' + hex(oldAddr) + ' 不在可写区，已按设备描述符改为 ' + hex(addr));
            }
          }
        }
        segs = [{ addr: addr, data: new Uint8Array(buf) }];
      }
      var total = 0, crcParts = [];
      for (var i = 0; i < segs.length; i++) { total += segs[i].data.length; crcParts.push(segs[i].data); }
      var all = new Uint8Array(total), o = 0;
      for (var j = 0; j < segs.length; j++) { all.set(segs[j].data, o); o += segs[j].data.length; }
      state.fw = { name: name, size: total, segments: segs, crc: crc32(all), baseAddr: segs[0].addr };
      state.fwFile = file;

      $('fw-name').textContent = name;
      renderFwInfo();
      $('file-info').style.display = 'block';
      $('addr-field').style.display = 'flex';   // 所有格式都能改/看起始地址
      refreshTargetCheck();
      if (segs.ptLoad && segs.ptLoad.length) {
        log('debug', 'ELF 程序头: ' + segs.ptLoad.map(function (p) {
          return '#' + p.idx + ' VMA=' + hex(p.vaddr) + ' LMA=' + hex(p.paddr) +
                 ' filesz=' + p.filesz + ' off=' + p.offset;
        }).join(' | '));
      }
      if (segs.trimmedZeros)
        log('info', '跳过段首 ' + segs.trimmedZeros + ' 字节全零填充，起始地址按 ' +
          hex(segs[0].addr) + ' 起算（与 objcopy -O ihex 一致）');
      log('success', '已加载 ' + name + '（' + fmtBytes(total) + '，' + segs.length + ' 段）');
      setButtons();
    } catch (e) {
      log('error', '文件解析失败: ' + e.message);
      state.fw = null;
      state.fwFile = null;
      $('fw-warn').className = 'hint warn';
      $('fw-warn').style.color = '';
      $('fw-warn').textContent = '解析失败: ' + e.message;
      $('fw-warn').style.display = 'block';
      setButtons();
    }
  }
  function renderFwInfo() {
    if (!state.fw) return;
    var segs = state.fw.segments;
    var info = '<tr><td>大小</td><td>' + fmtBytes(state.fw.size) + '（' + state.fw.size.toLocaleString() + ' 字节）</td></tr>' +
      '<tr><td>CRC32</td><td class="mono">' + hex(state.fw.crc) + '</td></tr>' +
      '<tr><td>数据段</td><td>' + segs.length + ' 段：' + segs.map(function (s) {
        return hex(s.addr) + '+' + fmtBytes(s.data.length);
      }).join('，') + '</td></tr>' +
      (segs.entryPoint ? '<tr><td>入口点</td><td class="mono">' + hex(segs.entryPoint) + '</td></tr>' : '') +
      '<tr><td>地址范围</td><td class="mono">' + hex(segs[0].addr) + ' - ' +
        hex(segs[segs.length - 1].addr + segs[segs.length - 1].data.length - 1) + '</td></tr>';
    $('fw-info').innerHTML = info;
    $('fw-addr').value = hex(state.fw.baseAddr);
  }
  function parseAddr(s) {
    s = String(s).trim();
    if (!/^(0x[0-9a-fA-F]+|[0-9a-fA-F]+)$/.test(s)) return null;
    var v = parseInt(s, 16);
    return isNaN(v) ? null : v;
  }

  /* ---------- 进度 ---------- */
  function setProgress(done, total, stage) {
    var pct = total > 0 ? Math.min(100, done / total * 100) : 0;
    $('bar').style.width = pct.toFixed(1) + '%';
    $('bar').className = 'bar-inner';
    $('prog-stage').textContent = stage || '';
    var el = Date.now() - state.t0;
    var speed = el > 300 ? done / (el / 1000) : 0;
    var remain = speed > 0 ? (total - done) / speed : Infinity;
    $('prog-detail').textContent = fmtBytes(done) + ' / ' + fmtBytes(total) +
      (done > 0 ? ' · ' + fmtSpeed(speed) + ' · 剩余 ' + fmtEta(remain) : '');
  }
  function setBusy(b, stage) {
    state.busy = b;
    $('btn-cancel').style.display = b ? 'inline-block' : 'none';
    if (b) { state.t0 = Date.now(); setProgress(0, 0, stage || '进行中…'); }
    else if (stage === 'done') { $('bar').className = 'bar-inner ok'; $('prog-stage').textContent = '完成'; }
    setButtons();
  }

  /* ---------- 取消 ---------- */
  $('btn-cancel').onclick = function () {
    state.cancel = true;
    if (state.dev) state.dev.cancelFlag = true;
    log('warn', '正在取消操作…');
  };

  /* ---------- 操作执行 ---------- */
  function guard() {
    if (!state.dev) throw new DfuError('设备未连接');
    if (state.busy) throw new DfuError('正在执行其他操作');
  }
  async function runOp(fn) {
    guard();
    state.cancel = false;
    state.lastError = '';
    state.dev.cancelFlag = false;
    setBusy(true);
    try {
      await fn();
      setBusy(false, 'done');
      return true;
    } catch (e) {
      if (state.dev) { try { await state.dev.abort(); } catch (x) {} }
      setBusy(false);
      state.lastError = e.message || String(e);
      $('bar').className = 'bar-inner err';
      $('prog-stage').textContent = '失败: ' + e.message;
      log('error', e.message);
      return false;
    }
  }

  /* 写操作前的权限预检：目标落在只读区直接拦掉，不让设备去 STALL */
  async function precheckWritable(fw) {
    var layout = state.dev ? state.dev.memLayout : null;
    if (!layout) return true;
    var blocked = [], unknown = [];
    for (var i = 0; i < fw.segments.length; i++) {
      var r = checkWriteRange(layout, fw.segments[i].addr, fw.segments[i].data.length);
      blocked = blocked.concat(r.blocked);
      unknown = unknown.concat(r.unknown || []);
    }
    var rwTxt = writableRanges(layout).map(function (r) {
      return hex(r.addr) + ' - ' + hex(r.end - 1);
    }).join('，或 ');
    if (blocked.length) {
      var msg = '目标区间 ' + blocked.map(function (b) {
        return hex(b.addr) + ' - ' + hex(b.end - 1) + '（' + b.label + '）';
      }).join('，') + ' 被设备报告为不可写' + (rwTxt ? '；可写区为 ' + rwTxt : '');
      log('error', msg);
      $('bar').className = 'bar-inner err';
      $('prog-stage').textContent = '未执行：目标区间只读';
      await confirmDialog('无法写入只读区',
        '<span class="danger-text">' + esc(msg) + '</span><br>' +
        '设备在接口描述符里声明了这段内存只读（通常是 bootloader 自保护区），擦除/写入会被拒绝。' +
        '请修改固件起始地址或换用可写区的固件。', '知道了');
      return false;
    }
    if (unknown.length) {
      var uTxt = unknown.map(function (u) { return hex(u[0]) + ' - ' + hex(u[1] - 1); }).join('，');
      var go = await confirmDialog('目标地址未在布局中声明',
        '以下地址不在设备声明的内存布局内：<br><span class="mono">' + esc(uTxt) + '</span><br>' +
        '工具会先按 ' + (minEraseUnit(layout) || 1024) + 'B 页擦除这些区域再写入，' +
        '但设备仍可能拒绝（它只承诺了自己报告过的区段）。' +
        (rwTxt ? '可写区为 <span class="mono">' + esc(rwTxt) + '</span>。' : '') +
        '<br>仍要继续吗？', '继续');
      if (!go) return false;
    }
    return true;
  }

  $('btn-flash').onclick = async function () {
    if (!state.fw) return;
    var fw = state.fw;
    if (!(await precheckWritable(fw))) return;
    var rangeTxt = fw.segments.map(function (s) {
      return hex(s.addr) + ' - ' + hex(s.addr + s.data.length - 1);
    }).join('<br>');
    var ok = await confirmDialog('确认升级',
      '即将对以下地址执行 <b>擦除并写入</b>：<br><span class="mono">' + rangeTxt + '</span><br>' +
      '固件大小 <b>' + fmtBytes(fw.size) + '</b>，CRC32 <b class="mono">' + hex(fw.crc) + '</b>' +
      ($('chk-verify').checked ? '<br>烧写后将自动校验。' : '') +
      ($('chk-jump').checked ? '<br>完成后设备将跳转到用户代码运行。' : ''),
      '开始升级');
    if (!ok) return;

    var flashT0 = Date.now();
    var flashOk = await runOp(async function () {
      /* 小间隙段合并成一整段：DNLOAD 数据块会擦除块起始所在页，段从页中间
       * 开写会擦掉同页已有数据（HEX/ELF 多段常见，.bin 单段从不触发） */
      var segs = mergeSegments(fw.segments);
      var total = segs.reduce(function (a, s) { return a + s.data.length; }, 0);
      /* 整包统一擦除后再逐段写，避免后段擦除覆盖先写好的段 */
      var pages = await state.dev.eraseForSegments(segs, function (done, tot, stage) {
        setProgress(done, tot, stage);
      });
      log('info', '已擦除 ' + pages.length + ' 页，开始写入…');
      var base = 0;
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        log('info', '[' + (i + 1) + '/' + segs.length + '] 写入 ' + hex(seg.addr) +
          '（' + fmtBytes(seg.data.length) + '）');
        await state.dev.downloadElement(seg.addr, seg.data, function (done, segTotal, stage) {
          setProgress(base + done, total, stage);
        }, true);
        base += seg.data.length;
        setProgress(base, total, '写入完成');
      }
      if ($('chk-verify').checked) {
        log('info', '开始校验（读回比对）…');
        base = 0;
        for (var v = 0; v < fw.segments.length; v++) {
          var sg = fw.segments[v];
          await state.dev.verifyElement(sg.addr, sg.data, function (done, segTotal, stage) {
            setProgress(base + done, total, stage);
          });
          base += sg.data.length;
        }
        log('success', '校验通过，Flash 内容与固件一致');
      }
      if ($('chk-jump').checked) {
        log('info', '发送跳转指令，设备即将复位运行用户代码…');
        await state.dev.leaveDfu();
        log('success', '升级完成，设备已跳转到用户代码');
      } else {
        log('success', '升级完成（未跳转，设备仍停留在 DFU 模式）');
      }
    });

    // 云服务：把本次升级结果同步到云端（未登录时静默跳过）
    if (window.CloudApi && window.CloudApi.afterFlash) {
      window.CloudApi.afterFlash({
        ok: flashOk,
        fw: fw,
        durationMs: Date.now() - flashT0,
        verify: $('chk-verify').checked,
        jump: $('chk-jump').checked,
        error: state.lastError
      });
    }
  };

  $('btn-erase').onclick = async function () {
    if (!state.fw) return;
    var fw = state.fw;
    var pages = [], undeclared = [];
    for (var i = 0; i < fw.segments.length; i++) {
      var plan = erasePlan(state.dev.memLayout, fw.segments[i].addr, fw.segments[i].data.length);
      pages = pages.concat(plan.pages);
      undeclared = undeclared.concat(plan.undeclared);
    }
    if (!pages.length) {
      log('error', '目标区间内没有可擦除页（设备报告为只读，或不在布局内）');
      await confirmDialog('无可擦除页',
        '设备报告的布局里，目标区间没有任何可擦除页（只读或未声明）。' +
        (writableRanges(state.dev.memLayout).length ? '<br>可擦写区：<span class="mono">' +
          writableRanges(state.dev.memLayout).map(function (r) {
            return hex(r.addr) + ' - ' + hex(r.end - 1);
          }).join('，') + '</span>' : ''), '知道了');
      return;
    }
    if (undeclared.length) {
      var goU = await confirmDialog('目标区间未在布局中声明',
        undeclared.map(function (u) { return hex(u[0]) + ' - ' + hex(u[1] - 1); }).join('，') +
        ' 不在设备声明的布局内，将按 ' + (minEraseUnit(state.dev.memLayout) || 1024) +
        'B 页擦除（共 ' + pages.length + ' 页）。<br>' +
        '<span class="danger-text">这些区域设备没报告，擦除可能影响未声明内容。</span>', '仍要擦除');
      if (!goU) return;
    }
    var ok = await confirmDialog('确认擦除',
      '即将擦除 <b>' + pages.length + '</b> 页 flash（覆盖 ' + rangeTxtOf(fw) + '）。<br>' +
      '<span class="danger-text">该操作不可恢复。</span>', '确认擦除');
    if (!ok) return;
    await runOp(async function () {
      for (var j = 0; j < pages.length; j++) {
        await state.dev.erasePage(pages[j]);
        setProgress(j + 1, pages.length, '擦除页 ' + hex(pages[j]));
      }
      log('success', '已擦除 ' + pages.length + ' 页');
    });
  };
  function rangeTxtOf(fw) {
    return fw.segments.map(function (s) {
      return hex(s.addr) + ' - ' + hex(s.addr + s.data.length - 1);
    }).join('，');
  }

  $('btn-write').onclick = async function () {
    if (!state.fw) return;
    if (!(await precheckWritable(state.fw))) return;
    await runOp(async function () {
      var fw = state.fw;
      /* 小间隙段合并成一整段，避免从页中间开写擦掉同页已有数据 */
      var segs = mergeSegments(fw.segments);
      var total = segs.reduce(function (a, s) { return a + s.data.length; }, 0), base = 0;
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        log('info', '写入 ' + hex(seg.addr) + '（' + fmtBytes(seg.data.length) + '，假定已擦除）');
        await state.dev.downloadElement(seg.addr, seg.data, function (done, segTotal, stage) {
          setProgress(base + done, total, stage);
        }, true);
        base += seg.data.length;
      }
      log('success', '写入完成');
    });
  };

  $('btn-verify').onclick = async function () {
    if (!state.fw) return;
    await runOp(async function () {
      var fw = state.fw;
      var total = fw.segments.reduce(function (a, s) { return a + s.data.length; }, 0), base = 0;
      for (var i = 0; i < fw.segments.length; i++) {
        var seg = fw.segments[i];
        log('info', '校验 ' + hex(seg.addr) + '（' + fmtBytes(seg.data.length) + '）');
        await state.dev.verifyElement(seg.addr, seg.data, function (done, segTotal, stage) {
          setProgress(base + done, total, stage);
        });
        base += seg.data.length;
      }
      log('success', '校验通过，Flash 内容与固件一致');
    });
  };

  $('btn-readout').onclick = async function () {
    var addr = parseAddr(prompt('读出起始地址（十六进制）:', '0x08000000') || '');
    if (addr === null) return;
    var lenStr = prompt('读出长度（字节，十进制）:', '1024');
    var len = parseInt(lenStr, 10);
    if (!len || len <= 0 || len > 16 * 1024 * 1024) return;
    await runOp(async function () {
      log('info', '读出 ' + hex(addr) + ' 起 ' + fmtBytes(len) + '…');
      var data = await state.dev.uploadElement(addr, len, function (done, tot, stage) {
        setProgress(done, tot, stage);
      });
      var blob = new Blob([data], { type: 'application/octet-stream' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'dfu_readout_' + hex(addr) + '_' + data.length + '.bin';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      log('success', '已读出 ' + data.length + ' 字节并保存');
    });
  };

  $('btn-jump').onclick = async function () {
    var ok = await confirmDialog('跳转运行',
      '将发送零长度跳转指令，设备随即<b>复位并运行用户代码</b>，退出 DFU 模式。', '跳转');
    if (!ok) return;
    await runOp(async function () {
      await state.dev.leaveDfu();
      log('success', '设备已跳转到用户代码');
    });
  };

  $('btn-masserase').onclick = async function () {
    var ok = await confirmDialog('⚠ 整片擦除',
      '将对整片内部 flash 执行 <b>mass erase（0x41）</b>。<br>' +
      '<span class="danger-text">芯片内所有数据（含可能驻留的 bootloader）都会被擦除，且不可恢复！</span><br>' +
      '部分型号（如 STM32F405）此操作需要约 35 秒。', '我确认，执行整片擦除');
    if (!ok) return;
    await runOp(async function () {
      log('warn', '执行整片擦除，请耐心等待…');
      await state.dev.massErase();
      log('success', '整片擦除完成');
    });
  };

  $('btn-unprotect').onclick = async function () {
    var ok = await confirmDialog('⚠ 解除读保护',
      '将发送 <b>Read Unprotect（0x92）</b>。<br>' +
      '<span class="danger-text">设备会立即断开、全片擦除并自动复位；若 bootloader 在 flash 中，设备将变砖，需重新烧写！</span><br>' +
      '仅当你明确知道自己要解选项字节读保护时才继续。', '我确认，执行解除');
    if (!ok) return;
    await runOp(async function () {
      log('warn', '执行解除读保护，设备即将断开并擦除…');
      await state.dev.readUnprotect();
      log('success', '指令已发送，等待设备重新枚举…');
      var deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await sleep(500);
        var devs = await navigator.usb.getDevices();
        if (devs.length) { log('success', '设备已重新枚举'); break; }
      }
    });
  };

  $('btn-clear-log').onclick = function () { logEl.innerHTML = ''; logCount = 0; };

  log('info', '工具已就绪。连接 DFU 设备并加载固件后即可升级。');
  setButtons();

  /* ---------- 自动化测试接口（供 CDP 测试脚本驱动，不影响正常使用） ---------- */
  window.__dfuTest = {
    connect: async function () {
      if (!state.dev) {
        var devs = await navigator.usb.getDevices();
        if (!devs.length) throw new Error('no permitted device');
        await connectDevice(devs[0]);
      }
      return true;
    },
    info: async function () {
      await this.connect();
      var d = state.dev;
      return {
        vid: d.usb.vendorId, pid: d.usb.productId,
        serial: d.strings.serial, manufacturer: d.strings.manufacturer,
        product: d.strings.product, xferSize: d.xferSize, dfuVersion: d.dfuVersion,
        layoutRaw: d.strings.layoutRaw || '', layout: d.memLayout
      };
    },
    getStatus: async function () { await this.connect(); return await state.dev.getStatus(); },
    erasePage: async function (addr) { await this.connect(); return await state.dev.erasePage(addr); },
    download: async function (addr, b64) {
      await this.connect();
      await state.dev.downloadElement(addr, b64ToU8(b64), function (d, t) {
        window.__lastProgress = { done: d, total: t };
      });
      return true;
    },
    upload: async function (addr, len) {
      await this.connect();
      var data = await state.dev.uploadElement(addr, len, function (d, t) {
        window.__lastProgress = { done: d, total: t };
      });
      return u8ToB64(data);
    },
    leave: async function () { await this.connect(); await state.dev.leaveDfu(); return true; },
    parseHex: function (text) { return parseIntelHex(text); },
    parseLayout: function (s) { return parseMemoryLayout(s); },
    pagesToErase: function (layout, addr, len) { return pagesToErase(layout, addr, len); },
    erasePlan: function (addr, len) {
      return erasePlan(state.dev ? state.dev.memLayout : null, addr, len);
    },
    minEraseUnit: function () { return minEraseUnit(state.dev ? state.dev.memLayout : null); },
    shiftFw: function (newAddr) {   // 供测试驱动地址框
      $('fw-addr').value = typeof newAddr === 'string' ? newAddr : hex(newAddr);
      applyAddrChange();
      return state.fw ? state.fw.segments.map(function (s) { return s.addr; }) : [];
    },
    checkWrite: function (addr, len) {
      return checkWriteRange(state.dev ? state.dev.memLayout : null, addr, len);
    },
    writable: function () { return writableRanges(state.dev ? state.dev.memLayout : null); }
  };
  function u8ToB64(u) {
    var s = '', CHUNK = 0x8000;
    for (var i = 0; i < u.length; i += CHUNK)
      s += String.fromCharCode.apply(null, u.subarray(i, i + CHUNK));
    return btoa(s);
  }
  function b64ToU8(b) {
    var s = atob(b), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }

  /* ---------- 页面能力导出（云服务模块复用，避免重复实现） ---------- */
  window.__dfuUI = {
    log: log,
    confirm: confirmDialog,
    loadFile: loadFile,
    getFw: function () { return state.fw; },
    getFwFile: function () { return state.fwFile; },
    getDev: function () { return state.dev; },
    setAddr: function (v) { $('fw-addr').value = v; },
    /* 无硬件环境下测 UI：注入一个只有内存布局的假设备 */
    setFakeDev: function (layoutStr) {
      state.dev = { memLayout: parseMemoryLayout(layoutStr), strings: { layoutRaw: layoutStr } };
      applyDefaultAddr();
      refreshTargetCheck();
      return writableRanges(state.dev.memLayout);
    },
    clearDev: function () { state.dev = null; refreshTargetCheck(); }
  };
}

/* =====================================================================
 * 云服务接入（WorkBuddy Cloud Service：账号 / 数据库 / 文件存储）
 *
 * publicConfig 由 workbuddy_cloud_service 的 activate 结果原样嵌入。
 * endpoint + publishableKey 是前端唯一需要的配置，客户端初始化必须传；
 * 真实的资源 ID 与供应商密钥只在服务端，前端不持有。
 *
 * 设计边界：账号与云端只承载「升级记录」和「团队固件库」。
 * 未登录、SDK 加载失败、网络异常都不影响连接设备与烧写固件。
 * ===================================================================== */
var PUBLIC_CONFIG = {
  endpoint: 'https://stm32-dfu-flasher.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_YuAvAs0R4YNAkyBkR0H1WW_dv8hwvVV0cRgTwgs2DiLUuce2D5H4044'
};

var CloudApi = (function () {
  var REC_PAGE = 8;
  var REC_COLS = 'id, firmware_name, firmware_format, firmware_size, firmware_crc32, device_product, ' +
    'device_serial, target_addr, pages_erased, verified, jumped, duration_ms, result, error_message, created_at';

  var client = null;
  var session = null;
  var libRows = [];
  var recPage = 0;
  var recTotal = 0;
  var otpPending = null;
  var loginMethod = 'phone';
  var cooldownTimer = null;
  var msgIsError = false;
  var initialized = false;

  /* ---------------- 基础工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function ui() { return window.__dfuUI || {}; }
  function clog(level, msg) {
    var fn = ui().log || window.appendLog;
    if (fn) fn(level, '[云] ' + msg);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cut(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function pad2(n) { return ('0' + n).slice(-2); }
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtDur(ms) {
    ms = Number(ms) || 0;
    if (ms <= 0) return '—';
    return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s';
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function extOf(name) {
    var m = String(name || '').match(/\.([A-Za-z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
  }
  /* 统一把 SDK 的 error 对象翻成人能读的中文 */
  function errText(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    if (err.kind === 'unauthenticated' || err.kind === 'invalid_grant') return '登录状态已失效，请重新登录';
    if (err.kind === 'network') return '网络异常，请检查网络后重试';
    if (err.kind === 'backend-unavailable') return '云服务暂时不可用，请稍后重试';
    if (err.code === '42501') return '当前账号无权执行该操作（请确认已登录）';
    if (err.code === '42P01') return '云端数据表尚未初始化';
    if (err.code === '23505') return '记录已存在，无需重复提交';
    if (err.status === 401) return '云服务鉴权失败，请刷新页面重试';
    return err.message || String(err);
  }

  function getClient() {
    if (client) return client;
    if (typeof WorkBuddyCloud === 'undefined' || !WorkBuddyCloud.createWorkBuddyCloud) {
      throw new Error('云服务 SDK 未加载（CDN 不可达），请检查网络后刷新页面');
    }
    client = WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: PUBLIC_CONFIG.endpoint,
      oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
      publishableKey: PUBLIC_CONFIG.publishableKey
    });
    return client;
  }

  function signedIn() { return !!(session && session.user && session.user.id); }

  function displayName() {
    if (!signedIn()) return '未登录云服务';
    var u = session.user, raw = u.raw || {};
    if (u.name) return cut(u.name, 12);
    var ph = u.phone || raw.phone_number || raw.phone;
    if (ph) {
      var s = String(ph).replace(/^\+?86/, '');
      return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
    }
    if (u.email) return cut(String(u.email).replace(/^(.).*(@.*)$/, '$1***$2'), 18);
    return '已登录用户';
  }

  /* ---------------- 状态渲染 ---------------- */
  function setRecEnabled(on) {
    var pages = Math.max(1, Math.ceil(recTotal / REC_PAGE));
    $('btn-rec-refresh').disabled = !on;
    $('btn-rec-prev').disabled = !on || recPage <= 0;
    $('btn-rec-next').disabled = !on || recPage >= pages - 1;
    $('rec-page').textContent = on ? ('第 ' + (recPage + 1) + ' / ' + pages + ' 页 · 共 ' + recTotal + ' 条') : '';
  }

  function renderAuth() {
    var on = signedIn();
    $('btn-login').style.display = on ? 'none' : 'inline-block';
    $('btn-logout').style.display = on ? 'inline-block' : 'none';
    var pill = $('user-pill');
    pill.className = 'pill' + (on ? ' on' : '');
    pill.title = on ? '已连接云服务：升级记录与团队固件库可用' : '登录后启用云端升级记录与团队固件库';
    $('user-name').textContent = on ? displayName() : '未登录云服务';
    $('rec-tag').textContent = on ? '已同步' : '未登录';
    $('lib-tag').textContent = on ? '团队共享' : '未登录';
    $('btn-lib-upload').disabled = !on;
    setRecEnabled(on);
    if (!on) { renderRecords([]); renderLibrary([]); }
  }

  function renderRecords(rows) {
    var box = $('rec-list');
    if (!signedIn()) {
      box.innerHTML = '<div class="cloud-empty">登录后可查看云端升级记录<br>每次「开始升级」都会自动同步</div>';
      setRecEnabled(false);
      return;
    }
    if (!rows.length) {
      box.innerHTML = '<div class="cloud-empty">暂无升级记录<br>升级一次设备就会出现在这里</div>';
      setRecEnabled(true);
      return;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], ok = r.result === 'success';
      var meta = [];
      if (r.device_product) meta.push(esc(cut(r.device_product, 20)));
      if (r.device_serial) meta.push('SN ' + esc(cut(r.device_serial, 16)));
      meta.push(fmtSize(r.firmware_size));
      if (r.target_addr) meta.push(esc(r.target_addr));
      meta.push(fmtDur(r.duration_ms));
      var tags = [];
      if (r.verified) tags.push('已校验');
      if (r.jumped) tags.push('已跳转');
      html += '<div class="cloud-item">' +
        '<div class="ci-main">' +
          '<div class="ci-name">' + esc(cut(r.firmware_name, 30)) +
            ' <span class="badge ' + (ok ? 'ok' : 'err') + '">' + (ok ? '成功' : '失败') + '</span></div>' +
          '<div class="ci-meta">' + meta.join(' · ') + '</div>' +
          '<div class="ci-meta">' + fmtTime(r.created_at) +
            (r.firmware_crc32 ? ' · CRC ' + esc(r.firmware_crc32) : '') +
            (tags.length ? ' · ' + tags.join(' / ') : '') + '</div>' +
          (!ok && r.error_message
            ? '<div class="ci-meta" style="color:var(--danger)">' + esc(cut(r.error_message, 90)) + '</div>' : '') +
        '</div>' +
        '<div class="ci-act"><button class="mini danger" data-rec-del="' + r.id + '">删除</button></div>' +
      '</div>';
    }
    box.innerHTML = html;
    var btns = box.querySelectorAll('[data-rec-del]');
    for (var k = 0; k < btns.length; k++) {
      btns[k].onclick = function () { deleteRecord(this.getAttribute('data-rec-del')); };
    }
    setRecEnabled(true);
  }

  function renderLibrary(rows) {
    var box = $('lib-list');
    if (!signedIn()) {
      box.innerHTML = '<div class="cloud-empty">登录后可上传、下载团队固件库</div>';
      return;
    }
    if (!rows.length) {
      box.innerHTML = '<div class="cloud-empty">固件库还是空的<br>加载固件后点右上角「上传当前固件」</div>';
      return;
    }
    var mine = session.user.id, html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], isMine = r.owner_id === mine;
      html += '<div class="cloud-item">' +
        '<div class="ci-main">' +
          '<div class="ci-name">' + esc(cut(r.file_name, 28)) +
            (isMine ? ' <span class="badge mine">我上传</span>' : '') + '</div>' +
          '<div class="ci-meta">' + fmtSize(r.file_size) +
            (r.file_format ? ' · ' + esc(r.file_format) : '') +
            (r.target_addr ? ' · ' + esc(r.target_addr) : '') +
            (r.crc32 ? ' · CRC ' + esc(r.crc32) : '') + '</div>' +
          '<div class="ci-meta">' + (r.owner_name ? esc(cut(r.owner_name, 12)) + ' · ' : '') +
            fmtTime(r.created_at) + '</div>' +
        '</div>' +
        '<div class="ci-act">' +
          '<button class="mini" data-lib-load="' + r.id + '">载入</button>' +
          (isMine ? '<button class="mini danger" data-lib-del="' + r.id + '">删除</button>' : '') +
        '</div>' +
      '</div>';
    }
    box.innerHTML = html;
    var loads = box.querySelectorAll('[data-lib-load]');
    for (var a = 0; a < loads.length; a++) {
      loads[a].onclick = function () { loadFromLibrary(this.getAttribute('data-lib-load')); };
    }
    var dels = box.querySelectorAll('[data-lib-del]');
    for (var b = 0; b < dels.length; b++) {
      dels[b].onclick = function () { deleteLibrary(this.getAttribute('data-lib-del')); };
    }
  }

  /* ---------------- 登录 / 退出 ---------------- */
  function showLoginMsg(text, isError) {
    var el = $('login-msg');
    msgIsError = !!isError;
    if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.style.color = isError ? 'var(--danger)' : 'var(--ok)';
    el.textContent = text;
  }

  function openLogin(reason) {
    $('login-mask').classList.add('show');
    showLoginMsg(reason || '');
    setTimeout(function () { $('login-phone').focus(); }, 30);
  }

  function requireLogin(reason) {
    if (signedIn()) return true;
    openLogin(reason ? '登录后可' + reason : '');
    return false;
  }

  function setMethod(m) {
    loginMethod = m;
    $('tab-phone').className = 'tab' + (m === 'phone' ? ' on' : '');
    $('tab-email').className = 'tab' + (m === 'email' ? ' on' : '');
    $('field-phone').style.display = m === 'phone' ? 'flex' : 'none';
    $('field-email').style.display = m === 'email' ? 'flex' : 'none';
    otpPending = null;
    showLoginMsg('');
    setTimeout(function () {
      (m === 'phone' ? $('login-phone') : $('login-email')).focus();
    }, 20);
  }

  function currentIdentifier() {
    return (loginMethod === 'phone' ? $('login-phone') : $('login-email')).value.trim();
  }

  /* 返回空字符串表示通过，否则返回要展示的错误文案 */
  function validateIdentifier(id) {
    if (loginMethod === 'phone') {
      return /^1\d{10}$/.test(id) ? '' : '请输入正确的 11 位手机号';
    }
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(id) ? '' : '请输入正确的邮箱地址';
  }

  function startCooldown(sec) {
    var left = sec, btn = $('btn-send-code');
    btn.disabled = true;
    btn.textContent = left + 's 后重发';
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(function () {
      left--;
      if (left <= 0) {
        clearInterval(cooldownTimer); cooldownTimer = null;
        btn.disabled = false;
        btn.textContent = '获取验证码';
      } else {
        btn.textContent = left + 's 后重发';
      }
    }, 1000);
  }

  async function sendCode() {
    var id = currentIdentifier();
    var bad = validateIdentifier(id);
    if (bad) {
      showLoginMsg(bad, true);
      (loginMethod === 'phone' ? $('login-phone') : $('login-email')).focus();
      return;
    }
    var btn = $('btn-send-code');
    btn.disabled = true;
    try {
      var payload = {};
      if (loginMethod === 'phone') payload.phone = id; else payload.email = id;
      var sent = await getClient().auth.sendOtp(payload);
      if (sent.error) {
        btn.disabled = false;
        showLoginMsg(errText(sent.error), true);
        return;
      }
      otpPending = {
        method: loginMethod,
        identifier: id,
        verificationId: sent.data.verificationId,
        isExistingUser: !!sent.data.isExistingUser
      };
      showLoginMsg(loginMethod === 'phone' ? '验证码已发送，请查收短信' : '验证码已发送，请查收邮件');
      startCooldown(60);
      $('login-code').focus();
    } catch (e) {
      btn.disabled = false;
      showLoginMsg(errText(e), true);
    }
  }

  async function doLogin() {
    var id = currentIdentifier();
    var bad = validateIdentifier(id);
    if (bad) { showLoginMsg(bad, true); return; }
    var code = $('login-code').value.trim();
    if (!/^\d{4,8}$/.test(code)) { showLoginMsg('请输入收到的验证码', true); return; }
    if (!otpPending || otpPending.identifier !== id || otpPending.method !== loginMethod) {
      showLoginMsg('请先获取当前' + (loginMethod === 'phone' ? '手机号' : '邮箱') + '的验证码', true);
      return;
    }
    var btn = $('login-ok');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      var req = {
        verificationId: otpPending.verificationId,
        isExistingUser: otpPending.isExistingUser,
        token: code
      };
      if (otpPending.method === 'phone') req.phone = otpPending.identifier;
      else req.email = otpPending.identifier;
      var res = await getClient().auth.verifyOtp(req);
      if (res.error) { showLoginMsg(errText(res.error), true); return; }
      session = res.data;
      otpPending = null;
      $('login-code').value = '';
      $('login-mask').classList.remove('show');
      showLoginMsg('');
      renderAuth();
      clog('success', '已登录云服务：' + displayName());
      await Promise.all([loadRecords(true), loadLibrary()]);
    } catch (e) {
      showLoginMsg(errText(e), true);
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  }

  async function logout() {
    try { await getClient().auth.signOut(); } catch (e) { /* 本地会话照常清理 */ }
    session = null;
    otpPending = null;
    recPage = 0;
    recTotal = 0;
    libRows = [];
    renderAuth();
    clog('info', '已退出云服务账号，烧写功能不受影响');
  }

  async function restore() {
    try {
      var res = await getClient().auth.getSession();
      if (res && res.data && res.data.user) {
        session = res.data;
        renderAuth();
        clog('info', '云服务已就绪：' + displayName());
        await Promise.all([loadRecords(true), loadLibrary()]);
      } else {
        session = null;
        renderAuth();
        clog('info', '云服务已就绪（未登录，烧写功能不受影响）');
      }
    } catch (e) {
      session = null;
      renderAuth();
      $('user-pill').className = 'pill err';
      $('user-name').textContent = '云服务不可用';
      clog('warn', '云服务不可用：' + errText(e));
    }
  }

  /* ---------------- 升级记录 ---------------- */
  async function loadRecords(reset) {
    if (!signedIn()) { renderRecords([]); return; }
    if (reset) recPage = 0;
    var from = recPage * REC_PAGE, to = from + REC_PAGE - 1;
    try {
      var res = await getClient().database
        .from('flash_records')
        .select(REC_COLS, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);
      if (res.error) {
        $('rec-list').innerHTML = '<div class="cloud-empty">记录加载失败：' + esc(errText(res.error)) + '</div>';
        setRecEnabled(true);
        return;
      }
      recTotal = typeof res.count === 'number' ? res.count : (res.data || []).length;
      if (!(res.data || []).length && recPage > 0) { recPage--; return loadRecords(false); }
      renderRecords(res.data || []);
    } catch (e) {
      $('rec-list').innerHTML = '<div class="cloud-empty">记录加载失败：' + esc(errText(e)) + '</div>';
      setRecEnabled(true);
    }
  }

  async function deleteRecord(id) {
    if (!requireLogin('删除云端升级记录')) return;
    var ok = await ui().confirm('删除升级记录', '将从云端永久删除这条记录，<b>不可恢复</b>。', '删除');
    if (!ok) return;
    try {
      var res = await getClient().database.from('flash_records').delete().eq('id', id).select();
      if (res.error) { clog('error', '删除失败：' + errText(res.error)); return; }
      if (!res.data || !res.data.length) { clog('warn', '未删除：记录不存在或不属于当前账号'); return; }
      clog('success', '已删除 1 条升级记录');
      await loadRecords(false);
    } catch (e) {
      clog('error', '删除失败：' + errText(e));
    }
  }

  /* 升级结束后由页面调用：把本次结果写入云端（未登录时静默跳过） */
  async function afterFlash(info) {
    if (!signedIn()) return;
    try {
      var fw = info && info.fw;
      if (!fw) return;
      var dev = ui().getDev ? ui().getDev() : null;
      var pages = 0;
      try {
        if (dev && dev.memLayout) {
          for (var i = 0; i < fw.segments.length; i++) {
            pages += pagesToErase(dev.memLayout, fw.segments[i].addr, fw.segments[i].data.length).length;
          }
        }
      } catch (e2) { pages = 0; }

      var row = {
        device_product: (dev && dev.strings && dev.strings.product) || null,
        device_serial: (dev && dev.strings && dev.strings.serial) || null,
        vid_pid: dev ? hex(dev.usb.vendorId, 4) + ':' + hex(dev.usb.productId, 4) : null,
        firmware_name: fw.name,
        firmware_format: extOf(fw.name),
        firmware_size: fw.size,
        firmware_crc32: hex(fw.crc),
        target_addr: hex(fw.baseAddr),
        segment_count: fw.segments.length,
        pages_erased: pages,
        verified: !!info.verify,
        jumped: !!info.jump,
        duration_ms: info.durationMs || 0,
        result: info.ok ? 'success' : 'failed',
        error_message: info.ok ? null : cut(info.error || '未知错误', 200),
        owner_name: session.user.name || null
      };
      var res = await getClient().database.from('flash_records').insert(row).select();
      if (res.error) { clog('warn', '升级记录同步失败：' + errText(res.error)); return; }
      clog('success', '本次升级记录已同步到云端');
      await loadRecords(false);
    } catch (e) {
      clog('warn', '升级记录同步失败：' + errText(e));
    }
  }

  /* ---------------- 团队固件库 ---------------- */
  async function loadLibrary() {
    if (!signedIn()) { renderLibrary([]); return; }
    try {
      var res = await getClient().database
        .from('firmware_library')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30);
      if (res.error) {
        $('lib-list').innerHTML = '<div class="cloud-empty">固件库加载失败：' + esc(errText(res.error)) + '</div>';
        return;
      }
      libRows = res.data || [];
      renderLibrary(libRows);
    } catch (e) {
      $('lib-list').innerHTML = '<div class="cloud-empty">固件库加载失败：' + esc(errText(e)) + '</div>';
    }
  }

  function findLibRow(id) {
    for (var i = 0; i < libRows.length; i++) if (String(libRows[i].id) === String(id)) return libRows[i];
    return null;
  }

  async function uploadCurrent() {
    if (!requireLogin('把固件上传到团队固件库')) return;
    var fw = ui().getFw ? ui().getFw() : null;
    var file = ui().getFwFile ? ui().getFwFile() : null;
    if (!fw || !file) { clog('warn', '请先加载一个固件文件再上传'); return; }
    if (fw.size > 8 * 1024 * 1024) { clog('warn', '固件超过 8 MB，暂不支持上传'); return; }

    var ok = await ui().confirm('上传到团队固件库',
      '将把 <b>' + esc(file.name) + '</b>（' + fmtSize(fw.size) + '）上传到团队固件库。<br>' +
      '同一账号的其他电脑、以及团队成员都可以下载并烧写。', '上传');
    if (!ok) return;

    var btn = $('btn-lib-upload');
    btn.disabled = true;
    btn.textContent = '上传中…';
    try {
      var c = getClient();
      var safe = String(file.name).replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
      var path = c.storage.sharedPath(session.user.id, 'firmware/' + Date.now().toString(36) + '-' + safe);
      var up = await c.storage.upload(path, file, {
        contentType: 'application/octet-stream',
        cacheControl: '3600',
        upsert: false
      });
      if (up.error) throw new Error(errText(up.error));
      var ins = await c.database.from('firmware_library').insert({
        file_name: file.name,
        file_format: extOf(file.name),
        file_size: fw.size,
        crc32: hex(fw.crc),
        target_addr: hex(fw.baseAddr),
        storage_path: path,
        owner_name: session.user.name || null
      }).select();
      if (ins.error) {
        try { await c.storage.remove([path]); } catch (e2) { /* 元数据失败时尽力回收文件 */ }
        throw new Error(errText(ins.error));
      }
      clog('success', '已上传到团队固件库：' + file.name);
      await loadLibrary();
    } catch (e) {
      clog('error', '上传失败：' + errText(e));
    } finally {
      btn.disabled = !signedIn();
      btn.textContent = '上传当前固件';
    }
  }

  async function loadFromLibrary(id) {
    if (!requireLogin('从团队固件库载入固件')) return;
    var row = findLibRow(id);
    if (!row) { clog('warn', '固件记录已不存在，请刷新列表'); return; }
    try {
      clog('info', '从云端下载 ' + row.file_name + '…');
      var res = await getClient().storage.download(row.storage_path);
      if (res.error) throw new Error(errText(res.error));
      var blob = res.data;
      if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('云端文件内容无法读取');
      if (row.file_format === 'bin' && row.target_addr) ui().setAddr(row.target_addr);
      var file = new File([blob], row.file_name, { type: 'application/octet-stream' });
      await ui().loadFile(file);
      clog('success', '已从云端载入 ' + row.file_name + '，可直接开始升级');
    } catch (e) {
      clog('error', '载入失败：' + errText(e));
    }
  }

  async function deleteLibrary(id) {
    if (!requireLogin('删除固件库文件')) return;
    var row = findLibRow(id);
    if (!row) { clog('warn', '固件记录已不存在，请刷新列表'); return; }
    var ok = await ui().confirm('删除固件库文件',
      '将删除 <b>' + esc(row.file_name) + '</b>，包括云端存储的固件文件，<b>不可恢复</b>。', '删除');
    if (!ok) return;
    try {
      var c = getClient();
      var del = await c.database.from('firmware_library').delete().eq('id', row.id).select();
      if (del.error) { clog('error', '删除失败：' + errText(del.error)); return; }
      if (!del.data || !del.data.length) { clog('warn', '未删除：该固件不是当前账号上传的'); return; }
      try {
        var rm = await c.storage.remove([row.storage_path]);
        if (rm && rm.error) clog('warn', '记录已删除，但云端文件清理失败：' + errText(rm.error));
      } catch (e2) {
        clog('warn', '记录已删除，但云端文件清理失败');
      }
      clog('success', '已删除：' + row.file_name);
      await loadLibrary();
    } catch (e) {
      clog('error', '删除失败：' + errText(e));
    }
  }

  /* ---------------- 事件绑定与启动 ---------------- */
  function bind() {
    $('btn-login').onclick = function () { openLogin(''); };
    $('btn-logout').onclick = logout;
    $('login-cancel').onclick = function () { $('login-mask').classList.remove('show'); };
    $('login-ok').onclick = doLogin;
    $('btn-send-code').onclick = sendCode;
    $('login-mask').onclick = function (e) { if (e.target === this) this.classList.remove('show'); };

    $('login-phone').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); sendCode(); } };
    $('login-email').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); sendCode(); } };
    $('login-code').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } };
    $('login-phone').oninput = function () { if (msgIsError) showLoginMsg(''); };
    $('login-email').oninput = function () { if (msgIsError) showLoginMsg(''); };
    $('login-code').oninput = function () { if (msgIsError) showLoginMsg(''); };
    $('tab-phone').onclick = function () { setMethod('phone'); };
    $('tab-email').onclick = function () { setMethod('email'); };

    $('btn-rec-refresh').onclick = function () { loadRecords(false); };
    $('btn-rec-prev').onclick = function () { if (recPage > 0) { recPage--; loadRecords(false); } };
    $('btn-rec-next').onclick = function () {
      var pages = Math.max(1, Math.ceil(recTotal / REC_PAGE));
      if (recPage < pages - 1) { recPage++; loadRecords(false); }
    };
    $('btn-lib-upload').onclick = uploadCurrent;
  }

  function init() {
    if (initialized) return;
    initialized = true;
    bind();
    renderAuth();
    restore();
  }

  return {
    init: init,
    afterFlash: afterFlash,
    refreshRecords: loadRecords,
    refreshLibrary: loadLibrary,
    isSignedIn: signedIn
  };
})();

if (typeof document !== 'undefined' && document.getElementById && document.getElementById('rec-list')) {
  window.CloudApi = CloudApi;
  CloudApi.init();
}

/* ---------------- 导出核心（供 Node 测试） ---------------- */
DFUCore.DFU = DFU;
DFUCore.DfuDevice = DfuDevice;
DFUCore.DfuError = DfuError;
DFUCore.parseIntelHex = parseIntelHex;
DFUCore.parseDfuSe = parseDfuSe;
DFUCore.parseElf = parseElf;
DFUCore.parseMemoryLayout = parseMemoryLayout;
DFUCore.pagesToErase = pagesToErase;
DFUCore.minEraseUnit = minEraseUnit;
DFUCore.erasePlan = erasePlan;
DFUCore.checkWriteRange = checkWriteRange;
DFUCore.writableRanges = writableRanges;
DFUCore.mergeSegments = mergeSegments;
DFUCore.accessOf = accessOf;
DFUCore.accessLabel = accessLabel;
DFUCore.DFU_ACCESS = DFU_ACCESS;
DFUCore.segmentOf = segmentOf;
DFUCore.crc32 = crc32;
if (typeof module !== 'undefined' && module.exports) module.exports = DFUCore;
if (typeof window !== 'undefined') window.DFUCore = DFUCore;
