#!/usr/bin/env node
'use strict';
// Work light: every light (Hue cans and PC) bright white until stopped (Ctrl+C, or
// POST to the bridge's /api/preview/stop). Borrows the "WoW Crit" effect file like
// identify-test.js and restores it on exit.
//   node tools/worklight.js [color=#ffffff]

const fs = require('fs');
const path = require('path');
const { defaultEffectsDir } = require('../src/effects');

const BASE = 'http://127.0.0.1:17700';
const H = { 'Content-Type': 'application/json', 'X-Bridge': '1' };

async function call(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

async function main() {
  const color = /^#[0-9a-f]{6}$/i.test(process.argv[2] || '') ? process.argv[2] : '#ffffff';
  const { effects, dir } = await call('GET', '/api/effects');
  const saved = effects.crit;
  const file = path.join(dir || defaultEffectsDir(), `${saved.name}.html`);
  fs.writeFileSync(file, `<head><title>${saved.name}</title><meta publisher="wow-signalrgb-bridge" /></head>
<body style="margin:0;padding:0;"><canvas id="exCanvas" width="320" height="200"></canvas></body>
<script>
  var ctx = document.getElementById("exCanvas").getContext("2d");
  function draw() { ctx.fillStyle = "${color}"; ctx.fillRect(0, 0, 320, 200); requestAnimationFrame(draw); }
  requestAnimationFrame(draw);
</script>
`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await call('POST', '/api/preview/stop').catch(() => {});
    await call('PUT', '/api/effects/crit', { ...saved, brightness: saved.brightness === 100 ? 99 : 100 });
    await call('PUT', '/api/effects/crit', saved);
    console.log('Work light off, WoW Crit restored.');
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, stop);
  // Previews last at most 60s; renew before they expire.
  const renew = () => call('POST', '/api/preview', { effect: saved.name, ms: 60000 }).catch((e) => console.error(e.message));
  await renew();
  const timer = setInterval(renew, 50000);
  // A file named worklight.off next to this script ends it (for callers that can't send signals).
  const offFile = path.join(__dirname, 'worklight.off');
  try { fs.unlinkSync(offFile); } catch { /* none */ }
  setInterval(() => { if (fs.existsSync(offFile)) { try { fs.unlinkSync(offFile); } catch { /* ignore */ } stop(); } }, 500);
  console.log(`Work light on (${color}).`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
