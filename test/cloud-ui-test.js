'use strict';
/* =====================================================================
 * 云服务接入的页面级验证（不需要硬件、不发送任何短信）
 *
 * 覆盖：
 *   1. SDK 从 CDN 加载成功、云服务客户端能用 publicConfig 初始化
 *   2. 未登录态的 UI 渲染（顶栏账号胶囊 / 记录列表 / 固件库 / 按钮禁用）
 *   3. 登录框的输入校验与「先取码再登录」流程（全部在本地拦下，不发请求）
 *   4. 未登录时访问数据库的真实返回（错误必须被清晰呈现，不能静默成功）
 *   5. 未登录时 afterFlash 静默跳过，不影响烧写主流程
 *   6. 全程无未捕获 JS 异常
 *
 * 用法：
 *   node test/cloud-ui-test.js                                  # 测 release/ 里的本地构建
 *   CLOUD_TEST_URL=https://.../index.html node test/cloud-ui-test.js   # 测线上域名
 * ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', 'release');
const ROOTN = path.normalize(ROOT);
const OUT = __dirname;
const PORT = 8791;
const CDP_PORT = 9241;
const PROFILE = path.join(OUT, 'edge-cloud-' + Date.now());
const EDGE = process.argv[2] || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const LIVE_URL = process.env.CLOUD_TEST_URL || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m[PASS]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  \x1b[31m[FAIL]\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  return !!cond;
}

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
const consoleErrors = [];
const pageErrors = [];

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 40000);
  });
}
function onEvent(m, fn) { (evHandlers[m] = evHandlers[m] || []).push(fn); }

/* 执行页面表达式；异常不算致命，返回 {ok, value, error} */
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

async function main() {
  const targetUrl = LIVE_URL || ('http://127.0.0.1:' + PORT + '/index.html');
  if (!LIVE_URL) {
    if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
      console.error('release/index.html 不存在'); process.exit(2);
    }
    await new Promise(r => server.listen(PORT, '127.0.0.1', r));
    console.log('HTTP: http://127.0.0.1:' + PORT + '  (serve ' + ROOT + ')');
  } else {
    console.log('HTTP: (线上) ' + targetUrl);
  }

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
    if (p.type === 'error') {
      consoleErrors.push((p.args || []).map(a => a.value || a.description || '').join(' '));
    }
  });

  console.log('\n== 1. 打开页面 ==');
  const loadOk = new Promise(res => onEvent('Page.loadEventFired', res));
  await send('Page.navigate', { url: targetUrl });
  await Promise.race([loadOk, sleep(20000)]);
  const domReady = await waitFor('document.readyState === "complete" && !!document.getElementById("rec-list")', 15000);
  check('页面加载完成', domReady, await evaluate('document.title'));

  console.log('\n== 2. 云服务 SDK 与客户端 ==');
  const sdkLoaded = await waitFor('typeof WorkBuddyCloud !== "undefined" && typeof WorkBuddyCloud.createWorkBuddyCloud === "function"', 15000);
  check('云端 SDK 从 CDN 加载成功', sdkLoaded);

  const cfgOk = await evaluate(
    'PUBLIC_CONFIG && /^https:\\/\\//.test(PUBLIC_CONFIG.endpoint) && ' +
    '/^wbpk_/.test(PUBLIC_CONFIG.publishableKey) && !!PUBLIC_CONFIG.oauthRelayBaseUrl');
  check('publicConfig 三要素齐备（endpoint / publishableKey / oauthRelayBaseUrl）', cfgOk);

  const clientOk = await evalRaw(
    'WORKBUDDY_TEST = WorkBuddyCloud.createWorkBuddyCloud({' +
    '  endpoint: PUBLIC_CONFIG.endpoint,' +
    '  oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,' +
    '  publishableKey: PUBLIC_CONFIG.publishableKey' +
    '}); typeof WORKBUDDY_TEST.database.from === "function" && typeof WORKBUDDY_TEST.auth.sendOtp === "function" && typeof WORKBUDDY_TEST.storage.upload === "function"');
  check('客户端可初始化且 database / auth / storage 三个模块就位', clientOk.ok && clientOk.value, clientOk.error || '');

  check('页面云服务模块已启动', await evaluate('!!window.CloudApi && typeof window.CloudApi.afterFlash === "function"'));

  console.log('\n== 3. 未登录态 UI ==');
  const pillText = await evaluate('document.getElementById("user-name").textContent');
  check('顶栏显示未登录云服务', /未登录/.test(pillText), pillText);
  check('登录按钮可见 / 退出按钮隐藏',
    await evaluate('getComputedStyle(document.getElementById("btn-login")).display !== "none" && getComputedStyle(document.getElementById("btn-logout")).display === "none"'));
  const recEmpty = await evaluate('document.getElementById("rec-list").textContent.trim()');
  check('升级记录区给出登录引导', /登录/.test(recEmpty), recEmpty.slice(0, 40));
  const libEmpty = await evaluate('document.getElementById("lib-list").textContent.trim()');
  check('固件库区给出登录引导', /登录/.test(libEmpty), libEmpty.slice(0, 40));
  check('未登录时记录/上传按钮为禁用',
    await evaluate('document.getElementById("btn-rec-refresh").disabled && document.getElementById("btn-lib-upload").disabled && document.getElementById("btn-rec-next").disabled'));

  console.log('\n== 4. 云数据库的真实往返（匿名身份） ==');
  const probe = await evalRaw(
    '(async () => {' +
    '  const r = await WORKBUDDY_TEST.database.from("flash_records").select("id").limit(1);' +
    '  return JSON.stringify({ hasError: !!r.error, dataLen: (r.data || []).length,' +
    '    code: r.error && r.error.code, message: r.error && r.error.message });' +
    '})()');
  let probeObj = { hasError: null, message: '', dataLen: null };
  if (probe.ok && probe.value) { try { probeObj = JSON.parse(probe.value); } catch (e) {} }
  check('请求真的到达数据平面（endpoint / publishableKey 生效）', probe.ok && probeObj.hasError === false,
    probe.ok ? ('rows=' + probeObj.dataLen) : String(probe.error).slice(0, 160));
  check('匿名身份被 RLS 过滤为 0 行（看不到任何人的记录）',
    probe.ok && probeObj.hasError === false && probeObj.dataLen === 0);

  const writeProbe = await evalRaw(
    '(async () => {' +
    '  const r = await WORKBUDDY_TEST.database.from("flash_records").insert({' +
    '    firmware_name: "anon-probe", firmware_size: 1 }).select();' +
    '  return JSON.stringify({ hasError: !!r.error, code: r.error && r.error.code,' +
    '    message: r.error && r.error.message });' +
    '})()');
  let writeObj = { hasError: null, message: '' };
  if (writeProbe.ok && writeProbe.value) { try { writeObj = JSON.parse(writeProbe.value); } catch (e) {} }
  check('匿名身份写入被拒绝（owner_id 伪造不了）', writeProbe.ok && writeObj.hasError === true,
    writeProbe.ok ? String(writeObj.message || writeObj.code).slice(0, 120) : String(writeProbe.error).slice(0, 120));

  const sharedProbe = await evalRaw(
    '(async () => {' +
    '  const r = await WORKBUDDY_TEST.database.from("firmware_library").select("id").limit(1);' +
    '  return JSON.stringify({ hasError: !!r.error, code: r.error && r.error.code,' +
    '    message: r.error && r.error.message, dataLen: (r.data || []).length });' +
    '})()');
  let sharedObj = { hasError: null, message: '' };
  if (sharedProbe.ok && sharedProbe.value) { try { sharedObj = JSON.parse(sharedProbe.value); } catch (e) {} }
  check('团队固件库对未登录者不可见（无 anon 策略 → 0 行）',
    sharedProbe.ok && (sharedObj.hasError === true || sharedObj.dataLen === 0),
    sharedProbe.ok ? (sharedObj.hasError ? String(sharedObj.message).slice(0, 100) : ('rows=' + sharedObj.dataLen)) : String(sharedProbe.error).slice(0, 120));

  console.log('\n== 5. 登录框校验（不发任何请求） ==');
  await evaluate('document.getElementById("btn-login").click()');
  check('点击登录打开登录框', await waitFor('document.getElementById("login-mask").classList.contains("show")', 5000));
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'cloud-login.png'), Buffer.from(shot2.data, 'base64'));

  await evaluate('document.getElementById("login-phone").value = "1380013800"');
  await evaluate('document.getElementById("btn-send-code").click()');
  const msg1 = await waitFor('document.getElementById("login-msg").style.display === "block"', 4000)
    ? await evaluate('document.getElementById("login-msg").textContent') : '';
  check('10 位手机号被本地拦下', /11 位手机号/.test(msg1), msg1);
  check('未发码时发送按钮仍可点（无冷却）', await evaluate('!document.getElementById("btn-send-code").disabled'));

  await evaluate('document.getElementById("login-phone").value = "13800138000"');
  await evaluate('document.getElementById("login-code").value = "123456"');
  await evaluate('document.getElementById("login-ok").click()');
  const msg2 = await waitFor('document.getElementById("login-msg").style.display === "block"', 4000)
    ? await evaluate('document.getElementById("login-msg").textContent') : '';
  check('未取码直接登录被拦下并提示先获取验证码', /先获取|验证码/.test(msg2), msg2);

  await evaluate('document.getElementById("tab-email").click()');
  check('切换到邮箱后输入框正确切换',
    await evaluate('getComputedStyle(document.getElementById("field-email")).display !== "none" && ' +
      'getComputedStyle(document.getElementById("field-phone")).display === "none" && ' +
      'document.getElementById("tab-email").className.indexOf("on") >= 0'));

  await evaluate('document.getElementById("login-email").value = "not-an-email";');
  await evaluate('document.getElementById("btn-send-code").click()');
  const msg3 = await waitFor('document.getElementById("login-msg").style.display === "block"', 4000)
    ? await evaluate('document.getElementById("login-msg").textContent') : '';
  check('非法邮箱被本地拦下（不会发请求）', /邮箱地址/.test(msg3), msg3);

  await evaluate('document.getElementById("login-email").value = "engineer@example.com";');
  await evaluate('document.getElementById("login-code").value = "123456";');
  await evaluate('document.getElementById("login-ok").click()');
  const msg4 = await waitFor('document.getElementById("login-msg").style.display === "block"', 4000)
    ? await evaluate('document.getElementById("login-msg").textContent') : '';
  check('邮箱未取码直接登录被拦下', /先获取/.test(msg4), msg4);
  await evaluate('document.getElementById("tab-phone").click()');

  await evaluate('document.getElementById("login-cancel").click()');
  check('取消可关闭登录框', await waitFor('!document.getElementById("login-mask").classList.contains("show")', 4000));

  console.log('\n== 6. 未登录时烧写主流程不受影响 ==');
  const afterFlash = await evalRaw('window.CloudApi.afterFlash({ ok: true, fw: null }); true');
  check('未登录调用记录钩子静默跳过、不抛异常', afterFlash.ok, afterFlash.error || '');
  check('烧写按钮逻辑仍在（无设备时禁用）', await evaluate('document.getElementById("btn-flash").disabled === true'));

  console.log('\n== 7. 界面截图 ==');
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'cloud-ui.png'), Buffer.from(shot.data, 'base64'));
  check('界面截图已保存', fs.existsSync(path.join(OUT, 'cloud-ui.png')), 'test/cloud-ui.png');

  console.log('\n== 8. 控制台健康度 ==');  const hardErrors = pageErrors.slice();
  check('无未捕获的页面异常', hardErrors.length === 0, hardErrors.join(' | ').slice(0, 200));
  const realErrors = consoleErrors.filter(t =>
    !/favicon|net::ERR_|Failed to load resource/i.test(t));
  check('无云服务相关的控制台报错', realErrors.length === 0, realErrors.join(' | ').slice(0, 300));

  console.log('\n========================================');
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (probeObj.message) console.log('（未登录访问数据库的真实返回：' + probeObj.message + '）');
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试异常: ' + (e && e.stack || e)); process.exit(1); });
