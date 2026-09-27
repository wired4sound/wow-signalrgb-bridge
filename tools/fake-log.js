#!/usr/bin/env node
'use strict';
// Writes a synthetic boss fight to a fake Logs folder, line by line, so the
// bridge can be tested without the game.
//   node tools/fake-log.js [--dir sandbox/Logs] [--speed 1] [--instant]

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const dir = path.resolve(opt('--dir', path.join(__dirname, '..', 'sandbox', 'Logs')));
const speed = Number(opt('--speed', 1)) || 1;
const instant = args.includes('--instant');

const ME = { guid: 'Player-4184-00A1B2C3', name: 'Testchar-Forever', flags: '0x511' };
const HEALER = { guid: 'Player-4184-00DDEEFF', name: 'Healbot-Forever', flags: '0x512' };
const BOSS = { guid: 'Creature-0-4184-409-1234-11502-0000ABCDEF', name: 'Ragnaros', flags: '0x10a48' };
const MAX_HP = 5000;

function stamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}0-4`;
}

const unit = (u) => `${u.guid},"${u.name}",${u.flags},0x0`;
// WoW Forever layout: 19 advanced fields.
const adv = (u, hp, max) => `${u.guid},0000000000000000,${hp},${max},100,200,1500,0,0,0,0,100,100,0,-1234.50,567.80,232,1.5708,60`;
const spell = (id, name, school = '0x4') => `${id},"${name}",${school}`;

function damage(src, dst, sp, amount, crit, dstHp, dstMax) {
  return `SPELL_DAMAGE,${unit(src)},${unit(dst)},${sp},${adv(dst, dstHp, dstMax)},${amount},${amount},-1,4,0,0,0,${crit ? 1 : 'nil'},nil,nil,ST`;
}
function heal(src, dst, sp, amount, dstHp) {
  return `SPELL_HEAL,${unit(src)},${unit(dst)},${sp},${adv(dst, dstHp, MAX_HP)},${amount},${amount},0,0,nil`;
}
function cast(src, dst, sp) {
  return `SPELL_CAST_SUCCESS,${unit(src)},${dst ? unit(dst) : '0000000000000000,nil,0x80000000,0x80000000'},${sp},${adv(src, MAX_HP, MAX_HP)}`;
}
const aura = (evt, src, dst, sp, type = 'BUFF') => `${evt},${unit(src)},${unit(dst)},${sp},${type}`;

const FIREBALL = spell(133, 'Fireball');
const LUST = spell(2825, 'Bloodlust', '0x8');
const WRATH = spell(20566, 'Wrath of Ragnaros');
const FLASH = spell(19750, 'Flash of Light', '0x2');
const REZ = spell(20773, 'Redemption', '0x2');

// [delay ms before line, line]
const script = [
  [0, 'COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,1.60.1,PROJECT_ID,18'],
  [200, 'ZONE_CHANGE,409,"Molten Core",9'],
  [500, cast(ME, BOSS, FIREBALL)],
  [300, 'ENCOUNTER_START,672,"Ragnaros",9,40,409'],
  [800, damage(ME, BOSS, FIREBALL, 1800, false, 900000, 1000000)],
  [800, damage(ME, BOSS, FIREBALL, 3900, true, 896100, 1000000)],
  [600, aura('SPELL_AURA_APPLIED', HEALER, ME, LUST)],
  [800, damage(BOSS, ME, WRATH, 2000, false, 3000, MAX_HP)],
  [800, damage(BOSS, ME, WRATH, 1800, false, 1200, MAX_HP)],
  [1500, heal(HEALER, ME, FLASH, 2800, 4000)],
  [1500, aura('SPELL_AURA_REMOVED', HEALER, ME, LUST)],
  [800, damage(BOSS, ME, WRATH, 3500, false, 500, MAX_HP)],
  [600, damage(BOSS, ME, WRATH, 1200, false, 0, MAX_HP)],
  [50, `UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,${unit(ME)},0,0`],
  [2500, `SPELL_RESURRECT,${unit(HEALER)},${unit(ME)},${REZ}`],
  [1500, cast(ME, BOSS, FIREBALL)],
  [800, damage(ME, BOSS, FIREBALL, 4100, true, 2000, 1000000)],
  [300, `UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,${unit(BOSS)},0,0`],
  [100, 'ENCOUNTER_END,672,"Ragnaros",9,40,1,245000'],
];

async function main() {
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const file = path.join(dir, `WoWCombatLog-${p(now.getMonth() + 1)}${p(now.getDate())}${String(now.getFullYear()).slice(2)}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.txt`);
  fs.writeFileSync(file, '');
  console.log(`Writing ${file}`);
  let t = Date.now();
  for (const [delay, line] of script) {
    if (!instant) await new Promise((r) => setTimeout(r, delay / speed));
    t += delay;
    fs.appendFileSync(file, `${stamp(new Date(t))}  ${line}\r\n`);
    if (!instant) console.log(line.split(',')[0]);
  }
  console.log('Done');
}

main();
