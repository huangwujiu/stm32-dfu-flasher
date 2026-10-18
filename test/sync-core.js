'use strict';
/* 从 index.html 抽取内联 <script> 生成 test/dfu-core.js（保持页面与 Node 测试同源） */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到内联 <script>'); process.exit(1); }

const code = m[1].replace(/^\s*\n/, '');
const dst = path.join(__dirname, 'dfu-core.js');
fs.writeFileSync(dst, code);

console.log('dfu-core.js 已同步: ' + code.split('\n').length + ' 行, ' + Buffer.byteLength(code) + ' 字节');
if (code.indexOf('module.exports') < 0) {
  console.error('警告: 抽取结果不含 module.exports，Node 测试可能无法 require');
}
