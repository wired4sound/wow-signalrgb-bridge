#!/usr/bin/env node
'use strict';
// Identify test: paints each zone of the layout its own fixed color for a while, so you
// can see which physical LEDs belong to which zone (the colors are printed at the start).
// Radiator bar and strip get a rainbow left to right, which shows their LED direction.
// Anything outside the zones is black.
// Temporarily replaces the "WoW Crit" effect file (no SignalRGB restart needed), then puts
// the real design back through the bridge. Uses the same zone areas as the bridge: from the
// SignalRGB layout by device name, else the defaults. To line devices up by hand in
// SignalRGB, run it long and drag each device onto its color in the canvas preview.
//   node tools/identify-test.js [seconds=45]

const fs = require('fs');
const path = require('path');
const { ZONE_NAMES, ZONE_LABELS, DEFAULT_RECTS, DEFAULT_PARTS, zonesFromLayout } = require('../src/zones');
const { defaultEffectsDir } = require('../src/effects');

const BASE = 'http://127.0.0.1:17700';
const H = { 'Content-Type': 'application/json', 'X-Bridge': '1' };
const RAINBOW = ['#ff0000', '#ff7a00', '#ffe000', '#00d000', '#0040ff', '#9000ff'];
const COLORS = {
  ceiling: ['#3a3a3a', 'dim white'],
  topLeft: ['#ff0000', 'red'],
  topMiddle: ['#00ff00', 'green'],
  topRight: ['#0040ff', 'blue'],
  radiator: ['rainbow', 'rainbow'],
  rear: ['#ff2090', 'pink'],
  rightTop: ['#00ffff', 'cyan'],
  rightBottom: ['#ffe000', 'yellow'],
  floorLeft: ['#ffffff', 'white'],
  floorRight: ['#ff7a00', 'orange'],
  strip: ['rainbow', 'rainbow'],
};

async function call(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

function html(rects, parts) {
  const areas = [];
  for (const k of ZONE_NAMES) {
    const c = COLORS[k][0];
    if (rects[k]) areas.push({ r: rects[k], c });
    for (const p of parts[k] || []) areas.push({ r: p.rect, c });
  }
  const data = JSON.stringify({ areas, rainbow: RAINBOW });
  return `<head><title>WoW Crit</title><meta publisher="wow-signalrgb-bridge" /></head>
<body style="margin:0;padding:0;"><canvas id="exCanvas" width="320" height="200"></canvas></body>
<script>
  var D = ${data};
  var ctx = document.getElementById("exCanvas").getContext("2d");
  function rainbow(r) {
    var n = D.rainbow.length, vertical = r[3] > r[2];
    for (var i = 0; i < n; i++) {
      ctx.fillStyle = D.rainbow[i];
      if (vertical) { var h = r[3] / n; ctx.fillRect(r[0], r[1] + i * h, r[2], Math.ceil(h)); }
      else { var w = r[2] / n; ctx.fillRect(r[0] + i * w, r[1], Math.ceil(w), r[3]); }
    }
  }
  function draw() {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 320, 200);
    for (var i = 0; i < D.areas.length; i++) {
      var a = D.areas[i];
      if (a.c === "rainbow") rainbow(a.r);
      else { ctx.fillStyle = a.c; ctx.fillRect(a.r[0], a.r[1], a.r[2], a.r[3]); }
    }
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
  let zones = null;
  let fromLayout = true;
  try { fromLayout = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).zones?.fromLayout !== false; } catch { /* default on */ }
  if (fromLayout) try { zones = zonesFromLayout(require('../src/srgb-layout').readLayout()); } catch { /* defaults */ }
  if (!zones) zones = { rects: DEFAULT_RECTS, parts: DEFAULT_PARTS };
  fs.writeFileSync(file, html(zones.rects, zones.parts));
  // Previews are capped at a minute; renew until done.
  const end = Date.now() + secs * 1000;
  const renew = () => call('POST', '/api/preview', { effect: saved.name, ms: Math.min(60000, end - Date.now()) });
  await renew();
  const timer = setInterval(() => { if (end - Date.now() > 1000) renew().catch(() => {}); }, 50000);
  console.log(`Showing the zone color map for ${secs}s:`);
  for (const k of ZONE_NAMES) console.log(`  ${ZONE_LABELS[k].padEnd(22)} ${COLORS[k][1]}`);
  for (const k of ZONE_NAMES) console.log(`  ${k.padEnd(12)} ${JSON.stringify(zones.rects[k])}${(zones.parts[k] || []).map((p) => ' + ' + JSON.stringify(p.rect)).join('')}`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  clearInterval(timer);
  await restore();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
