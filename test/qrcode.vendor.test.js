const test = require('node:test');
const assert = require('node:assert/strict');
const qrcode = require('../src/vendor/qrcode.js');

test('vendored 二维码库：能对 URL 生成非空 SVG', () => {
  assert.equal(typeof qrcode, 'function');
  const qr = qrcode(0, 'M');
  qr.addData('http://192.168.1.5:8787/');
  qr.make();
  const svg = qr.createSvgTag(6, 4);
  assert.equal(typeof svg, 'string');
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.length > 500);
});
