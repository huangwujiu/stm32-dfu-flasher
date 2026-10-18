'use strict';
/* =====================================================================
 * 起始地址 / 擦除计划的页面级验证（不需要硬件）
 *
 * 用一个只有内存布局的假设备（__dfuUI.setFakeDev）驱动真实页面逻辑：
 *   1. .bin 默认起始地址取自设备描述符的可写区起点
 *   2. HEX 的起始地址取自文件本身，不被描述符覆盖
 *   3. 改起始地址 = 整个镜像整体平移（多段一起偏移，相对间距不变）
 *   4. 落在声明范围外的地址：先补擦除页再写入（不再「地址对但烧录失败」）
 *   5. RAM 区间不补擦除页
 *
 * 用法：node test/addr-ui-test.js
 * ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', 'release');
const ROOTN = path.normalize(ROOT);
const OUT = __dirname;
const PORT = 8793;
const CDP_PORT = 9243;
const PROFILE = path.join(OUT, 'edge-addr-' + Date.now());
const EDGE = process.argv[2] || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m[PASS]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  \x1b[31m[FAIL]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  return !!cond;
}
function section(t) { console.log('\n== ' + t + ' =='); }

process.on('exit', () => {
  try {
    spawnSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File',
      path.join(OUT, 'kill-test-edge.ps1')], { timeout: 30000, windowsHide: true, stdio: 'ignore' });
  } catch (e) {}
});

/* ---------- 静态服务 ---------- */
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
const pageErrors = [];
const consoleErrors = [];

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 40000);
  });
}
function onEvent(m, fn) { (evHandlers[m] = evHandlers[m] || []).push(fn); }
async function evalRaw(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    return { ok: false, error: (d.exception && d.exception.description) || d.text, value: null };
  }
  return { ok: true, value: r.result.value, error: null };
}
async function evaluate(expr) {
  const r = await evalRaw(expr);
  if (!r.ok) throw new Error('页面异常: ' + String(r.error).slice(0, 300));
  return r.value;
}
async function waitFor(expr, timeoutMs) {
  const end = Date.now() + (timeoutMs || 10000);
  while (Date.now() < end) {
    const r = await evalRaw(expr);
    if (r.ok && r.value) return true;
    await sleep(200);
  }
  return false;
}
/* 造一个 Intel HEX：从 addr 起放 len 字节 */
const HEX_BUILDER = `(function (addr, len, fill) {
  function rec(type, a, data) {
    var b = [data.length, (a >> 8) & 0xff, a & 0xff, type].concat(data);
    var sum = 0; for (var i = 0; i < b.length; i++) sum += b[i];
    var chk = (0x100 - (sum & 0xff)) & 0xff;
    return ':' + b.concat([chk]).map(function (x) {
      return ('0' + x.toString(16)).slice(-2).toUpperCase(); }).join('');
  }
  var up = Math.floor(addr / 0x10000), lo = addr % 0x10000;
  var out = rec(4, 0, [(up >> 8) & 0xff, up & 0xff]) + '\\n';
  var off = 0;
  while (off < len) {
    var n = Math.min(16, len - off);
    var d = []; for (var i = 0; i < n; i++) d.push((fill + off + i) & 0xff);
    out += rec(0, lo + off, d) + '\\n';
    off += n;
  }
  return out + rec(1, 0, []) + '\\n';
})`;
/* 用 DataTransfer 把文件塞进 #file-input 并派发 change */
function loadPageFile(name, text, isBin) {
  var b64 = isBin ? text : btoa(unescape(encodeURIComponent(text)));
  return evaluate(
    '(async function () {' +
    '  var bytes = Uint8Array.from(atob(' + JSON.stringify(b64) + '), function (c) { return c.charCodeAt(0); });' +
    '  var dt = new DataTransfer();' +
    '  dt.items.add(new File([bytes], ' + JSON.stringify(name) + '));' +
    '  var i = document.getElementById("file-input");' +
    '  i.files = dt.files;' +
    '  i.dispatchEvent(new Event("change"));' +
    '  return true;' +
    '})()');
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    console.error('release/index.html 不存在'); process.exit(2);
  }
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log('HTTP: http://127.0.0.1:' + PORT + '  (serve ' + ROOT + ')');

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
    '--window-position=0,0', '--window-size=1500,980', 'about:blank'],
    { stdio: 'ignore', windowsHide: true });

  let targets = null;
  for (let i = 0; i < 60; i++) {
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
  await send('Log.enable');
  onEvent('Runtime.exceptionThrown', p => {
    pageErrors.push((p.exceptionDetails && p.exceptionDetails.text) || 'unknown');
  });
  onEvent('Log.entryAdded', p => {
    if (p.entry && p.entry.level === 'error') consoleErrors.push(p.entry.text || '');
  });
  onEvent('Runtime.consoleAPICalled', p => {
    if (p.type === 'error') consoleErrors.push((p.args || []).map(a => a.value || a.description || '').join(' '));
  });

  console.log('\n== 1. 打开页面 ==');
  const loadOk = new Promise(res => onEvent('Page.loadEventFired', res));
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
  await Promise.race([loadOk, sleep(20000)]);
  const domState = await evaluate(
    'JSON.stringify({rs: document.readyState, addr: !!document.getElementById("fw-addr"),' +
    'ui: typeof window.__dfuUI, test: typeof window.__dfuTest, err: window.__pageError || ""})');
  console.log('    DOM 状态: ' + domState);
  if (pageErrors.length) console.log('    页面异常: ' + pageErrors.join(' | ').slice(0, 300));
  check('页面加载完成、DOM 就绪',
    await waitFor('document.readyState === "complete" && !!document.getElementById("fw-addr")', 15000),
    await evaluate('document.title'));

  /* 注入真实设备的描述符（不碰硬件） */
  const LAYOUT = '@Internal Flash   /0x08001000/92*001Kg,32*001Ka';
  section('2. .bin 默认起始地址来自描述符');
  const wrs = await evaluate('JSON.stringify(window.__dfuUI.setFakeDev(' + JSON.stringify(LAYOUT) + '))');
  check('假设备注入后可写区为 0x08001000-0x08017FFF',
    wrs === JSON.stringify([{ addr: 0x08001000, end: 0x08018000, name: 'Internal Flash', label: '可读写' }]),
    wrs);
  const addr0 = await evaluate('document.getElementById("fw-addr").value');
  check('地址框默认 0x08001000', addr0 === '0x08001000', String(addr0));

  await loadPageFile('probe.bin', btoa(String.fromCharCode.apply(null, new Array(1024).fill(0x5A))), true);
  await sleep(500);
  const binSeg = await evaluate('String(window.__dfuUI.getFw().segments[0].addr)');
  check('.bin 落在 0x08001000', binSeg === String(0x08001000), binSeg);
  const binWarn = await evaluate('document.getElementById("fw-warn").textContent || ""');
  check('.bin 提示「在可写区内」', /在设备声明的可写区内/.test(binWarn), binWarn);

  section('3. HEX 起始地址取自文件，不被描述符覆盖');
  const hexTxt = await evaluate(HEX_BUILDER + '(0x08000400, 64, 0x11)');
  await loadPageFile('probe.hex', hexTxt, false);
  await sleep(500);
  const hexAddr = await evaluate('document.getElementById("fw-addr").value');
  check('HEX 地址框显示文件里的 0x08000400', hexAddr === '0x08000400', String(hexAddr));
  const hexSeg = await evaluate('String(window.__dfuUI.getFw().segments[0].addr)');
  check('HEX 数据段落在 0x08000400', hexSeg === String(0x08000400), hexSeg);
  const hexWarn = await evaluate('document.getElementById("fw-warn").textContent || ""');
  check('0x08000400 提示不在布局内', /不在设备声明的内存布局/.test(hexWarn), hexWarn);

  section('3b. ELF 段首全零填充与 HEX 对齐');
  const elfB64 = await evaluate(
    '(function () {' +
    '  var data = new Uint8Array(0x800);' +            // 前 0x400 全零，后面是有效数据
    '  for (var i = 0x400; i < 0x800; i++) data[i] = 0xC0 + (i & 0x0f);' +
    '  var EH = 52, PH = 32, total = EH + PH + data.length;' +
    '  var b = new Uint8Array(total), d = new DataView(b.buffer);' +
    '  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0], 0);' +
    '  d.setUint16(16, 2, true); d.setUint16(18, 40, true); d.setUint32(20, 1, true);' +
    '  d.setUint32(24, 0x08000401, true); d.setUint32(28, EH, true);' +
    '  d.setUint16(40, EH, true); d.setUint16(42, PH, true); d.setUint16(44, 1, true);' +
    '  d.setUint32(EH + 0, 1, true); d.setUint32(EH + 4, EH + PH, true);' +
    '  d.setUint32(EH + 8, 0x08000000, true); d.setUint32(EH + 12, 0x08000000, true);' +
    '  d.setUint32(EH + 16, data.length, true); d.setUint32(EH + 20, data.length, true);' +
    '  d.setUint32(EH + 24, 5, true); d.setUint32(EH + 28, 4, true);' +
    '  b.set(data, EH + PH);' +
    '  var s = ""; for (var i = 0; i < b.length; i += 0x8000)' +
    '    s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));' +
    '  return btoa(s);' +
    '})()');
  await loadPageFile('probe.elf', elfB64, true);
  await sleep(600);
  const elfAddr = await evaluate('document.getElementById("fw-addr").value');
  check('ELF 段首全零被跳过，起始地址 0x08000400（与 HEX 一致）', elfAddr === '0x08000400', String(elfAddr));
  const elfLog = await evaluate('document.getElementById("log").innerText');
  check('日志说明跳过了多少全零字节', /跳过段首 1024 字节全零填充/.test(elfLog), '');

  section('4. 改起始地址 = 整体平移');
  const shifted = await evaluate('JSON.stringify(window.__dfuTest.shiftFw("0x08001000"))');
  check('整体平移到 0x08001000', shifted === JSON.stringify([0x08001000]), shifted);
  const warnAfter = await evaluate('document.getElementById("fw-warn").textContent || ""');
  check('平移后提示「在可写区内」', /在设备声明的可写区内/.test(warnAfter), warnAfter);

  /* 再造一个两段 HEX（中间有空洞），验证段间距在平移后不变 */
  const twoSeg = await evaluate(
    '(function () {' +
    '  function rec(type, a, data) {' +
    '    var b = [data.length, (a >> 8) & 0xff, a & 0xff, type].concat(data);' +
    '    var sum = 0; for (var i = 0; i < b.length; i++) sum += b[i];' +
    '    var chk = (0x100 - (sum & 0xff)) & 0xff;' +
    '    return ":" + b.concat([chk]).map(function (x) {' +
    '      return ("0" + x.toString(16)).slice(-2).toUpperCase(); }).join("");' +
    '  }' +
    '  var chunks = [[0x08000400, 16, 0x11], [0x08000800, 16, 0x22]];' +
    '  var out = rec(4, 0, [0x08, 0x00]) + "\\n";' +
    '  for (var c = 0; c < chunks.length; c++) {' +
    '    var a = chunks[c][0], n = chunks[c][1], f = chunks[c][2];' +
    '    var d = []; for (var i = 0; i < n; i++) d.push((f + i) & 0xff);' +
    '    out += rec(0, a % 0x10000, d) + "\\n";' +
    '  }' +
    '  return out + rec(1, 0, []) + "\\n";' +
    '})()');
  await loadPageFile('gap.hex', twoSeg, false);
  await sleep(500);
  const twoAddr = await evaluate('JSON.stringify(window.__dfuUI.getFw().segments.map(function (s) { return s.addr; }))');
  check('两段 HEX 保持 0x08000400 / 0x08000800 的段间距',
    twoAddr === JSON.stringify([0x08000400, 0x08000800]), twoAddr);
  const twoShift = await evaluate('JSON.stringify(window.__dfuTest.shiftFw("0x08001000"))');
  check('整体平移后段间距不变（0x08001000 / 0x08001400）',
    twoShift === JSON.stringify([0x08001000, 0x08001400]), twoShift);

  section('5. 声明范围外的地址也要先擦除');
  const plan = JSON.parse(await evaluate('JSON.stringify(window.__dfuTest.erasePlan(0x08000400, 4096))'));
  check('0x08000400 起 4KB 补擦 0x08000400/08000800/08000C00 + 声明页 0x08001000',
    plan.pages.length === 4 && plan.pages[0] === 0x08000400 && plan.pages[3] === 0x08001000,
    JSON.stringify(plan.pages));
  check('未声明区间被单独标出', plan.undeclared.length === 1, JSON.stringify(plan.undeclared));
  check('最小擦除粒度为 1024B',
    await evaluate('window.__dfuTest.minEraseUnit()') === 1024, '');
  const ramPlan = JSON.parse(await evaluate('JSON.stringify(window.__dfuTest.erasePlan(0x20000000, 256))'));
  check('RAM 区间不补擦除页', ramPlan.pages.length === 0, JSON.stringify(ramPlan.pages));

  section('6. 界面截图');
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'addr-ui.png'), Buffer.from(shot.data, 'base64'));
  check('界面截图已保存', fs.existsSync(path.join(OUT, 'addr-ui.png')), 'test/addr-ui.png');

  section('7. 控制台健康度');
  check('无未捕获的页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));
  const realErrors = consoleErrors.filter(t => !/favicon|net::ERR_|Failed to load resource/i.test(t));
  check('无控制台报错', realErrors.length === 0, realErrors.join(' | ').slice(0, 300));

  console.log('\n========================================');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试异常: ' + (e && e.stack || e)); server.close(); process.exit(1); });
