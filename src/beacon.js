'use strict';
// Screen beacon: the SignalBeacon addon draws a tiny strip in the top-left corner of the
// game, tools/beacon-reader.ps1 reads it from the WoW window, and this module turns the
// readings into the same synthetic events the combat log tracker emits. The combat log
// reaches disk 2 to 13s late; the beacon is ~100ms.

const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const READER = path.join(__dirname, '..', 'tools', 'beacon-reader.ps1');

// Runs the PowerShell reader and emits one 'reading' per JSON line. Restarts it if it exits.
class BeaconReader extends EventEmitter {
  constructor({ processName = 'WowB', intervalMs = 100, restartMs = 3000 } = {}) {
    super();
    this.processName = processName;
    this.intervalMs = intervalMs;
    this.restartMs = restartMs;
    this.child = null;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.spawn();
  }

  spawn() {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', READER,
      '-Process', this.processName, '-IntervalMs', String(this.intervalMs)];
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { this.emit('reading', JSON.parse(line)); } catch { this.emit('warn', `Bad beacon line: ${line.slice(0, 80)}`); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => this.emit('warn', `Beacon reader: ${d.trim().slice(0, 200)}`));
    child.on('error', (err) => this.emit('warn', `Beacon reader failed to start: ${err.message}`));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      this.emit('warn', `Beacon reader exited (${code}), restarting`);
      this.emit('reading', { ok: false, why: 'reader restarting' });
      setTimeout(() => { if (!this.stopped) this.spawn(); }, this.restartMs);
    });
  }

  stop() {
    this.stopped = true;
    if (this.child) this.child.kill();
    this.child = null;
  }
}

// Turns readings into events. Short gaps (loading screens, a missed frame) keep the last
// state; after graceMs without a good reading the beacon is marked down, transient states
// are ended, and the combat log takes over again.
//
// Death is split in two (addon 0.3+): PLAYER_DIED on death, PLAYER_GHOST on release,
// PLAYER_ALIVE on revive. Mana (0.3+): MANA_AVAILABLE / MANA_UNAVAILABLE bracket the
// time a live mana value exists (the gauge effect reads it), plus
// PLAYER_LOW_MANA_START / _END. HEALTH_AVAILABLE / HEALTH_UNAVAILABLE bracket the time
// the beacon is live (for the health gauge).
class BeaconTracker {
  constructor({ lowHealthThreshold = 0.3, lowManaThreshold = 0.2, hysteresis = 0.05, graceMs = 10000 } = {}) {
    this.threshold = lowHealthThreshold;
    this.manaThreshold = lowManaThreshold;
    this.hysteresis = hysteresis;
    this.graceMs = graceMs;
    this.healthy = false;
    this.lastOk = 0;
    this.last = null;      // last good reading
    this.lastWhy = 'not started';
    this.lastResultAt = 0; // when the beacon last reported a kill or wipe (0 = never)
    this.state = {
      dead: false, ghost: false, lowHealth: false, combat: false, encounter: false, won: false, wiped: false,
      manaOn: false, lowMana: false,
    };
  }

  // Latest mana fraction, or null when there is none (no beacon, no mana bar).
  mana() {
    return this.healthy && this.state.manaOn && typeof this.last?.mana === 'number' ? this.last.mana : null;
  }

  // Latest health fraction, or null without a live beacon.
  health() {
    return this.healthy && typeof this.last?.hp === 'number' ? this.last.hp : null;
  }

  ev(event, extra = {}) {
    return { ts: Date.now(), event, synthetic: true, beacon: true, destIsPlayer: true, sourceIsPlayer: true, ...extra };
  }

  update(r, now = Date.now()) {
    const out = [];
    if (!r || !r.ok) {
      this.lastWhy = r?.why || 'unknown';
      out.push(...this.tick(now));
      return out;
    }
    this.lastOk = now;
    this.last = r;
    if (!this.healthy) {
      this.healthy = true;
      out.push(this.ev('BEACON_UP'));
      out.push(this.ev('HEALTH_AVAILABLE')); // brackets the health gauge
    }
    const s = this.state;

    const ghost = !!(r.dead && r.ghost);
    if (r.dead !== s.dead) {
      if (r.dead && s.lowHealth) { s.lowHealth = false; out.push(this.ev('PLAYER_LOW_HEALTH_END', { hp: r.hp })); }
      if (r.dead && s.lowMana) { s.lowMana = false; out.push(this.ev('PLAYER_LOW_MANA_END', { mana: r.mana })); }
      s.dead = r.dead;
      // Already a ghost on the first reading (e.g. after /reload while released): skip PLAYER_DIED.
      if (r.dead && !ghost) out.push(this.ev('PLAYER_DIED'));
      if (!r.dead) { s.ghost = false; out.push(this.ev('PLAYER_ALIVE')); }
    }
    if (s.dead && ghost !== s.ghost) {
      s.ghost = ghost;
      if (ghost) out.push(this.ev('PLAYER_GHOST'));
    }
    if (!s.dead) {
      if (!s.lowHealth && r.hp < this.threshold) { s.lowHealth = true; out.push(this.ev('PLAYER_LOW_HEALTH_START', { hp: r.hp })); }
      else if (s.lowHealth && r.hp >= this.threshold + this.hysteresis) { s.lowHealth = false; out.push(this.ev('PLAYER_LOW_HEALTH_END', { hp: r.hp })); }
    }
    const manaOn = !!r.hasMana && typeof r.mana === 'number';
    if (manaOn !== s.manaOn) {
      s.manaOn = manaOn;
      out.push(this.ev(manaOn ? 'MANA_AVAILABLE' : 'MANA_UNAVAILABLE'));
    }
    if (s.lowMana && (!manaOn || s.dead)) {
      s.lowMana = false;
      out.push(this.ev('PLAYER_LOW_MANA_END', { mana: r.mana }));
    } else if (manaOn && !s.dead) {
      if (!s.lowMana && r.mana < this.manaThreshold) { s.lowMana = true; out.push(this.ev('PLAYER_LOW_MANA_START', { mana: r.mana })); }
      else if (s.lowMana && r.mana >= this.manaThreshold + this.hysteresis) { s.lowMana = false; out.push(this.ev('PLAYER_LOW_MANA_END', { mana: r.mana })); }
    }
    if (r.combat !== s.combat) {
      s.combat = r.combat;
      out.push(this.ev(r.combat ? 'PLAYER_COMBAT_START' : 'PLAYER_COMBAT_END'));
    }
    if (r.encounter !== s.encounter) {
      s.encounter = r.encounter;
      out.push(this.ev(r.encounter ? 'ENCOUNTER_START' : 'ENCOUNTER_END'));
    }
    if (r.won && !s.won) { this.lastResultAt = now; out.push(this.ev('ENCOUNTER_WIN')); }
    if (r.wiped && !s.wiped) { this.lastResultAt = now; out.push(this.ev('ENCOUNTER_WIPE')); }
    s.won = !!r.won;
    s.wiped = !!r.wiped;
    return out;
  }

  // Call periodically so the beacon can time out even if the reader goes quiet.
  tick(now = Date.now()) {
    if (!this.healthy || now - this.lastOk < this.graceMs) return [];
    this.healthy = false;
    const out = [];
    const s = this.state;
    if (s.lowHealth) out.push(this.ev('PLAYER_LOW_HEALTH_END'));
    if (s.lowMana) out.push(this.ev('PLAYER_LOW_MANA_END'));
    if (s.manaOn) out.push(this.ev('MANA_UNAVAILABLE'));
    if (s.combat) out.push(this.ev('PLAYER_COMBAT_END'));
    if (s.encounter) out.push(this.ev('ENCOUNTER_END'));
    // Death is left alone: the Death rule has its own max lifetime, and the combat log
    // tracker will see the next sign of life.
    this.state = { ...s, lowHealth: false, lowMana: false, manaOn: false, combat: false, encounter: false, won: false, wiped: false };
    out.push(this.ev('HEALTH_UNAVAILABLE'));
    out.push(this.ev('BEACON_DOWN', { why: this.lastWhy }));
    return out;
  }

  // While the beacon is healthy it owns player state and encounter start/end; the
  // matching combat log events would only arrive late and duplicate them.
  shouldDropLogEvent(e, now = Date.now()) {
    if (!this.healthy || e.beacon) return false;
    switch (e.event) {
      case 'PLAYER_DIED':
      case 'PLAYER_ALIVE':
      case 'PLAYER_LOW_HEALTH_START':
      case 'PLAYER_LOW_HEALTH_END':
      case 'ENCOUNTER_START':
      case 'ENCOUNTER_END':
        return true;
      case 'ENCOUNTER_WIN':
      case 'ENCOUNTER_WIPE':
        // If ENCOUNTER_END's success flag is secret the beacon can't report results,
        // so the (late) log result is still used.
        return this.lastResultAt > 0 && now - this.lastResultAt < 60000;
      default:
        return false;
    }
  }

  status(now = Date.now()) {
    return {
      healthy: this.healthy,
      lastOkMsAgo: this.lastOk ? now - this.lastOk : null,
      why: this.healthy ? null : this.lastWhy,
      reading: this.last,
      state: { ...this.state },
    };
  }
}

module.exports = { BeaconReader, BeaconTracker };
