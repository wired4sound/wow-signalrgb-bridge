#!/usr/bin/env node
'use strict';
// Wiring test: shows a slow red band sweeping left to right across the whole SignalRGB
// layout, so you can see how LEDs are ordered on each channel (daisy-chained fans light
// one after another; split/mirrored fans light together). Borrows the unused "WoW Crit"
// slot for the duration and puts its design back afterwards.
//   node tools/wiring-test.js [seconds=40] [sweepMs=8000]
// Needs the bridge running (it uses the settings page API on 127.0.0.1:17700).

const BASE = 'http://127.0.0.1:17700';
const H = { 'Content-Type': 'application/json', 'X-Bridge': '1' };

async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

async function main() {
  const secs = Number(process.argv[2]) || 40;
  const sweepMs = Number(process.argv[3]) || 8000;
  const { effects } = await call('GET', '/api/effects');
  const saved = effects.crit;
  const test = { ...saved, pattern: 'sweep', colors: ['#ff0000', '#000000'], speedMs: sweepMs, width: 12, brightness: 100 };
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await call('POST', '/api/preview/stop').catch(() => {});
    await call('PUT', '/api/effects/crit', saved);
    console.log('Done. WoW Crit design restored.');
  };
  process.on('SIGINT', () => restore().then(() => process.exit(0)));
  await call('PUT', '/api/effects/crit', test);
  await call('POST', '/api/preview', { effect: saved.name, ms: Math.min(60000, secs * 1000) });
  console.log(`Sweeping a red band left to right every ${sweepMs / 1000}s for ${secs}s. Watch the fans and the strip.`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  await restore();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
