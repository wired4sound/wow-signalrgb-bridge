#!/usr/bin/env node
'use strict';
// Runs a generated effect file in Node with a fake canvas, window and Image, and prints
// any runtime error plus the image requests it makes and a few frames' fill colors.
// SignalRGB doesn't log effect errors, so this is how to debug one.
//   node tools/run-effect.js "WoW Bridge" [frames=5]

const fs = require('fs');
const path = require('path');
const { defaultEffectsDir } = require('../src/effects');

const name = process.argv[2] || 'WoW Bridge';
const frames = Number(process.argv[3]) || 5;
const html = fs.readFileSync(path.join(defaultEffectsDir(), `${name}.html`), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

const fills = [];
const requests = [];
const raf = [];
const ctx = {
  set fillStyle(v) { fills.push(v); }, get fillStyle() { return fills[fills.length - 1]; },
  fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, setTransform() {},
};
const win = { requestAnimationFrame: (f) => raf.push(f) };
class FakeImage {
  set src(u) { requests.push(u); this._src = u; }
  get src() { return this._src; }
}
const sandbox = {
  window: win,
  document: { getElementById: () => ({ getContext: () => ctx }) },
  Image: FakeImage,
  requestAnimationFrame: win.requestAnimationFrame,
  setInterval: () => 0,
  setTimeout: () => 0,
};
win.onerror = null;

try {
  const fn = new Function(...Object.keys(sandbox), scripts.map((s) => s.replace(/\(this\)\s*;?\s*$/m, '(window);')).join('\n;\n'));
  fn.call(win, ...Object.values(sandbox));
  console.log('setup: ok');
} catch (e) {
  console.log('setup ERROR:', e.message);
  process.exit(1);
}
for (let i = 0; i < frames; i++) {
  const f = raf.shift();
  if (!f) { console.log(`frame ${i}: no animation frame requested`); break; }
  fills.length = 0;
  try { f(); } catch (e) { console.log(`frame ${i} ERROR:`, e.message); process.exit(1); }
  console.log(`frame ${i}: ${fills.length} fills, e.g. ${fills.slice(0, 3).join(' ')}`);
}
console.log(`image requests: ${requests.length}`);
for (const r of requests.slice(0, 6)) console.log('  ' + r.replace(/&t=\d+/, ''));
