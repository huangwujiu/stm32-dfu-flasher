'use strict';
/* =====================================================================
 * 页面 UI 驱动的端到端升级测试（真实硬件，零截图 / 零物理点击）
 *
 * 与 browser-bridge-test.js 同一套思路：把 navigator.usb 换成传输桥，
 * 页面代码 / DOM / 事件 / 进度条 / 日志全部是真的，只有最底层控制传输
 * 经 CDP 转给 Node → libusb → 真实设备。
 *
 * 因此本测试完整覆盖用户真实操作路径：
 *   点「连接设备」→ 选文件 → 填起始地址 → 点「开始升级」
 *   → 二次确认弹窗 → 擦除 → 写入 → 校验 → 跳转运行
 * 唯一绕开的是浏览器原生选择器（它不在 DOM 里）。
 *
 * 用法：
 *   NODE_PATH=<node_modules> node test/browser-ui-upgrade.js <firmware.bin>
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
const PORT = 8773;
const CDP_PORT = 9229;
const PROFILE = path.join(OUT, 'edge-ui-' + Date.now());
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FW_PATH = process.argv[2] || 'C:/Users/huang/AppData/Local/Temp/app_build/app.bin';
const FW_ADDR = process.argv[3] || '0x08001000';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m[PASS]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  \x1b[31m[FAIL]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  return !!cond;
}
const hex = n => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
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

/* ---------- 真实设备 ---------- */
let realDev = null, realAdapter = null;
async function usbOp(op, args) {
  switch (op) {
    case 'open': await realAdapter.open(); return null;
    case 'close': try { await realDev.close(); } catch (e) {} return null;
    case 'selectConfiguration': try { await realAdapter.selectConfiguration(args[0]); } catch (e) {} return null;
    case 'claimInterface': await realAdapter.claimInterface(args[0]); return null;
    case 'selectAlternateInterface': await realAdapter.selectAlternateInterface(args[0], args[1]); return null;
    case 'ctrlIn': {
      const r = await realAdapter.controlTransferIn(args[0], args[1]);
      return { status: r.status, data: r.data ? Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength).toString('base64') : null };
    }
    case 'ctrlOut': {
      const bytes = args[1] ? Buffer.from(args[1], 'base64') : new Uint8Array(0);
      const r = await realAdapter.controlTransferOut(args[0], new Uint8Array(bytes));
      return { status: r.status, bytesWritten: r.bytesWritten };
    }
    default: throw new Error('unknown op ' + op);
  }
}
async function listUsb() {
  try {
    const list = await new WebUSB({ allowAllDevices: true }).getDevices();
    return list.filter(d => d.vendorId === 0x0483)
      .map(d => d.productId.toString(16).padStart(4, '0'));
  } catch (e) { return []; }
}

async function main() {
  if (!fs.existsSync(FW_PATH)) { console.error('固件不存在: ' + FW_PATH); process.exit(2); }
  const fw = fs.readFileSync(FW_PATH);
  const fwB64 = fw.toString('base64');
  const fmt = (path.extname(FW_PATH).slice(1) || 'bin').toLowerCase();
  console.log('固件: ' + path.basename(FW_PATH) + '  ' + fw.length + ' B  [.' + fmt + ']  写入 ' + FW_ADDR);
  if (fmt === 'bin') console.log('向量表: SP=' + hex(u32(fw, 0)) + '  Reset=' + hex(u32(fw, 4)));

  const webusb = new WebUSB({ allowAllDevices: true });
  realDev = (await webusb.getDevices()).find(d => d.vendorId === 0x0483 && d.productId === 0xdf11);
  if (!realDev) { console.error('未找到 STM32 DFU 设备 0483:df11（设备是否在 DFU 模式？）'); process.exit(1); }
  realAdapter = makeWebUsbAdapter(realDev, 0);
  console.log('真实设备: ' + realDev.productName + ' / ' + realDev.serialNumber);

  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log('HTTP: http://127.0.0.1:' + PORT);

  /* ---------- 启动 Edge ---------- */
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

  let xferCount = 0, ctrlOutCount = 0;
  onEvent('Runtime.bindingCalled', async p => {
    if (p.name !== '__usbSend') return;
    let req;
    try { req = JSON.parse(p.payload); } catch (e) { return; }
    try {
      const result = await usbOp(req.op, req.args || []);
      xferCount++;
      if (req.op === 'ctrlOut') ctrlOutCount++;
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
  check('页面加载完成', domOk, await evaluate('document.title'));

  console.log('\n== 3. 安装 navigator.usb 传输桥 ==');
  await evaluate(`
    (function(){
      var PEND = {}; var SEQ = 0;
      window.__usbReply = function(id, ok, payload) {
        var p = PEND[id]; if (!p) return; delete PEND[id];
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
  check('传输桥安装成功', await evaluate('!!(navigator.usb && navigator.usb.requestDevice)'));

  console.log('\n== 4. 点「连接设备」（真实 DOM click） ==');
  await evaluate("document.getElementById('btn-connect').click()", true);
  let connected = false, connTxt = '';
  for (let i = 0; i < 40; i++) {
    connTxt = await evaluate('(document.getElementById("conn-text")||{}).textContent || ""');
    if (connTxt.indexOf('已连接') >= 0) { connected = true; break; }
    await sleep(300);
  }
  check('UI 显示已连接', connected, (connTxt || '').trim());
  if (!connected) {
    console.log('  页面日志:\n' + (await evaluate('document.getElementById("log").innerText')).split('\n').slice(-10).join('\n'));
    throw new Error('连接失败');
  }

  console.log('\n== 5. 填起始地址 + 选择固件文件（DataTransfer 触发 change） ==');
  await evaluate(`(function(){
    var a = document.getElementById('fw-addr');
    a.value = '${FW_ADDR}';
    a.dispatchEvent(new Event('input', {bubbles:true}));
    return a.value;
  })()`);
  await evaluate(`(async function(b64){
    var bin = Uint8Array.from(atob(b64), function(c){ return c.charCodeAt(0); });
    var dt = new DataTransfer();
    dt.items.add(new File([bin], ${JSON.stringify(path.basename(FW_PATH))}, {type:'application/octet-stream'}));
    var fi = document.getElementById('file-input');
    fi.files = dt.files;
    fi.dispatchEvent(new Event('change', {bubbles:true}));
    return 'ok';
  })(${JSON.stringify(fwB64)})`);

  let fwLoaded = false, fwInfo = '';
  for (let i = 0; i < 40; i++) {
    fwInfo = await evaluate('(document.getElementById("fw-info")||{}).innerText || ""');
    if (fwInfo.indexOf('CRC32') >= 0) { fwLoaded = true; break; }
    await sleep(200);
  }
  check('页面解析固件（面板显示 CRC32）', fwLoaded, fwInfo.replace(/\s+/g, ' ').slice(0, 120));
  const crcPage = (fwInfo.match(/0x[0-9A-F]{8}/) || [''])[0];
  console.log('  面板信息: ' + fwInfo.replace(/\s+/g, ' '));

  console.log('\n== 6. 勾选状态确认（校验 + 跳转） ==');
  const chk = JSON.parse(await evaluate(`JSON.stringify({
    verify: document.getElementById('chk-verify').checked,
    jump: document.getElementById('chk-jump').checked,
    flashDisabled: document.getElementById('btn-flash').disabled
  })`));
  console.log('  烧写后校验=' + chk.verify + '  完成后跳转=' + chk.jump + '  按钮可用=' + !chk.flashDisabled);
  check('开始升级按钮已启用', chk.flashDisabled === false);

  console.log('\n== 7. 点「开始升级」→ 确认弹窗 ==');
  const tStart = Date.now();
  await evaluate("document.getElementById('btn-flash').click()", true);
  let modalUp = false;
  for (let i = 0; i < 30; i++) {
    modalUp = await evaluate('document.getElementById("modal-mask").classList.contains("show")');
    if (modalUp) break;
    await sleep(200);
  }
  check('二次确认弹窗出现', modalUp);
  const modalTxt = modalUp ? (await evaluate('document.getElementById("modal-mask").innerText')).replace(/\s+/g, ' ') : '';
  console.log('  弹窗文案: ' + modalTxt.slice(0, 160));
  // 弹窗里应能看到目标地址与大小
  check('弹窗显示写入地址 ' + hex(parseInt(FW_ADDR, 16)), /08001000/i.test(modalTxt));

  await evaluate("document.getElementById('modal-ok').click()", true);
  console.log('  已确认，开始擦写（UI 驱动，全走真实设备）…');

  /* ---------- 轮询页面进度 ---------- */
  let stage = '', detail = '', samples = [], lastStage = '';
  let finished = false, failed = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const s = JSON.parse(await evaluate(`JSON.stringify({
      stage: (document.getElementById('prog-stage')||{}).textContent || '',
      detail: (document.getElementById('prog-detail')||{}).textContent || '',
      busy: !!(document.getElementById('btn-cancel') && document.getElementById('btn-cancel').style.display !== 'none'),
      bar: (document.getElementById('bar')||{}).className || ''
    })`));
    stage = s.stage; detail = s.detail;
    if (stage !== lastStage) { samples.push(s.stage + ' | ' + s.detail); lastStage = stage; }
    if (stage.indexOf('失败') === 0) { failed = stage; break; }
    if (!s.busy && stage === '完成') { finished = true; break; }
    await sleep(250);
  }
  const flashMs = Date.now() - tStart;

  console.log('  进度采样（阶段变化点，共 ' + samples.length + '):');
  samples.slice(0, 4).concat(samples.length > 8 ? ['  …'] : []).concat(samples.slice(-4))
    .forEach(l => console.log('    ' + l.slice(0, 110)));

  check('升级流程执行完成（未失败）', !failed, failed || '无错误');
  check('进度条走到 100% 且状态为「完成」', finished, stage + ' / ' + detail);
  console.log('  总耗时 ' + (flashMs / 1000).toFixed(1) + ' s（含擦除+写入+校验+跳转）');

  console.log('\n== 8. 页面日志断言 ==');
  const pageLog = await evaluate('document.getElementById("log").innerText');
  const logLines = pageLog.split('\n').filter(l => l.trim());
  console.log(logLines.slice(-10).map(l => '    ' + l).join('\n'));
  check('日志含「写入 0x08001000」', /写入 0x08001000/.test(pageLog));
  check('日志含「校验通过」', /校验通过/.test(pageLog));
  check('日志含「升级完成」', /升级完成/.test(pageLog));
  check('日志含「跳转到用户代码」', /跳转到用户代码/.test(pageLog));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ui-upgrade-done.png'), Buffer.from(shot.data, 'base64'));

  console.log('\n== 9. 跳转后设备身份（新固件是否真的跑起来） ==');
  let ids = [], cdc = false;
  for (let i = 0; i < 20; i++) {
    ids = await listUsb();
    cdc = ids.indexOf('5740') >= 0;
    if (cdc) break;
    await sleep(400);
  }
  console.log('  当前 ST 设备 PID: ' + (ids.join(', ') || '（无）'));
  check('APP 以 USB CDC 重新枚举（0483:5740）', cdc, cdc ? '已运行' : '未出现 CDC');

  console.log('\n  桥转发控制传输: ' + xferCount + ' 次（其中 ctrlOut ' + ctrlOutCount + ' 次）');
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
