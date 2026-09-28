#!/usr/bin/env node
'use strict';
// LED count test: on each Prism 8 channel that still uses a generic strip component,
// colors the LEDs in blocks of 4 (red, orange, yellow, green, cyan, blue, purple, pink;
// LEDs 33+ black). The last color visible on a fan ring gives its LED count
// (e.g. last color green = 13-16 LEDs). The ceiling band stays white as a work light.
// Device positions and scales are read live from SignalRGB's registry settings.
//   node tools/led-count-test.js [seconds=60]
//   node tools/led-count-test.js [seconds] confirm   LEDs 1-8 white, 9-12 green, 13+ red
//   node tools/led-count-test.js [seconds] fine      LEDs 1-4 white, 5-6 green, 7-8 blue, 9+ red

const fs = require('fs');
const path = require('path');
const { readLayout } = require('../src/srgb-layout');
const { defaultEffectsDir } = require('../src/effects');

const BASE = 'http://127.0.0.1:17700';
const H = { 'Content-Type': 'application/json', 'X-Bridge': '1' };
const BLOCKS = ['#ff0000', '#ff7a00', '#ffe000', '#00d000', '#00ffff', '#0030ff', '#9000ff', '#ff40a0'];

async function call(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

// Every placed component (named or not), from src/srgb-layout.js.
function devices() {
  return readLayout().filter((d) => !d.hue).map((d) => ({
    alias: `${d.name}${d.channel ? ` (${d.channel})` : ''}`,
    leds: d.leds, w: d.grid[0], h: d.grid[1], x: d.x, y: d.y,
    sx: d.w / d.grid[0], sy: d.h / d.grid[1], rotation: d.rotation,
  }));
}

// Per-LED colors (index 0 = first LED) for each mode.
function ledColors(mode) {
  const out = [];
  for (let i = 0; i < 63; i++) {
    if (mode === 'confirm') out.push(i < 8 ? '#ffffff' : i < 12 ? '#00ff00' : '#ff0000');
    else if (mode === 'fine') out.push(i < 4 ? '#ffffff' : i < 6 ? '#00ff00' : i < 8 ? '#0030ff' : '#ff0000');
    else out.push(BLOCKS[Math.floor(i / 4)] || '#000000');
  }
  return out;
}

function html(name, devs, mode) {
  const data = JSON.stringify({ devs, colors: ledColors(mode) });
  return `<head><title>${name}</title><meta publisher="wow-signalrgb-bridge" /></head>
<body style="margin:0;padding:0;"><canvas id="exCanvas" width="320" height="200"></canvas></body>
<script>
  var D = ${data};
  var ctx = document.getElementById("exCanvas").getContext("2d");
  function draw() {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 320, 200);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 320, 34); // ceiling work light
    D.devs.forEach(function (d) {
      if (d.h !== 1 || d.rotation) return; // only straight generic strips
      for (var i = 0; i < d.leds; i++) {
        ctx.fillStyle = D.colors[i] || "#000";
        ctx.fillRect(d.x + i * d.sx, d.y, Math.ceil(d.sx), Math.max(1, d.h * d.sy));
      }
    });
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
</script>
`;
}

async function main() {
  const secs = Number(process.argv[2]) || 60;
  const devs = devices();
  for (const d of devs) console.log(`${d.alias}: ${d.leds} LEDs ${d.w}x${d.h} at (${d.x}, ${d.y}) scale ${d.sx.toFixed(2)}x${d.sy.toFixed(2)} rot ${d.rotation}${d.h !== 1 || d.rotation ? ' (skipped)' : ''}`);
  const { effects, dir } = await call('GET', '/api/effects');
  const saved = effects.crit;
  fs.writeFileSync(path.join(dir || defaultEffectsDir(), `${saved.name}.html`), html(saved.name, devs, process.argv[3]));
  let done = false;
  const restore = async () => {
    if (done) return;
    done = true;
    await call('POST', '/api/preview/stop').catch(() => {});
    await call('PUT', '/api/effects/crit', { ...saved, brightness: saved.brightness === 100 ? 99 : 100 });
    await call('PUT', '/api/effects/crit', saved);
    console.log('Done. WoW Crit restored.');
  };
  process.on('SIGINT', () => restore().then(() => process.exit(0)));
  await call('POST', '/api/preview', { effect: saved.name, ms: Math.min(60000, secs * 1000) });
  console.log(`LED count test showing for ${secs}s.`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  await restore();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
