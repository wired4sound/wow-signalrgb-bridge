#!/usr/bin/env node
'use strict';
// Rough structural check for the addon Lua files (no Lua interpreter on this PC):
// block openers vs `end`, and balanced (), {}, []. Catches the common typos; the game
// itself is the real syntax check (errors show after /reload).
//   node tools/lua-check.js [files...]
const fs = require('fs');
const path = require('path');

function strip(src) {
  return src
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '')    // long comments
    .replace(/--[^\n]*/g, '')                     // line comments
    .replace(/\[(=*)\[[\s\S]*?\]\1\]/g, '""')     // long strings
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

function check(file) {
  const s = strip(fs.readFileSync(file, 'utf8'));
  const problems = [];
  let depth = 0;
  const words = s.match(/\b[A-Za-z_]\w*\b/g) || [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'function' || w === 'if' || w === 'repeat') depth++;
    // `for ... do` and `while ... do` open one block via their `do`; a bare `do` also opens one.
    else if (w === 'do') depth++;
    else if (w === 'end' || w === 'until') depth--;
    if (depth < 0) { problems.push(`extra "end" near word ${i}`); depth = 0; }
  }
  if (depth !== 0) problems.push(`${depth} unclosed block(s)`);
  for (const [o, c] of [['(', ')'], ['{', '}'], ['[', ']']]) {
    const n = s.split(o).length - s.split(c).length;
    if (n !== 0) problems.push(`unbalanced ${o}${c} (${n > 0 ? '+' : ''}${n})`);
  }
  return problems;
}

const files = process.argv.slice(2);
const targets = files.length ? files : fs.readdirSync(path.join(__dirname, '..', 'addons'), { recursive: true })
  .filter((f) => f.endsWith('.lua')).map((f) => path.join(__dirname, '..', 'addons', f));
let bad = 0;
for (const f of targets) {
  const p = check(f);
  console.log(`${p.length ? 'FAIL' : 'ok  '} ${path.relative(process.cwd(), f)}${p.length ? `: ${p.join('; ')}` : ''}`);
  bad += p.length ? 1 : 0;
}
process.exit(bad ? 1 : 0);
