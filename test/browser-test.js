'use strict';
/* =====================================================================
 * 浏览器端到端测试 v2（Edge / WebUSB / 真实 STM32 DFU 设备）
 *
 * 相比 v1 的关键改进：
 *  1. 用「全屏截图 + ink 比例」判断页面是否真的绘制出来了（此前会静默白屏）；
 *  2. 点击选择器改用单进程脚本 click-browser.ps1（前台化+悬停+点击一体化），
 *     避免多次 spawn PowerShell 抢焦点导致选择器关闭；
 *  3. 用 requestDevice 的 Promise 结果（resolved/rejected）判定选择是否生效，
 *     不再依赖像素猜测；
 *  4. 每一步都留全屏截图，失败时能直接看图定位。
 *
 * 只做只读验证（info / getStatus / UPLOAD 读回），不写 Flash、不 leaveDfu。
 * ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ROOTN = path.normalize(ROOT);
const OUT = __dirname;
const PORT = 8765;
const CDP_PORT = 9222;
const PROFILE = path.join(OUT, 'edge-e2e-' + Date.now());
const PROFILE_TAG = path.basename(PROFILE);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PY = 'C:/Users/huang/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
const PS_ARGS = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m[PASS]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  \x1b[31m[FAIL]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  return !!cond;
}
const hex = n => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

function ps(file, args) {
  const r = spawnSync('powershell.exe', PS_ARGS.concat([path.join(OUT, file)], args || []),
    { encoding: 'utf8', timeout: 90000, windowsHide: true });
  return ((r.stdout || '') + (r.stderr ? '\n[stderr] ' + r.stderr.trim() : '')).trim();
}
function py(script, args) {
  const r = spawnSync(PY, [path.join(OUT, script)].concat(args || []),
    { encoding: 'utf8', timeout: 90000, windowsHide: true });
  return ((r.stdout || '') + (r.stderr ? '\n[stderr] ' + r.stderr.trim() : '')).trim();
}
/* 全屏截图（含浏览器 UI）。带新鲜度校验，防止读到旧文件 */
function screenShot(tag) {
  const dump = path.join(OUT, 'screen-dump.png');
  const before = fs.existsSync(dump) ? fs.statSync(dump).mtimeMs : 0;
  const r = ps('screen-shot.ps1');
  const after = fs.existsSync(dump) ? fs.statSync(dump).mtimeMs : 0;
  const dst = path.join(OUT, 'e2e-screen-' + tag + '.png');
  if (after > before) {
    try { fs.copyFileSync(dump, dst); } catch (e) {}
    console.log('  [全屏] ' + tag);
  } else {
    console.log('  [全屏] ' + tag + ' 生成失败: ' + r.split('\n').slice(-2).join(' | '));
    return null;
  }
  return dst;
}
function regionInk(png, box) {
  const out = py('check-region.py', [png].concat(box.map(String)));
  try { return JSON.parse(out.split('\n').pop()); } catch (e) { return null; }
}
function detectChooser(png) {
  const out = py('find-chooser-points.py', [png]);
  try { return JSON.parse(out.split('\n').pop()); } catch (e) { return { ok: false, raw: out.slice(0, 200) }; }
}

process.on('exit', () => {
  try {
    spawnSync('powershell.exe', PS_ARGS.concat([path.join(OUT, 'kill-test-edge.ps1')]),
      { timeout: 30000, windowsHide: true, stdio: 'ignore' });
  } catch (e) {}
});

/* ---------- 静态服务器 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if ((file !== ROOTN && !file.startsWith(ROOTN + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const st = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
  fs.createReadStream(file).pipe(res);
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
  });
}
function onEvent(m, fn) { (evHandlers[m] = evHandlers[m] || []).push(fn); }
async function evaluate(expr, userGesture) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: !!userGesture
  });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function pageShot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('  [视口] ' + name);
}

(async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log('HTTP: http://127.0.0.1:' + PORT);

  console.log('\n== 1. 启动 Edge ==');
  console.log('  ' + ps('kill-test-edge.ps1').split('\n').join('\n  '));
  await sleep(700);

  /* 预置 Preferences：抑制「同步浏览数据」首启弹窗（它会遮挡选择器） */
  try {
    const defDir = path.join(PROFILE, 'Default');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(path.join(defDir, 'Preferences'), JSON.stringify({
      sync_promo: { show_on_first_run_allowed: false, user_skipped: true },
      signin: { allowed: false, allowed_on_next_startup: false },
      browser: { has_seen_welcome_page: true, check_default_browser: false },
      profile: { exit_type: 'Normal', exited_cleanly: true }
    }));
    console.log('  已写入首启抑制 Preferences');
  } catch (e) { console.log('  Preferences 写入失败: ' + e.message); }

  spawn(EDGE, [
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check',
    '--disable-session-crashed-bubble', '--disable-infobars',
    '--disable-sync', '--no-service-autorun',
    '--window-position=0,0', '--window-size=1600,1000',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  console.log('  profile=' + PROFILE_TAG);

  let targets = null;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
      targets = await r.json();
      if (targets.some(t => t.type === 'page')) break;
    } catch (e) {}
    await sleep(300);
  }
  if (!targets) { console.error('  CDP 未就绪'); process.exit(1); }
  const page = targets.find(t => t.type === 'page');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
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

  /* 窗口矩形（用于计算页面内容区，做「已绘制」判定） */
  let rect = null;
  try {
    const wi = JSON.parse(ps('win-info.ps1', ['-ProfileTag', PROFILE_TAG]) || 'null');
    if (wi && Array.isArray(wi.rect) && wi.rect[2] - wi.rect[0] > 400 && wi.rect[3] - wi.rect[1] > 300) {
      rect = { l: wi.rect[0], t: wi.rect[1], r: wi.rect[2], b: wi.rect[3] };
    }
  } catch (e) {}
  console.log('  窗口矩形: ' + JSON.stringify(rect));

  console.log('\n== 2. 打开工具页面 ==');
  const loadOk = new Promise(res => onEvent('Page.loadEventFired', res));
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
  await Promise.race([loadOk, sleep(15000)]);
  await sleep(1200);
  let domOk = false;
  for (let i = 0; i < 30; i++) {
    try {
      if (await evaluate('document.readyState === "complete" && !!document.getElementById("btn-connect")')) { domOk = true; break; }
    } catch (e) {}
    await sleep(300);
  }
  if (!domOk) { console.error('  页面 DOM 未就绪'); process.exit(1); }
  console.log('  标题: ' + (await evaluate('document.title')));
  check('WebUSB 可用', await evaluate('!!navigator.usb'));

  /* 关键保护：页面是否真的绘制出来了 */
  await sleep(800);
  let painted = false, ink = 0;
  const inkBox = rect
    ? [rect.l + 80, rect.t + 170, rect.r - 80, rect.b - 80]
    : [120, 220, 1500, 900];   // 兜底：Edge 窗口固定在 (0,0) 1600x1000
  for (let attempt = 0; attempt < 6 && !painted; attempt++) {
    const shot = screenShot('0-page' + (attempt ? '-r' + attempt : ''));
    if (shot) {
      const r = regionInk(shot, inkBox);
      if (r) { ink = r.ink; painted = ink > 0.004; console.log('    内容区 ' + JSON.stringify(inkBox) + ' ink=' + ink + (painted ? ' （已绘制）' : ' （疑似白屏）')); }
      else console.log('    区域检测失败');
    }
    if (!painted) { ps('foreground.ps1', ['-ProfileTag', PROFILE_TAG]); await sleep(900); }
  }
  check('页面已实际绘制（非白屏）', painted, 'ink=' + ink);
  await pageShot('e2e-1-page.png');

  console.log('\n== 3. 记录 requestDevice 结果 ==');
  await evaluate(`
    window.__reqLog = [];
    (function(){
      var orig = navigator.usb.requestDevice.bind(navigator.usb);
      navigator.usb.requestDevice = function(f) {
        window.__reqLog.push({ ev: 'called', filters: JSON.stringify(f || null) });
        return orig(f).then(function(d) {
          window.__reqLog.push({ ev: 'resolved', name: d && d.productName, serial: d && d.serialNumber });
          return d;
        }, function(err) {
          window.__reqLog.push({ ev: 'rejected', name: err && err.name, msg: err && err.message });
          throw err;
        });
      };
    })();
    'ok'
  `);

  console.log('\n== 4. 注入深色遮罩（让白色选择器气泡与页面形成高对比） ==');
  /* WebUSB 选择器是浏览器 UI，不会调暗页面；页面本身是白底，白气泡在白底上无法用像素定位。
     给页面注入一层不接收事件的深色遮罩即可（选择器在页面之上，不受影响）。 */
  await evaluate(`(function(){
    var d = document.getElementById('__testdim');
    if (!d) {
      d = document.createElement('div');
      d.id = '__testdim';
      d.style.cssText = 'position:fixed;inset:0;background:#3C3C3C;z-index:2147483647;pointer-events:none';
      document.documentElement.appendChild(d);
    }
    return 'ok';
  })()`);
  await sleep(400);

  console.log('\n== 5. 点击「连接设备」打开选择器 ==');
  const btn = JSON.parse(await evaluate(`(function(){
    var b = document.getElementById('btn-connect');
    b.scrollIntoView({block:'nearest'});
    var q = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(q.x + q.width/2), y: Math.round(q.y + q.height/2), text: b.textContent.trim() });
  })()`));
  console.log('  按钮「' + btn.text + '」@ 视口 ' + btn.x + ',' + btn.y);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
  await sleep(150);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(70);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', buttons: 0, clickCount: 1 });
  console.log('  已点击，等待选择器...');
  await sleep(2000);

  console.log('\n== 6. 定位选择器气泡 ==');
  let shot = screenShot('1-chooser');
  let pts = shot ? detectChooser(shot) : { ok: false };
  console.log('  检测: ' + JSON.stringify(pts).slice(0, 260));
  if (!pts.ok) {
    console.log('  未识别到选择器，重试点击一次...');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(2200);
    shot = screenShot('1b-chooser');
    pts = shot ? detectChooser(shot) : { ok: false };
    console.log('  检测(2): ' + JSON.stringify(pts).slice(0, 260));
  }
  const hasChooser = check('WebUSB 选择器已弹出并被识别', pts.ok,
    pts.ok ? ('气泡 ' + JSON.stringify(pts.bubble) + ' 设备行 ' + JSON.stringify(pts.device)) : '');
  if (!hasChooser) {
    const lg = await evaluate('document.getElementById("log").innerText').catch(() => '');
    console.log('  页面日志:\n' + lg.split('\n').slice(-8).map(l => '    ' + l).join('\n'));
    throw new Error('选择器未出现');
  }

  console.log('\n== 7. 点击设备名（选中设备）==');
  let selected = false;
  const tries = [
    [pts.device[0], pts.device[1], '设备名中心'],
    [pts.bubble[0] + 50, pts.device[1], '设备图标区'],
    [(pts.bubble[0] + (pts.bubble[0] + pts.bubble[2])) >> 1, pts.device[1] + 18, '整行中心']
  ];
  for (const [cx, cy, tag] of tries) {
    console.log('  尝试 ' + tag + ' @' + cx + ',' + cy);
    console.log('    ' + ps('click-browser.ps1', ['-X', String(cx), '-Y', String(cy), '-ProfileTag', PROFILE_TAG]));
    await sleep(900);
    const log = JSON.parse(await evaluate('window.__reqLog'));
    const done = log.find(x => x.ev === 'resolved' || x.ev === 'rejected');
    if (done) {
      console.log('    requestDevice -> ' + JSON.stringify(done));
      if (done.ev === 'resolved') { selected = true; break; }
      // 被取消（选了又点掉）则重新打开选择器
    }
  }
  check('选择器内选中设备（requestDevice 已 resolve）', selected);
  if (!selected) {
    screenShot('2-fail');
    const log = JSON.parse(await evaluate('window.__reqLog'));
    console.log('  reqLog: ' + JSON.stringify(log));
    throw new Error('设备未被选中');
  }
  /* 移除遮罩，恢复页面正常观感 */
  await evaluate("(function(){var d=document.getElementById('__testdim');if(d)d.remove();return 'ok';})()");

  console.log('\n== 8. 点击「连接」按钮（若需要）==');
  /* 部分浏览器在点设备后仍需点「连接」确认 */
  await sleep(1200);
  let connTxt = '';
  let connected = false;
  for (let i = 0; i < 20; i++) {
    connTxt = await evaluate('(document.getElementById("conn-text")||{}).textContent || ""');
    if (connTxt.indexOf('已连接') >= 0) { connected = true; break; }
    await sleep(400);
  }
  if (!connected && pts.connect) {
    console.log('  尚未连接，点击「连接」@' + pts.connect.join(','));
    console.log('    ' + ps('click-browser.ps1', ['-X', String(pts.connect[0]), '-Y', String(pts.connect[1]), '-ProfileTag', PROFILE_TAG]));
    await sleep(1500);
    for (let i = 0; i < 20; i++) {
      connTxt = await evaluate('(document.getElementById("conn-text")||{}).textContent || ""');
      if (connTxt.indexOf('已连接') >= 0) { connected = true; break; }
      await sleep(400);
    }
  }
  check('页面 UI 显示已连接', connected, (connTxt || '').trim());
  if (!connected) {
    const lg = await evaluate('document.getElementById("log").innerText').catch(() => '');
    console.log('  页面日志:\n' + lg.split('\n').slice(-10).map(l => '    ' + l).join('\n'));
    throw new Error('连接未完成');
  }
  await pageShot('e2e-2-connected.png');
  screenShot('3-connected');

  console.log('\n== 9. 页面内协议验证（__dfuTest） ==');
  const info = JSON.parse(await evaluate('(async () => JSON.stringify(await window.__dfuTest.info()))()'));
  console.log('  设备: ' + info.product + ' / ' + info.manufacturer);
  console.log('  VID:PID = ' + info.vid.toString(16).padStart(4, '0') + ':' + info.pid.toString(16).padStart(4, '0') +
    '  序列号=' + info.serial);
  console.log('  wTransferSize=' + info.xferSize + '  bcdDFU=0x' + info.dfuVersion.toString(16));
  console.log('  布局: ' + info.layoutRaw);
  check('设备信息读取（产品名/序列号）', !!info.serial && !!info.product, info.serial);
  check('wTransferSize 有效', info.xferSize >= 64, info.xferSize + ' B');
  check('内存布局已解析', Array.isArray(info.layout) && info.layout.length > 0,

    JSON.stringify((info.layout || []).map(s => s.name + '@' + hex(s.base))));

  const st = JSON.parse(await evaluate('(async () => JSON.stringify(await window.__dfuTest.getStatus()))()'));
  console.log('  GETSTATUS: bStatus=' + st.status + ' bState=' + st.state + ' poll=' + st.pollTimeout);
  check('GETSTATUS 返回有效状态', typeof st.state === 'number', 'state=' + st.state);

  const seg = (info.layout || [])[0];
  const addr = seg ? seg.base : 0x08000000;
  const t0 = Date.now();
  const b64 = await evaluate('(async () => await window.__dfuTest.upload(' + addr + ', 512))()');
  const buf = Buffer.from(b64, 'base64');
  console.log('  UPLOAD 512B @' + hex(addr) + ' 耗时 ' + (Date.now() - t0) + ' ms -> ' + buf.length + ' B');
  check('页面内 UPLOAD 512B 长度正确', buf.length === 512, buf.length + ' B');

  const sp = buf.readUInt32LE(0), rv = buf.readUInt32LE(4);
  const spOk = sp >= 0x20000000 && sp <= 0x20020000;
  const rvOk = (rv & 1) === 1;
  console.log('  向量表: SP=' + hex(sp) + (spOk ? ' ✓' : ' ✗') + '  Reset=' + hex(rv) + (rvOk ? ' ✓' : ' ✗'));
  check('读回内容为有效向量表', spOk && rvOk, 'SP=' + hex(sp) + ' Reset=' + hex(rv));

  const b64b = await evaluate('(async () => await window.__dfuTest.upload(' + addr + ', 512))()');
  check('重复读回一致（确定性）', b64 === b64b);

  const t1 = Date.now();
  const b64m = await evaluate('(async () => await window.__dfuTest.upload(' + addr + ', 8192))()');
  const bufm = Buffer.from(b64m, 'base64');
  check('页面内 UPLOAD 8192B（多块）', bufm.length === 8192, bufm.length + ' B, ' + (Date.now() - t1) + ' ms');

  const pageLog = await evaluate('document.getElementById("log").innerText');
  console.log('\n  页面日志（末 8 行）:\n' + pageLog.split('\n').slice(-8).map(l => '    ' + l).join('\n'));
  await pageShot('e2e-3-tested.png');
  screenShot('4-tested');

  console.log('\n' + '='.repeat(72));
  console.log(' 结果: ' + pass + ' 通过 / ' + fail + ' 失败 / ' + (pass + fail) + ' 项');
  console.log('='.repeat(72));
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n[中断] ' + e.message);
  try { server.close(); } catch (e2) {}
  process.exit(1);
});
