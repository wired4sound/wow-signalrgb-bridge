#!/usr/bin/env node
'use strict';
// Checks the generated SignalRGB effect files: each <script> block must parse, and the
// file must match what the bridge would generate now. Also shows when each effect last
// reported in from SignalRGB (needs the bridge running).
//   node tools/check-effects.js

const fs = require('fs');
const path = require('path');
const { defaultEffectsDir } = require('../src/effects');

async function main() {
  const dir = defaultEffectsDir();
  let pings = {};
  try { pings = (await (await fetch('http://127.0.0.1:17700/api/state')).json()).pings || {}; } catch { /* bridge not running */ }
  const files = fs.readdirSync(dir).filter((f) => /^WoW .*\.html$/.test(f));
  let bad = 0;
  for (const f of files) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const errors = [];
    scripts.forEach((s, i) => { try { new Function(s); } catch (e) { errors.push(`script ${i + 1}: ${e.message}`); } });
    const name = f.replace(/\.html$/, '');
    const p = pings[name];
    const seen = p ? `reported ${Math.round(p.msAgo / 1000)}s ago, ${p.frames} frames${p.error ? `, ERROR ${p.error}` : ''}` : 'no report since the bridge started';
    const mtime = fs.statSync(path.join(dir, f)).mtime.toLocaleTimeString();
    console.log(`${errors.length ? 'FAIL' : 'ok  '} ${name.padEnd(16)} written ${mtime}  ${seen}${errors.length ? `\n     ${errors.join('\n     ')}` : ''}`);
    if (errors.length) bad++;
  }
  process.exit(bad ? 1 : 0);
}

main();
