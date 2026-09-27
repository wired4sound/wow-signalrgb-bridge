#!/usr/bin/env node
'use strict';
// Identify test: paints each zone of the layout a fixed color for a while, so you can
// see which physical LEDs belong to which part of the SignalRGB layout:
//   radiator bar + strip: rainbow left to right (red, orange, yellow, green, blue, purple)
//   rear: pink   back (right fans): cyan   bottom (floor fans): white   ceiling: dim white
//   anything outside the zones: black
// Temporarily replaces the "WoW Crit" effect file (no SignalRGB restart needed), then puts
// the real design back through the bridge.
//   node tools/identify-test.js [seconds=45]

const fs = require('fs');
const path = require('path');
const { DEFAULT_RECTS } = require('../src/zones');
const { defaultEffectsDir } = require('../src/effects');

const BASE = 'http://127.0.0.1:17700';
const H = { 'Content-Type': 'application/json', 'X-Bridge': '1' };
const RAINBOW = ['#ff0000', '#ff7a00', '#ffe000', '#00d000', '#0040ff', '#9000ff'];

async function call(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

function html(rects) {
  const data = JSON.stringify({ rects, rainbow: RAINBOW });
  return `<head><title>WoW Crit</title><meta publisher="wow-signalrgb-bridge" /></head>
<body style="margin:0;padding:0;"><canvas id="exCanvas" width="320" height="200"></canvas></body>
<script>
  var D = ${data};
  var ctx = document.getElementById("exCanvas").getContext("2d");
  function box(r, c) { ctx.fillStyle = c; ctx.fillRect(r[0], r[1], r[2], r[3]); }
  function rainbow(r) {
    var n = D.rainbow.length, w = r[2] / n;
    for (var i = 0; i < n; i++) { ctx.fillStyle = D.rainbow[i]; ctx.fillRect(r[0] + i * w, r[1], Math.ceil(w), r[3]); }
  }
  function draw() {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 320, 200);
    box(D.rects.ceiling, "#3a3a3a");
    box(D.rects.rear, "#ff2090");
    box(D.rects.back, "#00ffff");
    box(D.rects.bottom, "#ffffff");
    rainbow(D.rects.radiator);
    rainbow(D.rects.strip);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
</script>
`;
}

async function main() {
  const secs = Number(process.argv[2]) || 45;
  const { effects, dir } = await call('GET', '/api/effects');
  const saved = effects.crit;
  const file = path.join(dir || defaultEffectsDir(), `${saved.name}.html`);
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await call('POST', '/api/preview/stop').catch(() => {});
    // Force a rewrite of the real design (installEffects skips identical content).
    await call('PUT', '/api/effects/crit', { ...saved, brightness: saved.brightness === 100 ? 99 : 100 });
    await call('PUT', '/api/effects/crit', saved);
    console.log('Done. WoW Crit restored.');
  };
  process.on('SIGINT', () => restore().then(() => process.exit(0)));
  fs.writeFileSync(file, html(DEFAULT_RECTS));
  await call('POST', '/api/preview', { effect: saved.name, ms: Math.min(60000, secs * 1000) });
  console.log(`Showing the zone color map for ${secs}s.`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  await restore();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
