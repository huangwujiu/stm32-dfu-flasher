'use strict';
/* =====================================================================
 * 浏览器端到端测试（DOM 驱动 + 真实硬件，零截图、零物理点击）
 *
 * 为什么要这样设计：
 *   WebUSB 第一次授权必须经过浏览器原生的设备选择气泡，它是 Chromium 的
 *   Views UI，不在页面 DOM 里，无法用 querySelector / CDP DOM 操作，
 *   只能靠截图像素 + 系统鼠标 —— 又慢又脆。
 *
 *   所以这里换一个思路：把 navigator.usb 换成一个「桥」——
 *   页面代码、DOM、事件处理、进度/日志 UI、DfuDevice 全部是真的，
 *   只有最底层 USB 控制传输由 CDP 转发给 Node，由 libusb 打到真实设备。
 *
 *   于是：页面按钮可以用 element.click() 点、状态可以读 DOM、结果可以断言，
 *   而数据仍然真的在 STM32 上跑。
 *
 * 只做只读验证（info / getStatus / UPLOAD 读回），不写 Flash、不 leaveDfu。
 * ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { makeWebUsbAdapter } = require('./usb-node-adapter.js');
const { WebUSB } = require('usb');

const ROOT = path.resolve(__dirname, '..');
const ROOTN = path.normalize(ROOT);
const OUT = __dirname;
const PORT = 8771;
const CDP_PORT = 9227;
const PROFILE = path.join(OUT, 'edge-bridge-' + Date.now());
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m[PASS]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  \x1b[31m[FAIL]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  return !!cond;
}
const hex = n => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

process.on('exit', () => {
  try {
    spawnSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File',
      path.join(OUT, 'kill-test-edge.ps1')], { timeout: 30000, windowsHide: true, stdio: 'ignore' });
  } catch (e) {}
});

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(ROOT, p));
  if ((f !== ROOTN && !f.startsWith(ROOTN + path.sep)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': fs.statSync(f).size });
  fs.createReadStream(f).pipe(res);
});

/* ---------- CDP ---------- */
let ws, msgId = 0;
const pending = new Map();
const evHandlers = {};
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 25000);
  });
}
function onEvent(m, fn) { (evHandlers[m] = evHandlers[m] || []).push(fn); }
async function evaluate(expr, userGesture) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: !!userGesture
  });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

/* ---------- 真实设备（Node 侧持有） ---------- */
let realDev = null, realAdapter = null;

async function usbOp(op, args) {
  switch (op) {
    case 'open':
      if (!realAdapter) throw new Error('adapter not init');
      await realAdapter.open();
      return null;
    case 'close':
      try { await realDev.close(); } catch (e) {}
      return null;
    case 'selectConfiguration':
      try { await realAdapter.selectConfiguration(args[0]); } catch (e) {}
      return null;
    case 'claimInterface':
      await realAdapter.claimInterface(args[0]);
      return null;
    case 'selectAlternateInterface':
      await realAdapter.selectAlternateInterface(args[0], args[1]);
      return null;
    case 'ctrlIn': {
      const r = await realAdapter.controlTransferIn(args[0], args[1]);
      return { status: r.status, data: r.data ? Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength).toString('base64') : null };
    }
    case 'ctrlOut': {
      const bytes = args[1] ? Buffer.from(args[1], 'base64') : new Uint8Array(0);
      const r = await realAdapter.controlTransferOut(args[0], new Uint8Array(bytes));
      return { status: r.status, bytesWritten: r.bytesWritten };
    }
    default:
      throw new Error('unknown op ' + op);
  }
}

async function main() {
  /* --- 先确认设备在线 --- */
  const webusb = new WebUSB({ allowAllDevices: true });
  realDev = (await webusb.getDevices()).find(d => d.vendorId === 0x0483 && d.productId === 0xdf11);
  if (!realDev) { console.error('未找到 STM32 DFU 设备 0483:df11'); process.exit(1); }
  realAdapter = makeWebUsbAdapter(realDev, 0);
  console.log('真实设备: ' + realDev.productName + ' / ' + realDev.serialNumber);

  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log('HTTP: http://127.0.0.1:' + PORT);

  console.log('\n== 1. 启动 Edge ==');
  spawnSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File',
    path.join(OUT, 'kill-test-edge.ps1')], { timeout: 30000, windowsHide: true, stdio: 'ignore' });
  await sleep(600);
  try {
    const defDir = path.join(PROFILE, 'Default');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(path.join(defDir, 'Preferences'), JSON.stringify({
      sync_promo: { show_on_first_run_allowed: false, user_skipped: true },
      signin: { allowed: false, allowed_on_next_startup: false },
      browser: { has_seen_welcome_page: true, check_default_browser: false }
    }));
  } catch (e) {}
  spawn(EDGE, ['--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-service-autorun',
    '--window-position=0,0', '--window-size=1600,1000', 'about:blank'],
    { stdio: 'ignore', windowsHide: true });

  let targets = null;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      if (targets.some(t => t.type === 'page')) break;
    } catch (e) {}
    await sleep(300);
  }
  if (!targets) { console.error('CDP 未就绪'); process.exit(1); }
  const page = targets.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method && evHandlers[m.method]) {
      for (const fn of evHandlers[m.method]) fn(m.params);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Runtime.addBinding', { name: '__usbSend' });

  /* USB 请求桥：页面 → Node → 真实设备 → 页面 */
  let xferCount = 0;
  onEvent('Runtime.bindingCalled', async p => {
    if (p.name !== '__usbSend') return;
    let req;
    try { req = JSON.parse(p.payload); } catch (e) { return; }
    try {
      const result = await usbOp(req.op, req.args || []);
      xferCount++;
      await evaluate('window.__usbReply(' + JSON.stringify(req.id) + ', true, ' +
        JSON.stringify(result === null ? null : result) + ')');
    } catch (e) {
      await evaluate('window.__usbReply(' + JSON.stringify(req.id) + ', false, ' +
        JSON.stringify(e.message || String(e)) + ')').catch(() => {});
    }
  });

  console.log('\n== 2. 打开工具页面 ==');
  const loadOk = new Promise(res => onEvent('Page.loadEventFired', res));
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
  await Promise.race([loadOk, sleep(15000)]);
  await sleep(900);
  let domOk = false;
  for (let i = 0; i < 30; i++) {
    try { if (await evaluate('document.readyState === "complete" && !!document.getElementById("btn-connect")')) { domOk = true; break; } } catch (e) {}
    await sleep(300);
  }
  if (!domOk) { console.error('页面 DOM 未就绪'); process.exit(1); }
  console.log('  标题: ' + (await evaluate('document.title')));
  check('页面加载完成、DOM 就绪', domOk);

  console.log('\n== 3. 安装 navigator.usb 桥（页面代码不动，只换传输层） ==');
  await evaluate(`
    (function(){
      var PEND = {}; var SEQ = 0;
      window.__usbReply = function(id, ok, payload) {
        var p = PEND[id]; if (!p) return;
        delete PEND[id];
        if (ok) p.res(payload); else p.rej(new Error(payload || 'usb error'));
      };
      function call(op, args) {
        return new Promise(function(res, rej) {
          var id = 'c' + (++SEQ);
          PEND[id] = { res: res, rej: rej };
          window.__usbSend(JSON.stringify({ id: id, op: op, args: args || [] }));
        });
      }
      function b64ToAB(b64) {
        var s = atob(b64), u = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        return u.buffer;
      }
      function abToB64(ab) {
        var u = new Uint8Array(ab), s = '', CH = 0x8000;
        for (var i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
        return btoa(s);
      }
      var DEV = {
        vendorId: ${realDev.vendorId}, productId: ${realDev.productId},
        manufacturerName: ${JSON.stringify(realDev.manufacturerName)},
        productName: ${JSON.stringify(realDev.productName)},
        serialNumber: ${JSON.stringify(realDev.serialNumber)},
        opened: false,
        configuration: { configurationValue: 1, interfaces: [] },
        open: function(){ return call('open').then(function(){ DEV.opened = true; }); },
        close: function(){ return call('close').then(function(){ DEV.opened = false; }); },
        selectConfiguration: function(n){ return call('selectConfiguration', [n]); },
        claimInterface: function(n){ return call('claimInterface', [n]); },
        selectAlternateInterface: function(i, a){ return call('selectAlternateInterface', [i, a]); },
        controlTransferIn: function(setup, len) {
          return call('ctrlIn', [setup, len]).then(function(r){
            return { status: r.status, data: r.data ? new DataView(b64ToAB(r.data)) : undefined };
          });
        },
        controlTransferOut: function(setup, data) {
          var b64 = '';
          if (data && data.byteLength) b64 = abToB64(data);
          return call('ctrlOut', [setup, b64]).then(function(r){
            return { status: r.status, bytesWritten: r.bytesWritten };
          });
        }
      };
      var SHIM = {
        getDevices: function(){ return Promise.resolve([DEV]); },
        requestDevice: function(){ return Promise.resolve(DEV); },
        addEventListener: function(){}, removeEventListener: function(){}
      };
      Object.defineProperty(navigator, 'usb', { value: SHIM, configurable: true });
      return 'installed';
    })()
  `);
  check('navigator.usb 桥安装成功', (await evaluate('!!(navigator.usb && navigator.usb.getDevices)')));

  console.log('\n== 4. 点页面「连接设备」按钮（纯 DOM 事件） ==');
  await evaluate("document.getElementById('btn-connect').click()", true);
  let connected = false, connTxt = '';
  for (let i = 0; i < 30; i++) {
    connTxt = await evaluate('(document.getElementById("conn-text")||{}).textContent || ""');
    if (connTxt.indexOf('已连接') >= 0) { connected = true; break; }
    await sleep(300);
  }
  check('点击按钮后页面 UI 显示已连接', connected, (connTxt || '').trim());
  if (!connected) {
    const lg = await evaluate('document.getElementById("log").innerText');
    console.log('  页面日志:\n' + lg.split('\n').slice(-12).map(l => '    ' + l).join('\n'));
    throw new Error('连接失败');
  }

  console.log('\n== 5. 设备信息面板（读 DOM，不是读接口） ==');
  const panel = await evaluate(`(function(){
    var t = document.body.innerText;
    var m = {};
    var rows = document.querySelectorAll('.kv, .info-row, tr');
    return JSON.stringify({ text: t.slice(0, 1200) });
  })()`);
  const panelText = JSON.parse(panel).text;
  console.log('  面板文本片段: ' + panelText.split('\n').filter(l => l.trim()).slice(0, 16).join(' | '));
  check('面板出现序列号', panelText.indexOf(realDev.serialNumber) >= 0, realDev.serialNumber);
  check('面板出现 VID / PID', /0483/i.test(panelText) && /DF11/i.test(panelText));
  check('面板出现传输块大小 1024', /1024/.test(panelText));

  console.log('\n== 6. 协议验证（页面内 __dfuTest，走同一条桥） ==');
  const info = JSON.parse(await evaluate('(async () => JSON.stringify(await window.__dfuTest.info()))()'));
  console.log('  设备: ' + info.product + ' / ' + info.manufacturer + '  序列号=' + info.serial);
  console.log('  wTransferSize=' + info.xferSize + '  bcdDFU=0x' + info.dfuVersion.toString(16));
  console.log('  布局: ' + info.layoutRaw);
  check('页面读到设备信息', info.serial === realDev.serialNumber, info.serial);
  check('传输块大小 = 1024', info.xferSize === 1024, info.xferSize + ' B');
  check('内存布局已解析', Array.isArray(info.layout) && info.layout.length > 0,
    (info.layout || []).map(s => s.name + '@' + hex(s.base)).join(', '));

  const st = JSON.parse(await evaluate('(async () => JSON.stringify(await window.__dfuTest.getStatus()))()'));
  console.log('  GETSTATUS: bStatus=' + st.status + ' bState=' + st.state);
  check('GETSTATUS 有效', typeof st.state === 'number', 'state=' + st.state);

  const seg = (info.layout || [])[0];
  const addr = seg ? seg.base : 0x08000000;
  const t0 = Date.now();
  const b64 = await evaluate('(async () => await window.__dfuTest.upload(' + addr + ', 512))()');
  const buf = Buffer.from(b64, 'base64');
  console.log('  UPLOAD 512B @' + hex(addr) + ' 耗时 ' + (Date.now() - t0) + ' ms -> ' + buf.length + ' B');
  check('页面内 UPLOAD 512B', buf.length === 512, buf.length + ' B');

  const sp = buf.readUInt32LE(0), rv = buf.readUInt32LE(4);
  console.log('  向量表: SP=' + hex(sp) + '  Reset=' + hex(rv));
  check('读回是有效向量表', sp >= 0x20000000 && sp <= 0x20020000 && (rv & 1) === 1,
    'SP=' + hex(sp) + ' Reset=' + hex(rv));

  const b64b = await evaluate('(async () => await window.__dfuTest.upload(' + addr + ', 512))()');
  check('重复读回一致', b64 === b64b);

  const t1 = Date.now();
  const b64m = await evaluate('(async () => await window.__dfuTest.upload(' + addr + ', 16384))()');
  const bufm = Buffer.from(b64m, 'base64');
  check('页面内 UPLOAD 16384B（16 块）', bufm.length === 16384,
    bufm.length + ' B, ' + (Date.now() - t1) + ' ms');

  console.log('\n== 7. 页面日志 ==');
  const pageLog = await evaluate('document.getElementById("log").innerText');
  console.log(pageLog.split('\n').slice(-12).map(l => '    ' + l).join('\n'));
  check('日志记录了逐块兼容降级（真实设备特性）', /逐块|读回序列/.test(pageLog));

  /* ---------- 8. 内存布局面板（权限列） ---------- */
  console.log('\n== 8. 内存布局面板 ==');
  const tableTxt = await evaluate(
    '(function () {' +
    '  var d = document.getElementById("layout-details");' +
    '  if (d) d.open = true;' +
    '  var t = document.getElementById("layout-table");' +
    '  return t ? t.innerText : "";' +
    '})()');
  console.log(String(tableTxt).split('\n').map(function (l) { return '    ' + l; }).join('\n'));
  check('布局表有「权限」列', /权限/.test(tableTxt));
  check('92KB 区标记为可读写', /可读写/.test(tableTxt));
  check('32KB 区标记为只读', /只读/.test(tableTxt));
  check('面板给出可擦写范围', /0x08001000 - 0x08017FFF/.test(tableTxt), String(tableTxt).slice(0, 80));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'bridge-connected.png'), Buffer.from(shot.data, 'base64'));
  console.log('  已保存 bridge-connected.png');

  /* ---------- 9. .bin 默认地址来自描述符 / 手动越界仍提示 ---------- */
  console.log('\n== 9. .bin 默认起始地址来自设备描述符 ==');

  const addrDefault = await evaluate('document.getElementById("fw-addr").value');
  check('连接后 .bin 默认地址取描述符可写区起点 0x08001000',
    addrDefault === '0x08001000', String(addrDefault));
  const addrSrc = await evaluate('document.getElementById("addr-src").textContent');
  check('地址旁标注来自设备描述符', /描述符/.test(String(addrSrc)), String(addrSrc));

  // 未改动地址，直接加载 1KB .bin
  await evaluate(
    '(function () {' +
    '  var dt = new DataTransfer();' +
    '  dt.items.add(new File([new Uint8Array(1024).fill(0x11)], "probe.bin"));' +
    '  var i = document.getElementById("file-input");' +
    '  i.files = dt.files;' +
    '  i.dispatchEvent(new Event("change"));' +
    '})()');
  await sleep(700);
  const segAuto = await evaluate('String(window.__dfuUI.getFw().segments[0].addr)');
  check('未改地址时 .bin 直接落在 0x08001000', segAuto === String(0x08001000), String(segAuto));
  const okTxtAuto = await evaluate('document.getElementById("fw-warn").textContent || ""');
  check('默认地址即命中可写区（绿字）', /在设备声明的可写区内/.test(okTxtAuto), okTxtAuto);

  // 手动坚持用 0x08000000 -> 仍要提示 + 可一键修正
  console.log('\n== 9b. 手动指定越界地址仍拦下 ==');
  await evaluate(
    '(function(){var a=document.getElementById("fw-addr");' +
    'a.value="0x08000000";a.dispatchEvent(new Event("change"));})()');
  await sleep(800);
  const warnTxt = await evaluate('document.getElementById("fw-warn").textContent || ""');
  console.log('    提示: ' + warnTxt);
  check('手动改成 0x08000000 被判为「不在布局内」', /不在设备声明的内存布局/.test(warnTxt), warnTxt);
  check('提示里给出可写区 0x08001000 - 0x08017FFF', /0x08001000 - 0x08017FFF/.test(warnTxt), warnTxt);
  const segManual = await evaluate('String(window.__dfuUI.getFw().segments[0].addr)');
  check('手动地址确实生效（数据段落在 0x08000000）', segManual === String(0x08000000), String(segManual));
  const hasFix = await evaluate('!!document.querySelector("#fw-warn button")');
  check('提供一键改地址按钮', hasFix === true, String(hasFix));
  await evaluate('(function(){var b=document.querySelector("#fw-warn button"); if(b) b.click();})()');
  await sleep(800);
  const addrNow = await evaluate('document.getElementById("fw-addr").value');
  check('点一下把地址改成可写区起点 0x08001000', addrNow === '0x08001000', String(addrNow));
  const segAddr = await evaluate('String(window.__dfuUI.getFw().segments[0].addr)');
  check('.bin 数据段随地址重新解析为 0x08001000', segAddr === String(0x08001000), String(segAddr));
  const okTxt = await evaluate('document.getElementById("fw-warn").textContent || ""');
  check('改完提示变为「在可写区内」', /在设备声明的可写区内/.test(okTxt), okTxt);

  /* ---------- 9c. HEX 地址取自文件 + 整体平移 + 真实设备擦除计划 ---------- */
  console.log('\n== 9c. HEX 起始地址来自文件 / 可整体平移 ==');
  await evaluate(
    '(function () {' +
    '  function rec(type, addr, data) {' +
    '    var b = [data.length, (addr >> 8) & 0xff, addr & 0xff, type].concat(data);' +
    '    var sum = 0; for (var i = 0; i < b.length; i++) sum += b[i];' +
    '    var chk = (0x100 - (sum & 0xff)) & 0xff;' +
    '    return ":" + b.concat([chk]).map(function (x) {' +
    '      return ("0" + x.toString(16)).slice(-2).toUpperCase(); }).join("");' +
    '  }' +
    '  var data = []; for (var i = 0; i < 32; i++) data.push(0x40 + i);' +
    '  var txt = rec(4, 0, [0x08, 0x00]) + "\\n" + rec(0, 0x0400, data) + "\\n" + rec(1, 0, []) + "\\n";' +
    '  var dt = new DataTransfer();' +
    '  dt.items.add(new File([txt], "probe.hex"));' +
    '  var i = document.getElementById("file-input");' +
    '  i.files = dt.files;' +
    '  i.dispatchEvent(new Event("change"));' +
    '})()');
  await sleep(700);
  const hexAddr = await evaluate('document.getElementById("fw-addr").value');
  check('HEX 起始地址取自文件（0x08000400）', hexAddr === '0x08000400', String(hexAddr));
  const hexSeg = await evaluate('String(window.__dfuUI.getFw().segments[0].addr)');
  check('HEX 数据段落在 0x08000400', hexSeg === String(0x08000400), String(hexSeg));
  const hexWarn = await evaluate('document.getElementById("fw-warn").textContent || ""');
  check('0x08000400 仍提示不在布局内', /不在设备声明的内存布局/.test(hexWarn), hexWarn);

  const shifted = await evaluate('JSON.stringify(window.__dfuTest.shiftFw("0x08001000"))');
  check('改地址后整体平移到 0x08001000', shifted === JSON.stringify([0x08001000]), shifted);
  const hexWarn2 = await evaluate('document.getElementById("fw-warn").textContent || ""');
  check('平移后提示变为「在可写区内」', /在设备声明的可写区内/.test(hexWarn2), hexWarn2);
  const shiftLog = await evaluate('document.getElementById("log").innerText');
  check('日志记录了整体平移', /镜像整体平移/.test(shiftLog));

  const plan = JSON.parse(await evaluate('JSON.stringify(window.__dfuTest.erasePlan(0x08000400, 4096))'));
  check('真实设备：0x08000400 起 4KB 补擦 0x08000400/08000800/08000C00',
    plan.pages.length === 4 && plan.pages[0] === 0x08000400 && plan.pages[3] === 0x08001000,
    JSON.stringify(plan.pages));
  check('真实设备：未声明区间被单独标出', plan.undeclared.length === 1, JSON.stringify(plan.undeclared));
  check('真实设备：最小擦除粒度为 1024B',
    await evaluate('window.__dfuTest.minEraseUnit()') === 1024, '');

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'bridge-ro-hint.png'), Buffer.from(shot2.data, 'base64'));
  console.log('  已保存 bridge-ro-hint.png');

  console.log('\n  桥转发次数: ' + xferCount);

  console.log('\n' + '='.repeat(72));
  console.log(' 结果: ' + pass + ' 通过 / ' + fail + ' 失败 / ' + (pass + fail) + ' 项');
  console.log('='.repeat(72));
  server.close();
  try { await realDev.close(); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async e => {
  console.error('\n[中断] ' + e.message);
  try { server.close(); } catch (e2) {}
  try { await realDev.close(); } catch (e2) {}
  process.exit(1);
});
