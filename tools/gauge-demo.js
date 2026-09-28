#!/usr/bin/env node
'use strict';
// Gauge demo: fakes a mana or health value that drains from 100% to 0% and refills, so
// you can watch a gauge on the real lights without playing. Needs the bridge running and
// in game (the gauge rules only run while the beacon is live).
//   node tools/gauge-demo.js [mana|health] [seconds=12]

const BASE = 'http://127.0.0.1:17700';
const source = process.argv[2] || 'mana';
const secs = Number(process.argv[3]) || 12;

async function set(value) {
  const res = await fetch(`${BASE}/api/test/gauge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge': '1' },
    body: JSON.stringify({ source, value, ms: 400 }),
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
}

async function main() {
  const t0 = Date.now();
  console.log(`${source}: draining 100% -> 0% then refilling, over ${secs}s`);
  let lastPrint = -1;
  while (Date.now() - t0 < secs * 1000) {
    const p = (Date.now() - t0) / (secs * 1000); // 0..1
    const v = p < 0.5 ? 1 - p * 2 : (p - 0.5) * 2;
    await set(v);
    const pct = Math.round(v * 10) * 10;
    if (pct !== lastPrint) { process.stdout.write(`${pct}% `); lastPrint = pct; }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('\ndone');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
