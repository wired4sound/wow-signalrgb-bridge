'use strict';
// Matches events against rules.json and drives the effect controller.

const { FLAG } = require('./tracker');
const { expandZones } = require('./zones');

const UNIT_FILTERS = ['any', 'player', 'notPlayer', 'mine', 'group', 'hostile', 'friendly'];

function arr(v) {
  if (v === undefined || v === null) return null;
  return Array.isArray(v) ? v : [v];
}

function lowerArr(v) {
  const a = arr(v);
  return a ? a.map((s) => String(s).toLowerCase()) : null;
}

function normalizeMatcher(m, where) {
  const out = {
    events: arr(m.event),
    spellId: arr(m.spellId),
    spellName: lowerArr(m.spellName),
    anySpell: !!m.anySpell,
    source: m.source || 'any',
    dest: m.dest || 'any',
    critical: m.critical,
    auraType: m.auraType ? String(m.auraType).toUpperCase() : null,
    minAmount: m.minAmount,
    encounterId: arr(m.encounterId),
    encounterName: lowerArr(m.encounterName),
  };
  if (!out.events) throw new Error(`${where}: "event" is required`);
  for (const k of ['source', 'dest']) {
    if (!UNIT_FILTERS.includes(out[k])) {
      throw new Error(`${where}: ${k} must be one of ${UNIT_FILTERS.join(', ')}`);
    }
  }
  return out;
}

function unitOk(kind, isPlayer, flags) {
  const f = flags || 0;
  switch (kind) {
    case 'any': return true;
    case 'player': return !!isPlayer;
    case 'notPlayer': return !isPlayer;
    case 'mine': return (f & FLAG.MINE) !== 0;
    case 'group': return (f & (FLAG.MINE | FLAG.PARTY | FLAG.RAID)) !== 0;
    case 'hostile': return (f & FLAG.HOSTILE) !== 0;
    case 'friendly': return (f & FLAG.FRIENDLY) !== 0;
    default: return false;
  }
}

function matches(m, ev, parent) {
  if (!m.events.includes(ev.event)) return false;

  const ids = m.spellId || (parent && !m.anySpell ? parent.spellId : null);
  const names = m.spellName || (parent && !m.anySpell ? parent.spellName : null);
  if (ids || names) {
    const byId = ids && ids.includes(ev.spellId);
    const byName = names && ev.spellName && names.includes(ev.spellName.toLowerCase());
    if (!byId && !byName) return false;
  }

  if (!unitOk(m.source, ev.sourceIsPlayer, ev.sourceFlags)) return false;
  if (!unitOk(m.dest, ev.destIsPlayer, ev.destFlags)) return false;
  if (m.critical !== undefined && !!ev.critical !== m.critical) return false;
  if (m.auraType && ev.auraType !== m.auraType) return false;
  if (m.minAmount !== undefined && !(ev.amount >= m.minAmount)) return false;
  if (m.encounterId && !m.encounterId.includes(ev.encounterId)) return false;
  if (m.encounterName && !(ev.encounterName && m.encounterName.includes(ev.encounterName.toLowerCase()))) return false;
  return true;
}

function loadRules(json) {
  const list = Array.isArray(json) ? json : json.rules;
  if (!Array.isArray(list)) throw new Error('rules.json must contain a "rules" array');
  const seen = new Set();
  return list
    .filter((r) => r.enabled !== false)
    .map((r, i) => {
      const where = `rule ${r.name || `#${i + 1}`}`;
      if (!r.name) throw new Error(`${where}: "name" is required`);
      if (seen.has(r.name)) throw new Error(`${where}: duplicate name`);
      seen.add(r.name);
      if (!r.effect) throw new Error(`${where}: "effect" is required`);
      const clearOn = arr(r.clearOn);
      let zones;
      try { zones = expandZones(arr(r.zones) || ['all']); } catch (err) { throw new Error(`${where}: ${err.message}`); }
      return {
        name: r.name,
        zones,
        effect: r.effect,
        preset: r.preset || null,
        priority: r.priority ?? 50,
        durationMs: r.durationMs ?? null,
        cooldownMs: r.cooldownMs ?? 0,
        trigger: normalizeMatcher(r, where),
        clearOn: clearOn ? clearOn.map((c, j) => normalizeMatcher(c, `${where} clearOn[${j}]`)) : null,
        lastFired: 0,
      };
    });
}

class RuleEngine {
  constructor(rules, controller, { log } = {}) {
    this.rules = rules;
    this.controller = controller;
    this.log = log;
  }

  handle(ev) {
    for (const rule of this.rules) {
      if (rule.clearOn && this.controller.isActive(rule.name)
        && rule.clearOn.some((m) => matches(m, ev, rule.trigger))) {
        this.controller.clear(rule.name, ev.event);
      }
      if (!matches(rule.trigger, ev)) continue;
      const now = Date.now();
      if (rule.cooldownMs && now - rule.lastFired < rule.cooldownMs) continue;
      rule.lastFired = now;
      if (!rule.clearOn && !rule.durationMs) {
        this.log?.warn(`Rule "${rule.name}" has no durationMs or clearOn; defaulting to 3s`);
        rule.durationMs = 3000;
      }
      this.controller.activate({
        key: rule.name,
        effect: rule.effect,
        preset: rule.preset,
        priority: rule.priority,
        durationMs: rule.durationMs,
        reason: ev.spellName || ev.encounterName || ev.event,
      });
    }
  }
}

module.exports = { RuleEngine, loadRules, matches, normalizeMatcher };
