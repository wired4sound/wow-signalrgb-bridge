'use strict';
// Parses WoW combat log lines. Targets the Mainline (retail) format, which
// WoW Forever shares, with fallbacks for the older Classic layout.

const TS_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,4})(?:[-+]\d{1,2})?\s+(.*)$/;
const GUID_RE = /^(?:0{16}|[A-Za-z]+-[0-9A-Fa-f-]+)$/;

const PREFIXES = [
  ['SPELL_PERIODIC_', 3],
  ['SPELL_BUILDING_', 3],
  ['SPELL_', 3],
  ['RANGE_', 3],
  ['SWING_', 0],
  ['ENVIRONMENTAL_', 0],
];

// Events with base params that don't follow PREFIX_SUFFIX naming.
const ALIASES = {
  DAMAGE_SHIELD: ['SPELL_', 3, 'DAMAGE'],
  DAMAGE_SPLIT: ['SPELL_', 3, 'DAMAGE'],
  DAMAGE_SHIELD_MISSED: ['SPELL_', 3, 'MISSED'],
};
const BASE_ONLY = new Set([
  'UNIT_DIED', 'UNIT_DESTROYED', 'UNIT_DISSIPATES', 'PARTY_KILL',
  'ENCHANT_APPLIED', 'ENCHANT_REMOVED', 'SPELL_ABSORBED',
]);

// PROJECT_ID values from COMBAT_LOG_VERSION that use the older Classic suffix
// layout (no baseAmount). Mainline is 1 and WoW Forever is 18; both use the
// Mainline layout.
const CLASSIC_PROJECTS = new Set(['2', '5', '11', '14', '19']);
const ADVANCED_SUFFIXES = new Set([
  'DAMAGE', 'DAMAGE_LANDED', 'HEAL', 'ENERGIZE', 'DRAIN', 'LEECH', 'CAST_SUCCESS',
]);

// Advanced block layout differs by version (Mainline 17 fields, WoW Forever 19),
// so fields are named from the front and from the back; the middle varies.
const ADV_HEAD = ['infoGUID', 'ownerGUID', 'currentHP', 'maxHP', 'attackPower', 'spellPower', 'armor', 'absorb'];
const ADV_TAIL = ['powerType', 'currentPower', 'maxPower', 'powerCost', 'positionX', 'positionY', 'uiMapID', 'facing', 'level'];
const ADV_STRING = new Set(['infoGUID', 'ownerGUID', 'powerType', 'currentPower', 'maxPower', 'powerCost']);
const DEFAULT_ADV_LEN = 19;

function num(v) {
  if (v === undefined || v === null || v === '' || v === 'nil') return null;
  if (/^0x[0-9a-f]+$/i.test(v)) return parseInt(v, 16);
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function bool(v) {
  return v === '1' || v === 'true';
}

function str(v) {
  return v === undefined || v === 'nil' ? null : v;
}

// CSV split that respects quotes and [...] / (...) nesting.
function splitFields(s) {
  const out = [];
  let cur = '';
  let inQ = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') inQ = false;
      else cur += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseTimestamp(m) {
  const now = new Date();
  let year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
  if (year < 100) year += 2000;
  const ms = parseInt(m[7].padEnd(3, '0').slice(0, 3), 10);
  return new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10),
    parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10), ms).getTime();
}

function decodeDamage(p, classic) {
  const a = p.slice();
  let aoe = null;
  const last = a[a.length - 1];
  if (last === 'ST' || last === 'AOE') { aoe = last === 'AOE'; a.pop(); }
  // Mainline/Forever: amount, baseAmount, overkill, school, resisted, blocked, absorbed, critical, glancing, crushing[, isOffHand]
  // Classic:          amount, overkill, school, resisted, blocked, absorbed, critical, glancing, crushing, isOffHand
  const o = classic ? 0 : 1;
  return {
    amount: num(a[0]),
    baseAmount: o ? num(a[1]) : null,
    overkill: num(a[1 + o]),
    school: num(a[2 + o]),
    resisted: num(a[3 + o]),
    blocked: num(a[4 + o]),
    absorbed: num(a[5 + o]),
    critical: bool(a[6 + o]),
    glancing: bool(a[7 + o]),
    crushing: bool(a[8 + o]),
    isOffHand: bool(a[9 + o]),
    aoe,
  };
}

function decodeHeal(p, classic) {
  // Mainline/Forever: amount, baseAmount, overhealing, absorbed, critical
  // Classic:          amount, overhealing, absorbed, critical
  const o = classic ? 0 : 1;
  return {
    amount: num(p[0]),
    baseAmount: o ? num(p[1]) : null,
    overhealing: num(p[1 + o]),
    absorbed: num(p[2 + o]),
    critical: bool(p[3 + o]),
  };
}

function decodeSuffix(suffix, p, classic) {
  switch (suffix) {
    case 'DAMAGE':
    case 'DAMAGE_LANDED':
      return decodeDamage(p, classic);
    case 'HEAL':
      return decodeHeal(p, classic);
    case 'MISSED':
      return { missType: str(p[0]), isOffHand: bool(p[1]), amount: num(p[2]) };
    case 'AURA_APPLIED':
    case 'AURA_REMOVED':
    case 'AURA_REFRESH':
      return { auraType: str(p[0]), amount: num(p[1]) };
    case 'AURA_APPLIED_DOSE':
    case 'AURA_REMOVED_DOSE':
      return { auraType: str(p[0]), stacks: num(p[1]) };
    case 'INTERRUPT':
    case 'DISPEL':
    case 'DISPEL_FAILED':
    case 'STOLEN':
    case 'AURA_BROKEN_SPELL':
      return { extraSpellId: num(p[0]), extraSpellName: str(p[1]), extraSchool: num(p[2]), auraType: str(p[3]) };
    case 'CAST_FAILED':
      return { failedType: str(p[0]) };
    case 'ENERGIZE':
      return { amount: num(p[0]), overEnergize: num(p[1]), powerType: num(p[2]), maxPower: num(p[3]) };
    case 'DRAIN':
    case 'LEECH':
      return { amount: num(p[0]), powerType: num(p[1]), extraAmount: num(p[2]) };
    case 'EXTRA_ATTACKS':
      return { amount: num(p[0]) };
    default:
      return {};
  }
}

function decodeSpecial(event, f) {
  switch (event) {
    case 'COMBAT_LOG_VERSION': {
      const out = { version: num(f[0]) };
      for (let i = 1; i + 1 < f.length; i += 2) out[f[i]] = f[i + 1];
      return out;
    }
    case 'ENCOUNTER_START':
      return { encounterId: num(f[0]), encounterName: str(f[1]), difficultyId: num(f[2]),
        groupSize: num(f[3]), instanceId: num(f[4]) };
    case 'ENCOUNTER_END':
      return { encounterId: num(f[0]), encounterName: str(f[1]), difficultyId: num(f[2]),
        groupSize: num(f[3]), success: bool(f[4]), fightTimeMs: num(f[5]) };
    case 'ZONE_CHANGE':
      return { instanceId: num(f[0]), zoneName: str(f[1]), difficultyId: num(f[2]) };
    case 'MAP_CHANGE':
      return { uiMapId: num(f[0]), mapName: str(f[1]) };
    default:
      return { params: f };
  }
}

class CombatLogParser {
  constructor() {
    this.advanced = null;   // null = unknown, learned from COMBAT_LOG_VERSION or casts
    this.advLen = null;     // most common SPELL_CAST_SUCCESS remainder (no suffix params)
    this.advCounts = new Map();
    this.classic = false;
    this.meta = {};
  }

  learnAdvLen(n) {
    this.advCounts.set(n, (this.advCounts.get(n) || 0) + 1);
    let best = this.advLen;
    let bestCount = best === null ? 0 : (this.advCounts.get(best) || 0);
    for (const [len, count] of this.advCounts) {
      if (count > bestCount) { best = len; bestCount = count; }
    }
    this.advLen = best;
  }

  resolvePrefix(event) {
    if (ALIASES[event]) {
      const [prefix, count, suffix] = ALIASES[event];
      return { prefix, count, suffix };
    }
    for (const [prefix, count] of PREFIXES) {
      if (event.startsWith(prefix)) return { prefix, count, suffix: event.slice(prefix.length) };
    }
    return null;
  }

  advancedLength(suffix, rest) {
    if (!ADVANCED_SUFFIXES.has(suffix) || this.advanced === false) return 0;
    if (suffix === 'CAST_SUCCESS') {
      // Cast success has no suffix params, so whatever remains is the advanced block.
      if (rest.length > 0) {
        this.learnAdvLen(rest.length);
        this.advanced = true;
      }
      return rest.length;
    }
    if (this.advLen !== null) return this.advLen;
    if (!GUID_RE.test(rest[0] || '')) return 0;
    return this.classic ? 17 : DEFAULT_ADV_LEN;
  }

  parse(line) {
    if (!line) return null;
    const clean = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
    const m = TS_RE.exec(clean);
    if (!m) return null;

    const fields = splitFields(m[8]);
    const event = fields[0];
    const f = fields.slice(1);
    const ev = { ts: parseTimestamp(m), event };

    const pre = this.resolvePrefix(event);
    if (!pre && !BASE_ONLY.has(event)) {
      Object.assign(ev, decodeSpecial(event, f));
      if (event === 'COMBAT_LOG_VERSION') {
        this.meta = ev;
        if (ev.ADVANCED_LOG_ENABLED !== undefined) this.advanced = ev.ADVANCED_LOG_ENABLED === '1';
        this.classic = CLASSIC_PROJECTS.has(String(ev.PROJECT_ID));
        this.advLen = null;
        this.advCounts.clear();
      }
      return ev;
    }

    ev.sourceGUID = str(f[0]);
    ev.sourceName = str(f[1]);
    ev.sourceFlags = num(f[2]) || 0;
    ev.sourceRaidFlags = num(f[3]) || 0;
    ev.destGUID = str(f[4]);
    ev.destName = str(f[5]);
    ev.destFlags = num(f[6]) || 0;
    ev.destRaidFlags = num(f[7]) || 0;
    let rest = f.slice(8);

    if (!pre) {
      if (event === 'UNIT_DIED') {
        ev.recapId = num(rest[0]);
        ev.unconsciousOnDeath = bool(rest[1]);
      }
      ev.params = rest;
      return ev;
    }

    ev.prefix = pre.prefix.slice(0, -1);
    ev.suffix = pre.suffix;
    // ENVIRONMENTAL puts its type after the advanced block, so it takes no
    // params here.
    const env = pre.prefix === 'ENVIRONMENTAL_';
    if (pre.count === 3) {
      ev.spellId = num(rest[0]);
      ev.spellName = str(rest[1]);
      ev.spellSchool = num(rest[2]);
      rest = rest.slice(3);
    }

    const advLen = this.advancedLength(pre.suffix, rest);
    if (advLen > 0) {
      const block = rest.slice(0, advLen);
      ev.adv = {};
      const set = (name, v) => { ev.adv[name] = ADV_STRING.has(name) ? str(v) : num(v); };
      ADV_HEAD.forEach((name, i) => { if (i < block.length - ADV_TAIL.length) set(name, block[i]); });
      ADV_TAIL.forEach((name, i) => set(name, block[block.length - ADV_TAIL.length + i]));
      rest = rest.slice(advLen);
    }

    if (env) {
      ev.environmentalType = str(rest[0]);
      rest = rest.slice(1);
    }

    Object.assign(ev, decodeSuffix(pre.suffix, rest, this.classic));
    ev.params = rest;
    return ev;
  }
}

module.exports = { CombatLogParser, splitFields, num };
