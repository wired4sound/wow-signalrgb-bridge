#!/usr/bin/env node
'use strict';
// Prints the SignalRGB layout (read from the registry) and which bridge zone each device
// lands in. Run after moving devices in SignalRGB; fix src/zones.js DEFAULT_RECTS (or
// zones.rects in config.json) if anything is flagged.
//   node tools/layout.js

const path = require('path');
const { readLayout } = require('../src/srgb-layout');
const { checkLayout, DEFAULT_RECTS, DEFAULT_PARTS, ZONE_LABELS } = require('../src/zones');
const { loadConfig } = require('../src/config');

const cfg = loadConfig(path.join(__dirname, '..', 'config.json'));
const rects = { ...DEFAULT_RECTS, ...(cfg.zones.rects || {}) };
const devices = readLayout();
if (!devices.length) {
  console.log('No SignalRGB layout found in the registry.');
  process.exit(1);
}
const parts = { ...DEFAULT_PARTS, ...(cfg.zones.parts || {}) };
const checked = checkLayout(devices, rects, parts);
let bad = 0;
devices.forEach((d, i) => {
  const c = checked[i];
  const where = c.zone ? ZONE_LABELS[c.zone] : '-';
  console.log(`${c.problem ? '!!' : 'ok'} ${d.name.padEnd(22)} ${(d.channel || (d.hue ? 'Hue' : '')).padEnd(14)} ${String(d.leds).padStart(3)} LEDs  `
    + `at ${d.x},${d.y} size ${d.w.toFixed(0)}x${d.h.toFixed(0)}${d.rotation ? ` rot ${d.rotation}` : ''}  -> ${where}${c.problem ? `  (${c.problem})` : ''}`);
  if (c.problem) bad++;
});
console.log(bad ? `\n${bad} device(s) need attention.` : '\nEvery device is in a zone.');
