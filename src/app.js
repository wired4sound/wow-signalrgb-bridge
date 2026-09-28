'use strict';
// The running bridge: combat log + screen beacon -> rules -> effect controller, plus the
// state and settings the web UI reads and edits.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { loadConfig, readJson, findLogsDirs } = require('./config');
const { createLogger } = require('./log');
const { CombatLogParser } = require('./parser');
const { StateTracker } = require('./tracker');
const { RuleEngine, loadRules } = require('./rules');
const { SignalRGBClient } = require('./signalrgb');
const { EffectController } = require('./controller');
const { LogWatcher } = require('./watcher');
const { BeaconReader, BeaconTracker } = require('./beacon');
const effectsLib = require('./effects');
const zonesLib = require('./zones');

const ROOT = path.resolve(__dirname, '..');
const ACTIVITY_MAX = 200;
const PREVIEW_KEY = 'Preview';

// Settings the UI may change, with validation. Everything else in config.json is kept as is.
const EDITABLE = {
  lowHealthThreshold: (v) => num(v, 0.05, 0.9),
  lowManaThreshold: (v) => num(v, 0.05, 0.9),
  minApplyIntervalMs: (v) => Math.round(num(v, 0, 2000)),
  baseline: (v) => (v === null || v === '' ? null : { effect: String(v) }),
  logsDir: (v) => String(v || ''),
  playerName: (v) => String(v || ''),
  beaconEnabled: (v) => !!v,
  zonesEnabled: (v) => !!v,
  ambGain: (v) => num(v, 0.5, 6),
  ambSaturation: (v) => num(v, 0, 3),
  ambFloor: (v) => num(v, 0, 0.5),
  ambSmoothMs: (v) => Math.round(num(v, 0, 5000)),
  ceilingEnabled: (v) => !!v,
  watchdogEnabled: (v) => !!v,
  ceilingColor: (v) => {
    if (!/^#[0-9a-f]{6}$/i.test(String(v))) throw new Error('must be a #rrggbb color');
    return String(v).toLowerCase();
  },
};
const CEILING_KEYS = { ceilingEnabled: 'enabled', ceilingColor: 'color' };
const AMB_KEYS = { ambGain: 'gain', ambSaturation: 'saturation', ambFloor: 'floor', ambSmoothMs: 'smoothMs' };

function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`must be a number from ${min} to ${max}`);
  return n;
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

class BridgeApp {
  constructor({
    configFile = path.join(ROOT, 'config.json'),
    rulesFile = path.join(ROOT, 'rules.json'),
    effectsFile = path.join(ROOT, 'effects.json'),
    dryRun = false, logsDir = null, fromStart = false, verbose = false,
    client = null, beaconReader = null, effectsDir = null, restartSignalRGB = null,
  } = {}) {
    this.files = { config: configFile, rules: rulesFile, effects: effectsFile };
    this.opts = { dryRun, logsDir, fromStart, verbose };
    this.activity = [];
    this.pings = {};
    this.startedAt = Date.now();

    this.cfg = loadConfig(configFile);
    const base = createLogger(verbose ? 'debug' : this.cfg.logLevel);
    const push = (level, msg) => {
      this.activity.push({ t: Date.now(), level, msg: String(msg) });
      if (this.activity.length > ACTIVITY_MAX) this.activity.shift();
    };
    this.log = {
      debug: (m) => base.debug(m),
      info: (m) => { base.info(m); push('info', m); },
      warn: (m) => { base.warn(m); push('warn', m); },
      error: (m) => { base.error(m); push('error', m); },
    };

    this.client = client || new SignalRGBClient(this.cfg.signalrgb);
    // Record whether SignalRGB answers, for the status pill.
    this.srgb = { ok: null, error: null, current: null, at: 0 };
    if (typeof this.client.request === 'function') {
      const request = this.client.request.bind(this.client);
      this.client.request = async (...a) => {
        try {
          const r = await request(...a);
          this.srgb = { ...this.srgb, ok: true, error: null, at: Date.now() };
          return r;
        } catch (err) {
          this.srgb = { ...this.srgb, ok: false, error: err.message, at: Date.now() };
          throw err;
        }
      };
    }
    this.effectsDir = effectsDir || this.cfg.signalrgb.effectsDir || effectsLib.defaultEffectsDir();
    this.restartSignalRGB = restartSignalRGB || (() => new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(ROOT, 'tools', 'restart-signalrgb.ps1')], { windowsHide: true, timeout: 120000 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
    }));

    this.rulesJson = readJson(rulesFile);
    this.rules = loadRules(this.rulesJson);
    this.effects = effectsLib.loadEffects(effectsFile);

    this.controller = new EffectController(this.client, {
      baseline: this.cfg.baseline,
      minApplyIntervalMs: this.cfg.minApplyIntervalMs,
      dryRun,
      log: this.log,
    });
    this.engine = new RuleEngine(this.rules, this.controller, { log: this.log });

    this.parser = new CombatLogParser();
    this.tracker = new StateTracker({
      playerName: this.cfg.playerName || null,
      lowHealthThreshold: this.cfg.lowHealthThreshold,
      log: this.log,
    });
    this.beacon = new BeaconTracker({
      lowHealthThreshold: this.cfg.lowHealthThreshold,
      lowManaThreshold: this.cfg.lowManaThreshold,
      graceMs: this.cfg.beacon.graceMs,
    });
    this.beaconReader = beaconReader || new BeaconReader({
      processName: this.cfg.beacon.processName,
      intervalMs: this.cfg.beacon.intervalMs,
    });
    this.logState = { dir: null, file: null, lastLineAt: null, lines: 0, player: null, error: null };
    this.ambience = new zonesLib.Ambience(this.cfg.zones.ambience);
    this.compositorListed = false; // does SignalRGB list the "WoW Bridge" effect yet?
    this.wd = { step: 0, okAt: 0, restartAt: 0, restarting: false };
  }

  zoneList() {
    const rects = { ...zonesLib.DEFAULT_RECTS, ...(this.cfg.zones.rects || {}) };
    return zonesLib.ZONE_NAMES.map((name) => ({ name, rect: rects[name] }));
  }

  designIndex() {
    const idx = {};
    Object.values(this.effects).forEach((d, i) => { idx[d.name] = i + 1; });
    return idx;
  }

  // Per zone: which rule wins there (index into the compositor's designs; 0 = ambience).
  zoneState() {
    const ruleZones = Object.fromEntries(this.rules.map((r) => [r.name, r.zones]));
    const excluded = this.cfg.zones.ceiling.enabled ? [] : ['ceiling'];
    return zonesLib.resolveZones([...this.controller.entries.values()], ruleZones, this.designIndex(), excluded);
  }

  // Zones run while the beacon is live (in game), unless the top rule uses an effect the
  // compositor can't draw (a stock SignalRGB effect): then that effect shows whole.
  updateCompositor() {
    const top = this.controller.winner();
    const drawable = !top || top.priority >= 1000 || this.designIndex()[top.effect];
    const on = this.cfg.zones.enabled && this.compositorListed && this.beacon.healthy && !!drawable;
    this.controller.setOverride(on ? effectsLib.COMPOSITOR_NAME : null);
  }

  // 12-bit words for the compositor's image-size channel (see /api/w.bmp).
  channelWord(key) {
    const m = /^z(\d)$/.exec(key || '');
    if (m) return zonesLib.packZones(this.zoneState().map((z) => z.index))[Number(m[1])] ?? null;
    const a = /^a(\d)([hl])$/.exec(key || '');
    if (a) return this.ambience.words()[Number(a[1]) * 2 + (a[2] === 'h' ? 0 : 1)] ?? null;
    return null;
  }

  async start() {
    this.log.info(`Loaded ${this.rules.length} active rules`);
    // A dry run must not touch SignalRGB, including its Effects folder: the files carry
    // this instance's port, and would break the effect pings of a live bridge.
    const inst = this.opts.dryRun ? { added: [] } : this.installEffects();
    if (inst.added.length) {
      this.log.warn(`New effects written (${inst.added.join(', ')}). SignalRGB must be restarted to list them: use "Install effects" in the settings page.`);
    }
    try {
      await this.controller.init();
    } catch (err) {
      this.log.error(`SignalRGB: ${err.message}`);
      this.controller.baseline = { effect: this.cfg.baseline?.effect || 'Solid Color', preset: null, label: 'baseline' };
      this.controller.applied = this.controller.baseline;
      this.controller.target = this.controller.baseline;
    }
    if (!this.opts.dryRun) {
      const listed = await this.listSignalRGBEffects().catch(() => []);
      this.compositorListed = listed.some((e) => e.name === effectsLib.COMPOSITOR_NAME);
      this.checkLayout();
    }
    this.startLog();
    if (this.cfg.beacon.enabled) this.startBeacon();
    let ticks = 0;
    this.tickTimer = setInterval(() => {
      this.feedBeacon(null);
      if (ticks++ % 5 === 0) this.checkSignalRGB();
      this.watchdog();
    }, 1000);
  }

  // SignalRGB's effect engine can stall (seen after a long idle afternoon): it keeps
  // reporting the effect as active but runs nothing, and the lights freeze on the last
  // frame. Every bridge effect pings every 3s, so: no ping for staleMs after it was
  // applied -> re-apply; still nothing -> restart SignalRGB (at most every 10 minutes).
  watchdog(now = Date.now()) {
    const wd = this.cfg.watchdog;
    if (!wd.enabled || this.opts.dryRun || this.stopping) return;
    const name = this.controller.status().showing;
    const ours = name === effectsLib.COMPOSITOR_NAME || Object.values(this.effects).some((e) => e.name === name);
    if (!ours || !name || this.wd.restarting) { if (!this.wd.restarting) this.wd.step = 0; return; }
    const lastApply = this.controller.lastApply || 0;
    const ping = this.pings[name];
    // Healthy: a report since the effect was (re)applied, and a recent one.
    if (ping && ping.at >= lastApply && now - ping.at < wd.staleMs) { this.wd.step = 0; return; }
    const silentFor = now - Math.max(lastApply, ping ? ping.at : 0, this.wd.okAt);
    if (silentFor < wd.staleMs) return;
    if (this.wd.step === 0) {
      this.log.warn(`Watchdog: "${name}" stopped reporting from SignalRGB; re-applying it`);
      this.wd.step = 1;
      this.wd.okAt = now;
      this.controller.reapply(name);
    } else if (this.wd.step === 1 && now - this.wd.restartAt > 600000) {
      this.log.warn(`Watchdog: "${name}" still silent; restarting SignalRGB`);
      this.wd.restarting = true;
      this.wd.restartAt = now;
      this.restartSignalRGB()
        .then(() => { this.client.effectCache = null; this.controller.reapply(); this.log.info('Watchdog: SignalRGB restarted'); })
        .catch((err) => this.log.error(`Watchdog: SignalRGB restart failed: ${err.message}`))
        .finally(() => { this.wd.restarting = false; this.wd.step = 0; this.wd.okAt = Date.now(); });
    }
  }

  // Warns when a SignalRGB device sits outside the zones (e.g. after devices were moved).
  checkLayout() {
    if (process.platform !== 'win32' || !this.cfg.zones.enabled) return;
    try {
      const rects = Object.fromEntries(this.zoneList().map((z) => [z.name, z.rect]));
      const problems = zonesLib.checkLayout(require('./srgb-layout').readLayout(), rects).filter((c) => c.problem);
      for (const p of problems) this.log.warn(`Layout: ${p.name} is ${p.problem}. Run "node tools/layout.js" and adjust the zones.`);
    } catch (err) {
      this.log.warn(`Could not read the SignalRGB layout: ${err.message}`);
    }
  }

  async checkSignalRGB() {
    if (this.opts.dryRun) return;
    try {
      const cur = await this.client.getCurrentEffect();
      this.srgb.current = cur.name;
    } catch { /* recorded by the request wrapper */ }
  }

  startLog() {
    let logsDir = this.opts.logsDir || this.cfg.logsDir;
    if (!logsDir) {
      const found = findLogsDirs();
      if (!found.length) {
        this.logState.error = 'No WoW Logs folder found. Set it in Settings.';
        this.log.warn(this.logState.error);
        return;
      }
      logsDir = found[0].dir;
    }
    logsDir = path.resolve(logsDir);
    this.logState.dir = logsDir;
    this.log.info(`Watching ${logsDir}`);
    this.watcher = new LogWatcher({ logsDir, pollMs: this.cfg.pollMs, fromStart: this.opts.fromStart });
    this.watcher.on('file', (f) => { this.logState.file = path.basename(f); this.log.info(`Tailing ${path.basename(f)}`); });
    this.watcher.on('warn', (m) => this.log.warn(m));
    this.watcher.on('line', (line) => this.handleLine(line));
    this.watcher.start();
  }

  stopLog() {
    if (this.watcher) this.watcher.stop();
    this.watcher = null;
  }

  startBeacon() {
    if (this.beaconRunning) return;
    this.beaconRunning = true;
    this.beaconReader.removeAllListeners();
    this.beaconReader.on('reading', (r) => this.feedBeacon(r));
    this.beaconReader.on('warn', (m) => this.log.warn(m));
    this.beaconReader.start();
    this.log.info('Screen beacon reader started');
  }

  stopBeacon() {
    if (!this.beaconRunning) return;
    this.beaconRunning = false;
    this.beaconReader.stop();
    this.feedBeacon({ ok: false, why: 'disabled' });
    for (const e of this.beacon.tick(Number.MAX_SAFE_INTEGER)) this.dispatch(e);
    this.log.info('Screen beacon reader stopped');
  }

  handleLine(line) {
    const ev = this.parser.parse(line);
    this.logState.lastLineAt = Date.now();
    this.logState.lines++;
    if (!ev) return;
    for (const e of this.tracker.process(ev)) {
      if (e.event === 'PLAYER_IDENTIFIED') {
        this.logState.player = e.playerName;
        this.log.info(`Player: ${e.playerName} (${e.playerGUID})`);
      } else if (e.event === 'COMBAT_LOG_VERSION') {
        this.log.info(`Combat log version ${e.version}, advanced logging ${e.ADVANCED_LOG_ENABLED === '1' ? 'on' : 'OFF'}, build ${e.BUILD_VERSION || '?'}`);
      }
      if (this.beacon.shouldDropLogEvent(e)) continue;
      this.dispatch(e);
    }
  }

  feedBeacon(reading) {
    if (reading?.amb) this.ambience.update(reading.amb);
    const events = reading ? this.beacon.update(reading) : this.beacon.tick();
    for (const e of events) {
      if (e.event === 'BEACON_UP') this.log.info('Screen beacon: live');
      else if (e.event === 'BEACON_DOWN') this.log.warn(`Screen beacon: lost (${e.why}), using the combat log`);
      else this.dispatch(e, false);
    }
    this.updateCompositor();
  }

  dispatch(e, update = true) {
    if (e.synthetic && !['PLAYER_IDENTIFIED', 'BEACON_UP', 'BEACON_DOWN'].includes(e.event)) {
      const hp = typeof e.hp === 'number' ? ` (${Math.round(e.hp * 100)}%)` : '';
      this.log.info(`${e.beacon ? 'beacon' : 'log'}: ${e.event}${hp}`);
    }
    this.engine.handle(e);
    if (update) this.updateCompositor();
  }

  // ---- effects ----

  installEffects() {
    try {
      const r = effectsLib.installEffects(this.effects, this.effectsDir, {
        pingPort: this.cfg.ui.port,
        zones: this.cfg.zones.enabled ? this.zoneList() : null,
        roomLight: this.cfg.zones.ceiling.color,
      });
      if (r.written.length) this.log.info(`Effect files updated: ${r.written.join(', ')}`);
      return r;
    } catch (err) {
      this.log.error(`Could not write effect files to ${this.effectsDir}: ${err.message}`);
      return { written: [], added: [], error: err.message };
    }
  }

  saveEffect(id, def) {
    const next = effectsLib.normalizeEffect(id, def);
    this.effects = { ...this.effects, [id]: next };
    effectsLib.saveEffects(this.files.effects, this.effects);
    const r = this.installEffects();
    if (r.error) throw new Error(r.error);
    // The compositor bakes every design, so it needs a reload too.
    if (!this.controller.reapply(next.name)) this.controller.reapply(effectsLib.COMPOSITOR_NAME);
    return next;
  }

  resetEffect(id) {
    const def = effectsLib.DEFAULT_EFFECTS[id];
    if (!def) throw new Error(`Unknown effect "${id}"`);
    return this.saveEffect(id, def);
  }

  async installAndRestart() {
    const r = this.installEffects();
    if (r.error) throw new Error(r.error);
    const installed = await this.listSignalRGBEffects().catch(() => []);
    const names = new Set(installed.map((e) => e.name.toLowerCase()));
    const wanted = Object.values(this.effects).map((e) => e.name);
    if (this.cfg.zones.enabled) wanted.push(effectsLib.COMPOSITOR_NAME);
    const missing = wanted.filter((n) => !names.has(n.toLowerCase()));
    if (!missing.length) {
      this.compositorListed = names.has(effectsLib.COMPOSITOR_NAME.toLowerCase());
      this.updateCompositor();
      return { restarted: false, missing: [] };
    }
    this.log.info(`Restarting SignalRGB so it finds: ${missing.join(', ')}`);
    await this.restartSignalRGB();
    this.client.effectCache = null;
    const after = await this.listSignalRGBEffects().catch(() => []);
    this.compositorListed = after.some((e) => e.name === effectsLib.COMPOSITOR_NAME);
    this.controller.reapply();
    this.updateCompositor();
    return { restarted: true, missing };
  }

  preview(effect, ms = 5000) {
    if (!effect) throw new Error('effect is required');
    const dur = Math.round(num(ms, 500, 60000));
    this.controller.activate({ key: PREVIEW_KEY, effect: String(effect), priority: 1000, durationMs: dur, reason: 'preview' });
    return { effect, ms: dur };
  }

  stopPreview() {
    this.controller.clear(PREVIEW_KEY, 'stopped');
  }

  effectPing(q) {
    if (!q.name) return;
    const def = Object.values(this.effects).find((e) => e.name === q.name);
    this.pings[q.name] = {
      at: Date.now(),
      frames: Number(q.frames) || 0,
      error: String(q.error || '').slice(0, 300),
      version: q.v || null,
      current: def ? q.v === effectsLib.designHash(def) : null, // false: SignalRGB is showing an older design
      level: q.level === undefined || q.level === '' ? null : Number(q.level),
      zones: q.z || null, // compositor only: zone design indices it is drawing
      amb: q.amb || null, //   and the first ambience color it has
    };
  }

  // Live values for gauge effects (see src/effects.js). null = none right now.
  gaugeValue(source) {
    if (source === 'mana') return this.beacon.mana();
    return null;
  }

  async listSignalRGBEffects() {
    return this.client.listEffects(true);
  }

  // ---- rules ----

  getRules() {
    return this.rulesJson;
  }

  saveRules(json) {
    const rules = loadRules(json); // throws on invalid
    const oldByName = new Map(this.rules.map((r) => [r.name, r]));
    const newByName = new Map(rules.map((r) => [r.name, r]));
    // End anything showing for a rule that was removed, disabled or changed.
    for (const [name, old] of oldByName) {
      const nu = newByName.get(name);
      if (!nu || nu.effect !== old.effect || nu.preset !== old.preset || nu.priority !== old.priority) {
        this.controller.clear(name, 'rule changed');
      }
    }
    writeJson(this.files.rules, json);
    this.rulesJson = json;
    this.rules = rules;
    this.engine.rules = rules;
    this.log.info(`Rules saved (${rules.length} active)`);
    return json;
  }

  // ---- settings ----

  getSettings() {
    return {
      lowHealthThreshold: this.cfg.lowHealthThreshold,
      lowManaThreshold: this.cfg.lowManaThreshold,
      minApplyIntervalMs: this.cfg.minApplyIntervalMs,
      baseline: this.cfg.baseline?.effect || null,
      logsDir: this.cfg.logsDir,
      playerName: this.cfg.playerName,
      beaconEnabled: this.cfg.beacon.enabled,
      zonesEnabled: this.cfg.zones.enabled,
      ambGain: this.cfg.zones.ambience.gain,
      ambSaturation: this.cfg.zones.ambience.saturation,
      ambFloor: this.cfg.zones.ambience.floor,
      ambSmoothMs: this.cfg.zones.ambience.smoothMs,
      ceilingEnabled: this.cfg.zones.ceiling.enabled,
      ceilingColor: this.cfg.zones.ceiling.color,
      watchdogEnabled: this.cfg.watchdog.enabled,
    };
  }

  saveSettings(patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!EDITABLE[k]) throw new Error(`Unknown setting "${k}"`);
      try { clean[k] = EDITABLE[k](v); } catch (err) { throw new Error(`${k} ${err.message}`); }
    }
    const raw = fs.existsSync(this.files.config) ? readJson(this.files.config) : {};
    for (const [k, v] of Object.entries(clean)) {
      if (k === 'beaconEnabled') raw.beacon = { ...(raw.beacon || {}), enabled: v };
      else if (k === 'watchdogEnabled') raw.watchdog = { ...(raw.watchdog || {}), enabled: v };
      else if (k === 'zonesEnabled') raw.zones = { ...(raw.zones || {}), enabled: v };
      else if (AMB_KEYS[k]) {
        raw.zones = { ...(raw.zones || {}) };
        raw.zones.ambience = { ...(raw.zones.ambience || {}), [AMB_KEYS[k]]: v };
      } else if (CEILING_KEYS[k]) {
        raw.zones = { ...(raw.zones || {}) };
        raw.zones.ceiling = { ...(raw.zones.ceiling || {}), [CEILING_KEYS[k]]: v };
      } else raw[k] = v;
    }
    writeJson(this.files.config, raw);
    const before = this.cfg;
    this.cfg = loadConfig(this.files.config);

    if ('lowHealthThreshold' in clean) {
      this.tracker.threshold = this.cfg.lowHealthThreshold;
      this.beacon.threshold = this.cfg.lowHealthThreshold;
    }
    if ('lowManaThreshold' in clean) this.beacon.manaThreshold = this.cfg.lowManaThreshold;
    if (Object.keys(clean).some((k) => AMB_KEYS[k])) Object.assign(this.ambience.opts, this.cfg.zones.ambience);
    if ('ceilingColor' in clean) {
      // The room light color is baked into the compositor effect: rewrite and reload it.
      this.installEffects();
      this.controller.reapply(effectsLib.COMPOSITOR_NAME);
    }
    if ('zonesEnabled' in clean && clean.zonesEnabled !== before.zones.enabled) {
      if (clean.zonesEnabled) this.installAndRestart().catch((err) => this.log.error(`Zones: ${err.message}`));
      this.updateCompositor();
    }
    if ('minApplyIntervalMs' in clean) this.controller.minInterval = this.cfg.minApplyIntervalMs;
    if ('playerName' in clean) this.tracker.playerName = this.cfg.playerName ? this.cfg.playerName.toLowerCase() : null;
    if ('baseline' in clean) {
      this.controller.followManual = !clean.baseline;
      if (clean.baseline) {
        const wasShowing = this.controller.applied?.label === 'baseline';
        this.controller.baseline = { effect: clean.baseline.effect, preset: null, label: 'baseline' };
        if (wasShowing) this.controller.reapply();
      }
    }
    if ('beaconEnabled' in clean && clean.beaconEnabled !== before.beacon.enabled) {
      if (clean.beaconEnabled) this.startBeacon(); else this.stopBeacon();
    }
    if ('logsDir' in clean && clean.logsDir !== before.logsDir) {
      this.stopLog();
      this.logState = { dir: null, file: null, lastLineAt: null, lines: 0, player: this.logState.player, error: null };
      this.startLog();
    }
    this.log.info(`Settings saved: ${Object.keys(clean).join(', ')}`);
    return this.getSettings();
  }

  // ---- state for the UI ----

  getState() {
    const now = Date.now();
    const pings = {};
    for (const [name, p] of Object.entries(this.pings)) pings[name] = { ...p, msAgo: now - p.at };
    return {
      now,
      uptimeMs: now - this.startedAt,
      dryRun: this.opts.dryRun,
      signalrgb: { ...this.srgb },
      controller: this.controller.status(),
      zones: {
        enabled: this.cfg.zones.enabled,
        active: this.controller.override?.effect === effectsLib.COMPOSITOR_NAME,
        listed: this.compositorListed,
        list: this.zoneState().map((z, i) => ({ name: zonesLib.ZONE_NAMES[i], label: zonesLib.ZONE_LABELS[zonesLib.ZONE_NAMES[i]], ...z })),
        ambience: this.ambience.hex(),
      },
      beacon: { enabled: this.cfg.beacon.enabled, ...this.beacon.status(now) },
      log: {
        ...this.logState,
        msSinceLine: this.logState.lastLineAt ? now - this.logState.lastLineAt : null,
        tracker: { dead: this.tracker.dead, lowHealth: this.tracker.lowHealth, hp: this.tracker.hp },
      },
      pings,
      activity: this.activity.slice(-80),
    };
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info('Stopping, restoring baseline');
    clearInterval(this.tickTimer);
    this.stopLog();
    if (this.beaconRunning) { this.beaconRunning = false; this.beaconReader.stop(); }
    await this.controller.shutdown();
  }
}

module.exports = { BridgeApp, ROOT, PREVIEW_KEY };
