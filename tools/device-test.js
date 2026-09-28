#!/usr/bin/env node
'use strict';
// Device test: lights every placed SignalRGB device in its own color (by name), using
// where each one sits in the layout right now, and prints the legend. Use it to check
// that each name in SignalRGB is the physical fan you think it is.
// Borrows the "WoW Crit" effect file like identify-test.js and restores it afterwards.
//   node tools/device-test.js [seconds=45]

const fs = require('fs');
const path = require('path');
const { readLayout } = require('../src/srgb-layout');
const { defaultEffectsDir } = require('../src/effects');

const BASE = 'http://127.0.0.1:17700';
const H = { 'Content-Type': 'application/json', 'X-Bridge': '1' };
const PALETTE = [
  ['red', '#ff0000'], ['green', '#00ff00'], ['blue', '#0030ff'], ['white', '#ffffff'], ['pink', '#ff2090'],
  ['yellow', '#ffe000'], ['purple', '#9000ff'], ['orange', '#ff7000'], ['cyan', '#00ffff'], ['lime', '#90ff30'],
  ['salmon', '#ff8080'], ['teal', '#008080'],
];

async function call(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

async function main() {
  const secs = Number(process.argv[2]) || 45;
  const devices = readLayout().filter((d) => !d.hue && !/^Default Strip - \d+$/.test(d.name));
  const boxes = devices.map((d, i) => {
    const quarter = Math.abs(d.rotation % 180) === 90;
    const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
    const w = quarter ? d.h : d.w, h = quarter ? d.w : d.h;
    const [label, color] = PALETTE[i % PALETTE.length];
    return { name: d.name, channel: d.channel, label, color, rect: [cx - w / 2 - 1, cy - h / 2 - 1, w + 2, h + 2] };
  });
  for (const b of boxes) console.log(`${b.label.padEnd(7)} ${b.name} (${b.channel})`);

  const { effects, dir } = await call('GET', '/api/effects');
  const saved = effects.crit;
  const file = path.join(dir || defaultEffectsDir(), `${saved.name}.html`);
  fs.writeFileSync(file, `<head><title>${saved.name}</title><meta publisher="wow-signalrgb-bridge" /></head>
<body style="margin:0;padding:0;"><canvas id="exCanvas" width="320" height="200"></canvas></body>
<script>
  var B = ${JSON.stringify(boxes.map((b) => ({ c: b.color, r: b.rect })))};
  var ctx = document.getElementById("exCanvas").getContext("2d");
  function draw() {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 320, 200);
    ctx.fillStyle = "#303030"; ctx.fillRect(0, 0, 320, 30); // ceiling dim, so the room stays lit
    B.forEach(function (b) { ctx.fillStyle = b.c; ctx.fillRect(b.r[0], b.r[1], b.r[2], b.r[3]); });
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
</script>
`);
  let done = false;
  const restore = async () => {
    if (done) return;
    done = true;
    await call('POST', '/api/preview/stop').catch(() => {});
    await call('PUT', '/api/effects/crit', { ...saved, brightness: saved.brightness === 100 ? 99 : 100 });
    await call('PUT', '/api/effects/crit', saved);
    console.log('Done. WoW Crit restored.');
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => restore().then(() => process.exit(0)));
  await call('POST', '/api/preview', { effect: saved.name, ms: Math.min(60000, secs * 1000) });
  console.log(`Device colors showing for ${secs}s.`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  await restore();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
