'use strict';
// Decides which effect should be showing. Every active rule is an entry; the
// highest priority (then most recent) entry wins. With nothing active, the
// baseline effect is restored. Applies are rate limited and coalesced.

function sameTarget(a, b) {
  return !!a && !!b && a.effect === b.effect && (a.preset || null) === (b.preset || null);
}

class EffectController {
  constructor(client, { baseline = null, minApplyIntervalMs = 150, settleMs = 500, dryRun = false, log } = {}) {
    this.client = client;
    this.baseline = baseline ? { effect: baseline.effect, preset: baseline.preset || null } : null;
    // With no fixed baseline, a manual change in SignalRGB becomes the new baseline.
    this.followManual = !baseline;
    this.minInterval = minApplyIntervalMs;
    // GET /lighting lags an apply by ~60-120ms (measured), so a read soon after
    // our own apply can return the previous effect. Skip manual-change detection
    // inside this window.
    this.settleMs = settleMs;
    this.dryRun = dryRun;
    this.log = log;
    this.entries = new Map();
    this.override = null;
    this.seq = 0;
    this.applied = null;
    this.target = null;
    this.busy = false;
    this.pending = null;
    this.lastApply = 0;
    this.warned = new Set();
  }

  async init() {
    if (!this.baseline) {
      if (this.dryRun) {
        this.baseline = { effect: '(your current effect)', preset: null };
      } else {
        const cur = await this.client.getCurrentEffect();
        this.baseline = { effect: cur.name, preset: null };
      }
    }
    this.baseline.label = 'baseline';
    this.applied = this.baseline;
    this.target = this.baseline;
    this.log?.info(`Baseline effect: ${this.baseline.effect}${this.baseline.preset ? ` / ${this.baseline.preset}` : ''}`);
  }

  isActive(key) {
    return this.entries.has(key);
  }

  activate({ key, effect, preset = null, priority = 50, durationMs = null, reason = '' }) {
    const prev = this.entries.get(key);
    if (prev?.timer) clearTimeout(prev.timer);
    const entry = { key, effect, preset, priority, seq: ++this.seq, label: key };
    if (durationMs > 0) entry.timer = setTimeout(() => this.clear(key, 'expired'), durationMs);
    this.entries.set(key, entry);
    this.log?.info(`+ ${key} -> ${effect}${preset ? ` / ${preset}` : ''} (prio ${priority}${durationMs ? `, ${durationMs}ms` : ''})${reason ? ` [${reason}]` : ''}`);
    this.resolve();
  }

  clear(key, why = '') {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(key);
    this.log?.info(`- ${key}${why ? ` (${why})` : ''}`);
    this.resolve();
  }

  winner() {
    let best = null;
    for (const e of this.entries.values()) {
      if (!best || e.priority > best.priority || (e.priority === best.priority && e.seq > best.seq)) best = e;
    }
    return best;
  }

  // Deferred so a burst of changes from one batch of log lines (e.g. a clear
  // followed by an activate) collapses into a single apply.
  resolve() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const w = this.winner();
      // An override (the zone compositor while in game) replaces rule switching; the
      // compositor draws the winning rules itself. Entries at priority 1000+ (previews)
      // still show directly.
      this.target = w && w.priority >= 1000 ? w : this.override || w || this.baseline;
      this.pump();
    });
  }

  setOverride(effect) {
    const next = effect ? { effect, preset: null, label: 'compositor' } : null;
    if (sameTarget(next, this.override) || (!next && !this.override)) return;
    this.override = next;
    this.log?.info(effect ? `Zones on: showing ${effect}` : 'Zones off: switching whole effects');
    this.resolve();
  }

  async pump() {
    if (this.busy || (!this.force && sameTarget(this.target, this.applied))) return;
    const wait = this.lastApply + this.minInterval - Date.now();
    if (wait > 0) {
      if (!this.pending) {
        this.pending = setTimeout(() => { this.pending = null; this.pump(); }, wait);
      }
      return;
    }

    this.busy = true;
    this.force = false;
    const t = this.target;
    try {
      // Leaving baseline: pick up any effect the user switched to manually.
      if (!this.dryRun && this.followManual && this.applied?.label === 'baseline' && t.label !== 'baseline'
          && Date.now() - this.lastApply >= this.settleMs) {
        try {
          const cur = await this.client.getCurrentEffect();
          if (cur.name && cur.name !== this.baseline.effect) {
            this.baseline = { effect: cur.name, preset: null, label: 'baseline' };
            this.log?.info(`Baseline updated to ${cur.name}`);
          }
        } catch { /* keep old baseline */ }
      }
      const target = t.label === 'baseline' ? this.baseline : t;
      if (this.dryRun) {
        this.log?.info(`  [dry-run] apply ${target.effect}${target.preset ? ` / ${target.preset}` : ''}`);
      } else {
        await this.client.applyByName(target.effect, target.preset);
      }
    } catch (err) {
      const msg = err.message;
      if (!this.warned.has(msg)) {
        this.warned.add(msg);
        this.log?.error(msg);
      }
    } finally {
      this.applied = t;
      this.busy = false;
      this.lastApply = Date.now();
    }
    if (this.force || !sameTarget(this.target, this.applied)) this.pump();
  }

  // Re-sends the showing effect (all of them if effectName is omitted), e.g. after its
  // file changed on disk. SignalRGB reloads an effect file when it is applied.
  reapply(effectName = null) {
    const showing = this.applied?.label === 'baseline' ? this.baseline : this.applied;
    if (!showing || (effectName && showing.effect !== effectName)) return false;
    this.force = true;
    this.resolve();
    return true;
  }

  clearAll(why = 'reset') {
    for (const key of [...this.entries.keys()]) this.clear(key, why);
  }

  status() {
    const showing = this.applied?.label === 'baseline' ? this.baseline : this.applied;
    return {
      baseline: this.baseline?.effect || null,
      showing: showing?.effect || null,
      showingKey: this.applied?.label || null,
      entries: [...this.entries.values()]
        .sort((a, b) => b.priority - a.priority || b.seq - a.seq)
        .map((e) => ({ key: e.key, effect: e.effect, priority: e.priority })),
    };
  }

  async shutdown() {
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
    if (this.pending) clearTimeout(this.pending);
    while (this.busy) await new Promise((r) => setTimeout(r, 20));
    if (!this.baseline || sameTarget(this.applied, this.baseline)) return;
    if (this.dryRun) {
      this.log?.info(`  [dry-run] restore ${this.baseline.effect}`);
      return;
    }
    try {
      await this.client.applyByName(this.baseline.effect, this.baseline.preset);
    } catch (err) {
      this.log?.error(`Could not restore baseline: ${err.message}`);
    }
  }
}

module.exports = { EffectController };
