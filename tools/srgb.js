#!/usr/bin/env node
'use strict';
// SignalRGB API test tool.
//   node tools/srgb.js status
//   node tools/srgb.js list
//   node tools/srgb.js apply "<effect name>" ["<preset>"]
//   node tools/srgb.js presets "<effect name>"
//   node tools/srgb.js brightness <0-100>
//   node tools/srgb.js flash "<effect name>" [ms]     apply, wait, restore

const path = require('path');
const { loadConfig } = require('../src/config');
const { SignalRGBClient } = require('../src/signalrgb');

async function main() {
  const [cmd = 'status', a, b] = process.argv.slice(2);
  const cfg = loadConfig(path.join(__dirname, '..', 'config.json'));
  const c = new SignalRGBClient(cfg.signalrgb);

  switch (cmd) {
    case 'status': {
      const cur = await c.getCurrentEffect();
      console.log(`Effect: ${cur.name}\nEnabled: ${cur.enabled}\nBrightness: ${cur.brightness}`);
      break;
    }
    case 'list':
      for (const e of await c.listEffects()) console.log(`${e.name}    (${e.id})`);
      break;
    case 'apply':
      await c.applyByName(a, b);
      console.log(`Applied ${a}${b ? ` / ${b}` : ''}`);
      break;
    case 'presets':
      for (const p of await c.listPresets(await c.resolveEffectId(a))) console.log(p);
      break;
    case 'brightness':
      await c.setBrightness(Number(a));
      console.log(`Brightness ${a}`);
      break;
    case 'flash': {
      const before = await c.getCurrentEffect();
      await c.applyByName(a);
      const ms = Number(b) || 3000;
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, ms));
      await c.applyByName(before.name);
      console.log(`Flashed ${a} for ${ms}ms, restored ${before.name} (${Date.now() - t0}ms)`);
      break;
    }
    default:
      console.log('Commands: status | list | apply <name> [preset] | presets <name> | brightness <n> | flash <name> [ms]');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
