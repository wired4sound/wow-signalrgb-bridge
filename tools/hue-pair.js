#!/usr/bin/env node
'use strict';
// Pairs the bridge with the Hue Bridge for ceiling alerts (src/hue.js): press the round
// button on top of the Hue Bridge, then run this (it waits 90 seconds). Saves ip + key to
// hue.local.json (git-ignored). The Hue Bridge's IP comes from the argument, or from the
// one SignalRGB found.
//   node tools/hue-pair.js [ip]
//   node tools/hue-pair.js test      flash the ceiling blue twice with the saved key

const { execFileSync } = require('child_process');
const { pair, readLocal, writeLocal, HueAlerts, LOCAL_FILE } = require('../src/hue');
const { loadConfig } = require('../src/config');

function signalrgbIp() {
  try {
    const text = execFileSync('reg', ['query', 'HKCU\\Software\\WhirlwindFX\\SignalRgb\\services\\Philips Hue\\ipCache'], { encoding: 'utf8', windowsHide: true });
    const m = /cache\s+REG_\w+\s+(.*)/.exec(text);
    return JSON.parse(m[1])[0][1].ip;
  } catch { return null; }
}

async function main() {
  const arg = process.argv[2];
  if (arg === 'test') {
    const local = readLocal();
    if (!local?.key) throw new Error(`Not paired yet (${LOCAL_FILE})`);
    const cfg = loadConfig(require('path').join(__dirname, '..', 'config.json'));
    const hue = new HueAlerts({ ip: local.ip, key: local.key, lights: cfg.hue.lights, log: console });
    console.log(await hue.flash({ color: '#0050ff', times: 2 }) ? 'Flashed.' : 'Flash failed.');
    return;
  }
  const ip = arg || readLocal()?.ip || signalrgbIp();
  if (!ip) throw new Error('No Hue Bridge IP: pass it as an argument');
  console.log(`Pairing with the Hue Bridge at ${ip}. Press its round button now (waiting 90s)...`);
  const key = await pair(ip, { timeoutMs: 90000 });
  writeLocal({ ip, key });
  console.log(`Paired. Saved to ${LOCAL_FILE} (the key is not printed).`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
