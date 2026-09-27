'use strict';
// Tracks player identity and state, annotates events, and emits synthetic events:
// PLAYER_IDENTIFIED, PLAYER_DIED, PLAYER_ALIVE, PLAYER_LOW_HEALTH_START,
// PLAYER_LOW_HEALTH_END, ENCOUNTER_WIN, ENCOUNTER_WIPE.

const FLAG = {
  MINE: 0x1, PARTY: 0x2, RAID: 0x4,
  FRIENDLY: 0x10, NEUTRAL: 0x20, HOSTILE: 0x40,
  CONTROL_PLAYER: 0x100, TYPE_PLAYER: 0x400, TYPE_PET: 0x1000,
};

const ALIVE_SIGNALS = new Set([
  'SPELL_CAST_START', 'SPELL_CAST_SUCCESS', 'SWING_DAMAGE', 'SPELL_DAMAGE', 'RANGE_DAMAGE',
]);

function isMyCharacter(flags) {
  return (flags & (FLAG.MINE | FLAG.TYPE_PLAYER)) === (FLAG.MINE | FLAG.TYPE_PLAYER)
    && (flags & FLAG.TYPE_PET) === 0;
}

class StateTracker {
  constructor({ playerName = null, lowHealthThreshold = 0.3, lowHealthHysteresis = 0.05, log } = {}) {
    this.playerName = playerName ? playerName.toLowerCase() : null;
    this.threshold = lowHealthThreshold;
    this.hysteresis = lowHealthHysteresis;
    this.log = log;
    this.playerGUID = null;
    this.playerLabel = null;
    this.dead = false;
    this.lowHealth = false;
    this.hp = null;
    this.encounter = null;
  }

  nameMatches(name) {
    if (!name) return false;
    const n = name.toLowerCase();
    return n === this.playerName || n.startsWith(`${this.playerName}-`);
  }

  identify(ev, out) {
    const candidates = [
      [ev.sourceGUID, ev.sourceName, ev.sourceFlags],
      [ev.destGUID, ev.destName, ev.destFlags],
    ];
    for (const [guid, name, flags] of candidates) {
      if (!guid || !guid.startsWith('Player-') || guid === this.playerGUID) continue;
      const match = this.playerName ? this.nameMatches(name) : isMyCharacter(flags);
      if (match) {
        this.playerGUID = guid;
        this.playerLabel = name;
        this.dead = false;
        this.lowHealth = false;
        out.push(this.synthetic(ev, 'PLAYER_IDENTIFIED', { playerGUID: guid, playerName: name }));
        return;
      }
    }
  }

  synthetic(ev, event, extra = {}) {
    return { ts: ev.ts, event, synthetic: true, destIsPlayer: true, ...extra };
  }

  setLowHealth(ev, on, out) {
    if (this.lowHealth === on) return;
    this.lowHealth = on;
    out.push(this.synthetic(ev, on ? 'PLAYER_LOW_HEALTH_START' : 'PLAYER_LOW_HEALTH_END', { hp: this.hp }));
  }

  process(ev) {
    const out = [];
    if (ev.sourceGUID !== undefined) this.identify(ev, out);

    ev.sourceIsPlayer = !!this.playerGUID && ev.sourceGUID === this.playerGUID;
    ev.destIsPlayer = !!this.playerGUID && ev.destGUID === this.playerGUID;
    out.unshift(ev);

    switch (ev.event) {
      case 'ENCOUNTER_START':
        this.encounter = { id: ev.encounterId, name: ev.encounterName };
        break;
      case 'ENCOUNTER_END':
        this.encounter = null;
        out.push(this.synthetic(ev, ev.success ? 'ENCOUNTER_WIN' : 'ENCOUNTER_WIPE', {
          encounterId: ev.encounterId, encounterName: ev.encounterName, fightTimeMs: ev.fightTimeMs,
        }));
        break;
      case 'ZONE_CHANGE':
        this.encounter = null;
        this.setLowHealth(ev, false, out);
        break;
      case 'UNIT_DIED':
        if (ev.destIsPlayer && !this.dead) {
          this.setLowHealth(ev, false, out);
          this.dead = true;
          this.hp = 0;
          out.push(this.synthetic(ev, 'PLAYER_DIED'));
        }
        return out;
      default:
        break;
    }

    if (!this.playerGUID) return out;

    const adv = ev.adv;
    const advIsPlayer = adv && adv.infoGUID === this.playerGUID && adv.maxHP > 0;

    if (this.dead) {
      const acted = ev.sourceIsPlayer && ALIVE_SIGNALS.has(ev.event);
      const healthy = advIsPlayer && adv.currentHP > 0;
      if (acted || healthy) {
        this.dead = false;
        out.push(this.synthetic(ev, 'PLAYER_ALIVE'));
      } else {
        return out;
      }
    }

    if (advIsPlayer) {
      this.hp = adv.currentHP / adv.maxHP;
      if (!this.lowHealth && this.hp < this.threshold) this.setLowHealth(ev, true, out);
      else if (this.lowHealth && this.hp >= this.threshold + this.hysteresis) this.setLowHealth(ev, false, out);
    }
    return out;
  }
}

module.exports = { StateTracker, FLAG, isMyCharacter };
