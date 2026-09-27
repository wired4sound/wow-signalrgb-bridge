#!/usr/bin/env node
'use strict';
// Replaces every player name and GUID in a combat log with stable fakes, so a real log can
// be shared or used as a test fixture. Realm suffixes are kept (the parser cares about them).
//   node tools/anonymize-log.js <file> [--me <character name prefix>]
// Prints the mapping; rewrites the file in place.

const fs = require('fs');

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('Usage: node tools/anonymize-log.js <file> [--me <name prefix>]');
  process.exit(1);
}
const meIdx = args.indexOf('--me');
const me = meIdx >= 0 ? String(args[meIdx + 1] || '').toLowerCase() : null;

let text = fs.readFileSync(file, 'utf8');
const players = new Map(); // guid -> name
for (const m of text.matchAll(/(Player-[0-9A-F]+-[0-9A-F]+),"([^"]+)"/g)) {
  if (!players.has(m[1])) players.set(m[1], m[2]);
}

const replacements = [];
let n = 0;
for (const [guid, name] of players) {
  n++;
  const [base, ...realmParts] = name.split('-');
  const isMe = me ? base.toLowerCase().startsWith(me) : n === 1;
  const fakeName = [isMe ? 'Testpriest' : `Groupmate${n}`, ...realmParts].join('-');
  replacements.push([guid, `Player-0000-${String(n).padStart(8, '0')}`], [name, fakeName]);
}
for (const [from, to] of replacements) text = text.split(from).join(to);
fs.writeFileSync(file, text);
for (const [from, to] of replacements) console.log(`${from} -> ${to}`);
