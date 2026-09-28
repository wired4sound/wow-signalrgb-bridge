'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

const { BeaconTracker } = require('../src/beacon');
const effectsLib = require('../src/effects');
const patterns = require('../src/patterns');
const { BridgeApp } = require('../src/app');
const { createServer } = require('../src/server');
const { SignalRGBClient } = require('../src/signalrgb');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const names = (evs) => evs.map((e) => e.event);
const ok = (over = {}) => ({ ok: true, hp: 1, dead: false, combat: false, encounter: false, won: false, wiped: false, ...over });

// ---------- beacon tracker ----------

test('beacon: low health with hysteresis, and no low health while dead', () => {
  const b = new BeaconTracker({ lowHealthThreshold: 0.3 });
  assert.deepStrictEqual(names(b.update(ok(), 0)), ['BEACON_UP', 'HEALTH_AVAILABLE']);
  assert.deepStrictEqual(names(b.update(ok({ hp: 0.25 }), 100)), ['PLAYER_LOW_HEALTH_START']);
  assert.deepStrictEqual(names(b.update(ok({ hp: 0.32 }), 200)), []); // inside the 5% band
  assert.deepStrictEqual(names(b.update(ok({ hp: 0.36 }), 300)), ['PLAYER_LOW_HEALTH_END']);
  assert.deepStrictEqual(names(b.update(ok({ hp: 0.1 }), 400)), ['PLAYER_LOW_HEALTH_START']);
  assert.deepStrictEqual(names(b.update(ok({ hp: 0, dead: true }), 500)), ['PLAYER_LOW_HEALTH_END', 'PLAYER_DIED']);
  assert.deepStrictEqual(names(b.update(ok({ hp: 0.05, dead: true }), 600)), []); // ghost with low hp
  assert.deepStrictEqual(names(b.update(ok({ hp: 0.5, dead: false }), 700)), ['PLAYER_ALIVE']);
});

test('beacon: death, release to ghost, revive', () => {
  const b = new BeaconTracker();
  b.update(ok(), 0);
  assert.deepStrictEqual(names(b.update(ok({ hp: 0, dead: true }), 10)), ['PLAYER_DIED']);
  assert.deepStrictEqual(names(b.update(ok({ hp: 0, dead: true, ghost: true }), 20)), ['PLAYER_GHOST']);
  assert.deepStrictEqual(names(b.update(ok({ hp: 1, dead: true, ghost: true }), 30)), []);
  assert.deepStrictEqual(names(b.update(ok({ hp: 0.5 }), 40)), ['PLAYER_ALIVE']);
  // Resurrected before releasing: died then alive, no ghost.
  assert.deepStrictEqual(names(b.update(ok({ hp: 0, dead: true }), 50)), ['PLAYER_DIED']);
  assert.deepStrictEqual(names(b.update(ok({ hp: 0.3 }), 60)), ['PLAYER_ALIVE']);
  // First reading already a ghost (reload while released): ghost only.
  const g = new BeaconTracker();
  assert.deepStrictEqual(names(g.update(ok({ dead: true, ghost: true }), 0)), ['BEACON_UP', 'HEALTH_AVAILABLE', 'PLAYER_GHOST']);
});

test('beacon: mana gauge availability and low mana with hysteresis', () => {
  const b = new BeaconTracker({ lowManaThreshold: 0.2 });
  const m = (mana, over = {}) => ok({ hasMana: true, mana, ...over });
  assert.deepStrictEqual(names(b.update(m(0.8), 0)), ['BEACON_UP', 'HEALTH_AVAILABLE', 'MANA_AVAILABLE']);
  assert.strictEqual(b.mana(), 0.8);
  assert.deepStrictEqual(names(b.update(m(0.15), 10)), ['PLAYER_LOW_MANA_START']);
  assert.deepStrictEqual(names(b.update(m(0.22), 20)), []);
  assert.deepStrictEqual(names(b.update(m(0.3), 30)), ['PLAYER_LOW_MANA_END']);
  assert.deepStrictEqual(names(b.update(m(0.1), 40)), ['PLAYER_LOW_MANA_START']);
  assert.deepStrictEqual(names(b.update(m(0.1, { dead: true, hp: 0 }), 50)), ['PLAYER_LOW_MANA_END', 'PLAYER_DIED']);
  assert.deepStrictEqual(names(b.update(ok({ hasMana: false, mana: null }), 60)), ['PLAYER_ALIVE', 'MANA_UNAVAILABLE']);
  assert.strictEqual(b.mana(), null);
  const lost = new BeaconTracker({ graceMs: 100 });
  lost.update(m(0.1), 0);
  assert.deepStrictEqual(names(lost.update({ ok: false, why: 'no marker' }, 200)),
    ['PLAYER_LOW_MANA_END', 'MANA_UNAVAILABLE', 'HEALTH_UNAVAILABLE', 'BEACON_DOWN']);
});

test('beacon: mana full fires once after a real dip', () => {
  const b = new BeaconTracker();
  const m = (mana, over = {}) => ok({ hasMana: true, mana, ...over });
  b.update(m(1), 0);
  assert.deepStrictEqual(names(b.update(m(0.98), 10)), [], 'tiny dip: not armed');
  assert.deepStrictEqual(names(b.update(m(1), 20)), []);
  b.update(m(0.6), 30);
  assert.deepStrictEqual(names(b.update(m(0.99), 40)), [], 'not full yet');
  assert.deepStrictEqual(names(b.update(m(1), 50)), ['PLAYER_MANA_FULL']);
  assert.deepStrictEqual(names(b.update(m(1), 60)), [], 'only once');
  b.update(m(0.5), 70);
  assert.deepStrictEqual(names(b.update(m(1, { dead: true, hp: 0 }), 80)), ['PLAYER_DIED'], 'not while dead');
});

test('beacon: health full fires once after a real dip, not on revive', () => {
  const b = new BeaconTracker();
  b.update(ok({ hp: 1 }), 0);
  b.update(ok({ hp: 0.5 }), 10);
  assert.ok(names(b.update(ok({ hp: 1 }), 20)).includes('PLAYER_HEALTH_FULL'));
  assert.deepStrictEqual(names(b.update(ok({ hp: 1 }), 30)), [], 'only once');
  b.update(ok({ hp: 0.4 }), 40);
  b.update(ok({ hp: 0, dead: true }), 50);
  assert.ok(!names(b.update(ok({ hp: 1 }), 60)).includes('PLAYER_HEALTH_FULL'), 'revived at full: no flash');
});

test('gauge image encodes the value in its size', () => {
  const { gaugeImage } = require('../src/server');
  const size = (buf) => [buf.readInt32LE(18), buf.readInt32LE(22)];
  assert.strictEqual(gaugeImage(0.5).toString('ascii', 0, 2), 'BM');
  assert.deepStrictEqual(size(gaugeImage(0)), [1, 1]);
  assert.deepStrictEqual(size(gaugeImage(0.5)), [501, 1]);
  assert.deepStrictEqual(size(gaugeImage(1)), [1001, 1]);
  assert.deepStrictEqual(size(gaugeImage(7)), [1001, 1]);
  assert.deepStrictEqual(size(gaugeImage(null)), [1, 2]);
  const b = gaugeImage(0.333);
  assert.strictEqual(b.length, b.readUInt32LE(2));
});

test('effects: live gauge only on slots with a value source', () => {
  assert.strictEqual(effectsLib.normalizeEffect('mana', {}).source, 'mana');
  assert.throws(() => effectsLib.normalizeEffect('death', { pattern: 'gauge' }), /needs a live value/);
  assert.strictEqual(effectsLib.normalizeEffect('death', { source: 'mana' }).source, undefined);
  const html = effectsLib.renderEffectHtml(effectsLib.normalizeEffect('mana', {}), { pingPort: 17700 });
  assert.match(html, /gauge\.bmp\?source=/);
  assert.doesNotMatch(effectsLib.renderEffectHtml(effectsLib.normalizeEffect('lowMana', {}), { pingPort: 17700 }), /gauge\.bmp/);
});

test('zones: each zone shows its own highest-priority rule', () => {
  const zones = require('../src/zones');
  const idx = { 'WoW Death': 1, 'WoW Mana': 4, 'WoW Low Health': 3 };
  const ruleZones = { Death: zones.expandZones(['all']), Mana: zones.expandZones(['pc']), Low: zones.expandZones(['pc']) };
  const e = (key, effect, priority, seq) => ({ key, effect, priority, seq });
  let r = zones.resolveZones([e('Mana', 'WoW Mana', 25, 1)], ruleZones, idx);
  assert.deepStrictEqual(r.map((z) => z.index), [0, 4, 4, 4, 4, 4]); // ceiling = ambience
  r = zones.resolveZones([e('Mana', 'WoW Mana', 25, 1), e('Low', 'WoW Low Health', 80, 2)], ruleZones, idx);
  assert.deepStrictEqual(r.map((z) => z.index), [0, 3, 3, 3, 3, 3]);
  r = zones.resolveZones([e('Mana', 'WoW Mana', 25, 1), e('Death', 'WoW Death', 100, 3)], ruleZones, idx);
  assert.deepStrictEqual(r.map((z) => z.index), [1, 1, 1, 1, 1, 1]);
  // Stock SignalRGB effects can't be drawn by the compositor: skipped.
  r = zones.resolveZones([e('Mana', 'Rainbow', 25, 1)], ruleZones, idx);
  assert.deepStrictEqual(r.map((z) => z.index), [0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(zones.packZones([1, 2, 3, 4, 5, 6]), [1 | (2 << 4) | (3 << 8), 4 | (5 << 4) | (6 << 8)]);
  assert.throws(() => zones.expandZones(['roof']), /unknown zone/);
});

test('zones: layout check flags devices outside their zones', () => {
  const zones = require('../src/zones');
  const dev = (name, x, y, w, h, extra = {}) => ({ name, x, y, w, h, rotation: 0, hue: false, ...extra });
  const r = zones.checkLayout([
    dev('Hue', 5, 11, 13, 5, { hue: true }),
    dev('Radiator', 1, 31, 311, 10),
    dev('Stray hue', 100, 150, 10, 5, { hue: true }),
    dev('PC in ceiling', 100, 5, 10, 5),
    dev('Front', 273, 140, 71, 6, { rotation: 90 }),
  ]);
  assert.deepStrictEqual(r.map((c) => c.zone), ['ceiling', 'radiator', 'rear', 'ceiling', 'bottom']);
  assert.deepStrictEqual(r.map((c) => !!c.problem), [false, false, true, true, false]);
  assert.deepStrictEqual(r[4].box.map(Math.round), [306, 108, 6, 71]); // rotated 90 around its center
  // A zone part wins over the plain rects.
  const withPart = zones.checkLayout([dev('Front', 273, 140, 71, 6, { rotation: 90 })], zones.DEFAULT_RECTS,
    { strip: [{ rect: [304, 106, 9, 75], axis: 'y', reverse: true }] });
  assert.strictEqual(withPart[0].zone, 'strip');
});

test('zones: ambience grading, easing, and word encoding', () => {
  const zones = require('../src/zones');
  assert.deepStrictEqual(zones.grade([0, 0, 0]), [0, 0, 0]);
  const g = zones.grade([40, 20, 10], { gain: 2, saturation: 1, floor: 0 });
  assert.deepStrictEqual(g, [80, 40, 20]);
  assert.deepStrictEqual(zones.grade([200, 100, 0], { gain: 2, saturation: 1, floor: 0 }), [255, 128, 0]); // hue kept on clip
  const dim = zones.grade([2, 1, 1], { gain: 1, saturation: 1, floor: 0.1 });
  assert.ok(Math.max(...dim) >= 25, 'floor lifts dim colors');
  const a = new zones.Ambience({ gain: 1, saturation: 1, floor: 0, smoothMs: 100 });
  a.update(['000000', '000000', '000000', '000000'], 0);
  a.update(['ff0000', '000000', '000000', '000000'], 100);
  assert.ok(a.colors[0][0] > 150 && a.colors[0][0] < 170, `eased ${a.colors[0][0]}`); // 1 - e^-1
  const w = new zones.Ambience({ gain: 1, saturation: 1, floor: 0, smoothMs: 0 });
  w.update(['123456', '000000', 'ffffff', '0a0b0c']);
  const words = w.words();
  const decode = (hi, lo) => [hi >> 4, ((hi & 15) << 4) | (lo >> 8), lo & 255];
  assert.deepStrictEqual(decode(words[0], words[1]), [0x12, 0x34, 0x56]);
  assert.deepStrictEqual(decode(words[4], words[5]), [255, 255, 255]);
  assert.ok(words.every((x) => x >= 0 && x <= 4095));
});

test('zones: compositor effect bakes designs and zones', () => {
  const defs = effectsLib.loadEffects('missing.json');
  const zones = require('../src/zones');
  const html = effectsLib.renderCompositorHtml(defs, { pingPort: 17700, zones: zones.ZONE_NAMES.map((n) => ({ name: n, rect: zones.DEFAULT_RECTS[n] })) });
  assert.match(html, /<title>WoW Bridge<\/title>/);
  assert.match(html, /\/api\/w\.bmp\?k=/);
  assert.match(html, /"ceiling"/);
  assert.doesNotMatch(html, /<script src=/);
  // Every zone rect sits on the 320x200 canvas.
  for (const n of zones.ZONE_NAMES) {
    const [x, y, w, h] = zones.DEFAULT_RECTS[n];
    assert.ok(x >= 0 && y >= 0 && x + w <= 320 && y + h <= 200, n);
  }
  // The script parses.
  const script = html.split('<script>')[2].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script));
});

test('beacon: combat, encounter and result edges', () => {
  const b = new BeaconTracker();
  b.update(ok(), 0);
  assert.deepStrictEqual(names(b.update(ok({ combat: true, encounter: true }), 10)), ['PLAYER_COMBAT_START', 'ENCOUNTER_START']);
  assert.deepStrictEqual(names(b.update(ok({ combat: true, won: true }), 20)), ['ENCOUNTER_END', 'ENCOUNTER_WIN']);
  assert.deepStrictEqual(names(b.update(ok({ won: true }), 30)), ['PLAYER_COMBAT_END']); // win held: no repeat
  assert.deepStrictEqual(names(b.update(ok({ wiped: true }), 40)), ['ENCOUNTER_WIPE']);
});

test('beacon: short gaps keep state, a long gap hands back to the combat log', () => {
  const b = new BeaconTracker({ graceMs: 1000 });
  b.update(ok({ hp: 0.1, combat: true }), 0);
  assert.strictEqual(b.healthy, true);
  assert.deepStrictEqual(names(b.update({ ok: false, why: 'no marker' }, 500)), []);
  assert.strictEqual(b.healthy, true);
  const out = b.update({ ok: false, why: 'no marker' }, 1200);
  assert.deepStrictEqual(names(out), ['PLAYER_LOW_HEALTH_END', 'PLAYER_COMBAT_END', 'HEALTH_UNAVAILABLE', 'BEACON_DOWN']);
  assert.strictEqual(out.find((e) => e.event === 'BEACON_DOWN').why, 'no marker');
  assert.strictEqual(b.healthy, false);
  assert.deepStrictEqual(names(b.update(ok({ hp: 0.1 }), 1300)), ['BEACON_UP', 'HEALTH_AVAILABLE', 'PLAYER_LOW_HEALTH_START']);
});

test('beacon: drops duplicate combat log events only while healthy', () => {
  const b = new BeaconTracker();
  const logEv = (event) => ({ event, synthetic: true });
  assert.strictEqual(b.shouldDropLogEvent(logEv('PLAYER_DIED'), 0), false);
  b.update(ok(), 0);
  for (const e of ['PLAYER_DIED', 'PLAYER_ALIVE', 'PLAYER_LOW_HEALTH_START', 'ENCOUNTER_START', 'ENCOUNTER_END']) {
    assert.strictEqual(b.shouldDropLogEvent(logEv(e), 10), true, e);
  }
  assert.strictEqual(b.shouldDropLogEvent(logEv('SPELL_AURA_APPLIED'), 10), false);
  // No beacon result yet (ENCOUNTER_END success may be secret): keep the log's result.
  assert.strictEqual(b.shouldDropLogEvent(logEv('ENCOUNTER_WIN'), 10), false);
  b.update(ok({ won: true }), 20);
  assert.strictEqual(b.shouldDropLogEvent(logEv('ENCOUNTER_WIN'), 5000), true);
  assert.strictEqual(b.shouldDropLogEvent({ event: 'PLAYER_DIED', beacon: true }, 5000), false);
});

// ---------- effects and patterns ----------

test('effects: normalize validates colors and clamps numbers', () => {
  const d = effectsLib.normalizeEffect('death', { colors: ['#ABCDEF', '#000000'], speedMs: 999999, floor: -5 });
  assert.strictEqual(d.name, 'WoW Death');
  assert.deepStrictEqual(d.colors, ['#abcdef', '#000000']);
  assert.strictEqual(d.speedMs, patterns.PARAMS.speedMs.max);
  assert.strictEqual(d.floor, 0);
  assert.throws(() => effectsLib.normalizeEffect('death', { colors: ['red'] }), /not a #rrggbb/);
  assert.throws(() => effectsLib.normalizeEffect('death', { pattern: 'nope' }), /unknown pattern/);
  assert.throws(() => effectsLib.normalizeEffect('nope', {}), /Unknown effect/);
  assert.strictEqual(effectsLib.normalizeEffect('death', { name: 'Renamed' }).name, 'WoW Death');
});

test('effects: generated html is self contained and installs only changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-fx-'));
  const defs = effectsLib.loadEffects(path.join(dir, 'missing.json'));
  const html = effectsLib.renderEffectHtml(defs.death, { pingPort: 17700 });
  assert.match(html, /<title>WoW Death<\/title>/);
  assert.match(html, /WowPatterns\.render/);
  assert.match(html, /effect-ping/);
  assert.doesNotMatch(html, /<script src=/);
  assert.doesNotMatch(effectsLib.renderEffectHtml(defs.death, { pingPort: 0 }), /effect-ping/);

  let r = effectsLib.installEffects(defs, dir);
  assert.strictEqual(r.added.length, Object.keys(defs).length);
  r = effectsLib.installEffects(defs, dir);
  assert.deepStrictEqual(r, { written: [], added: [] });
  r = effectsLib.installEffects({ ...defs, death: { ...defs.death, colors: ['#123456', '#654321'] } }, dir);
  assert.deepStrictEqual(r, { written: ['WoW Death'], added: [] });
});

test('patterns: every pattern renders without throwing and fills the canvas', () => {
  for (const name of Object.keys(patterns.PATTERNS)) {
    const fills = [];
    const ctx = { set fillStyle(v) { fills.push(v); }, fillRect() {} };
    const state = {};
    for (let t = 0; t < 3000; t += 250) patterns.render(ctx, 320, 200, t, { pattern: name, colors: ['#ff0000'] }, state);
    assert.ok(fills.length > 0, name);
    assert.ok(fills.every((f) => /^rgb\(\d+,\d+,\d+\)$/.test(f)), `${name}: ${fills.find((f) => !/^rgb/.test(f))}`);
  }
});

test('patterns: gauge calibration range and reverse direction', () => {
  // 32 stripes across the canvas; returns which stripes are lit (fill color) for a level.
  const lit = (level, state) => {
    const fills = [];
    const ctx = { set fillStyle(v) { fills.push(v); }, fillRect() {} };
    const st = { ...state, level, shown: level, gaugeT: 0 };
    patterns.render(ctx, 320, 200, 0, { pattern: 'gauge', colors: ['#ffffff', '#000000'] }, st);
    return fills.map((f) => (f === 'rgb(255,255,255)' ? 1 : f === 'rgb(0,0,0)' ? 0 : 0.5));
  };
  const count = (a) => a.filter((v) => v === 1).length;
  // Plain: 50% lights the left half.
  let a = lit(0.5, {});
  assert.strictEqual(count(a), 16);
  assert.strictEqual(a[0], 1);
  assert.strictEqual(a[31], 0);
  // Reverse: 50% lights the right half.
  a = lit(0.5, { reverse: true });
  assert.strictEqual(a[0], 0);
  assert.strictEqual(a[31], 1);
  // Range [0, 0.75] + reverse: the right quarter (hidden) stays lit; 100% -> 0% sweeps 0..0.75.
  a = lit(0.99, { reverse: true, range: [0, 0.75] });
  assert.ok(a[0] < 1 && a[31] === 1, 'just below full: leftmost stripe starts to empty');
  a = lit(0, { reverse: true, range: [0, 0.75] });
  assert.strictEqual(count(a), 8, 'empty: only the hidden right quarter is lit');
  a = lit(1, { reverse: true, range: [0, 0.75] });
  assert.strictEqual(count(a), 32);
});

test('patterns: live color goes full -> middle -> empty', () => {
  const color = (level) => {
    let fill;
    const ctx = { set fillStyle(v) { fill = v; }, fillRect() {} };
    patterns.render(ctx, 320, 200, 0, { pattern: 'gaugeColor', colors: ['#00ff00', '#ffd000', '#ff0000'] },
      { level, shown: level, gaugeT: 0 });
    return fill;
  };
  assert.strictEqual(color(1), 'rgb(0,255,0)');
  assert.strictEqual(color(0.5), 'rgb(255,208,0)');
  assert.strictEqual(color(0), 'rgb(255,0,0)');
});

// ---------- app + API ----------

function mockSignalRGB(extraNames = []) {
  const state = { current: 'Solid Color', applied: [] };
  const list = ['Solid Color', 'Rainbow', effectsLib.COMPOSITOR_NAME, ...Object.values(effectsLib.DEFAULT_EFFECTS).map((e) => e.name), ...extraNames];
  const effects = list.map((n) => ({ id: `${n}.html`, attributes: { name: n } }));
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const send = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok', data })); };
      const url = decodeURIComponent(req.url);
      if (req.method === 'GET' && url === '/api/v1/lighting') return send({ id: state.current, attributes: { name: state.current, enabled: true, global_brightness: 100 } });
      if (req.method === 'GET' && url === '/api/v1/lighting/effects') return send({ items: effects });
      const m = /^\/api\/v1\/lighting\/effects\/(.+)\/apply$/.exec(url);
      const hit = m && req.method === 'POST' && effects.find((e) => e.id === m[1]);
      if (hit) {
        state.current = hit.attributes.name;
        state.applied.push(state.current);
        return send({});
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

class FakeReader extends EventEmitter {
  start() { this.started = true; }
  stop() { this.started = false; }
}

async function startApp({ dryRun = false, zones = false } = {}) {
  const srgb = await mockSignalRGB();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-app-'));
  const logs = path.join(dir, 'Logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    logsDir: logs, minApplyIntervalMs: 0, ui: { port: 0 }, beacon: { graceMs: 400 },
    zones: { enabled: zones, ambience: { gain: 1, saturation: 1, floor: 0, smoothMs: 0 } },
    watchdog: { enabled: false },
  }));
  fs.copyFileSync(path.join(__dirname, '..', 'rules.json'), path.join(dir, 'rules.json'));
  const reader = new FakeReader();
  let restarts = 0;
  const app = new BridgeApp({
    configFile: path.join(dir, 'config.json'),
    rulesFile: path.join(dir, 'rules.json'),
    effectsFile: path.join(dir, 'effects.json'),
    effectsDir: path.join(dir, 'Effects'),
    client: new SignalRGBClient({ port: srgb.port }),
    beaconReader: reader,
    restartSignalRGB: async () => { restarts++; },
    dryRun,
  });
  app.log = { debug() {}, info() {}, warn() {}, error() {} };
  app.controller.log = app.log;
  app.engine.log = app.log;
  await app.start();
  const server = createServer(app, { port: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = { 'X-Bridge': '1' }) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const close = async () => {
    await app.stop();
    server.close();
    srgb.server.close();
    // The watcher polls; give stop() a moment, then clean up.
    await sleep(20);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, srgb, reader, dir, call, close, base, restarts: () => restarts };
}

test('api: rejects writes without the X-Bridge header and bad Host headers', async () => {
  const t = await startApp();
  try {
    assert.strictEqual((await t.call('PUT', '/api/settings', { lowHealthThreshold: 0.4 }, {})).status, 403);
    const port = new URL(t.base).port;
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.strictEqual(status, 403);
    assert.strictEqual((await t.call('GET', '/api/state')).status, 200);
    const page = await fetch(`${t.base}/`);
    assert.match(await page.text(), /WoW Lighting Bridge/);
    assert.strictEqual((await fetch(`${t.base}/patterns.js`)).status, 200);
  } finally {
    await t.close();
  }
});

test('api: beacon readings drive effects; late combat log duplicates are dropped', async () => {
  const t = await startApp();
  try {
    t.reader.emit('reading', ok());
    t.reader.emit('reading', ok({ hp: 0.2 }));
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'WoW Low Health');
    let s = (await t.call('GET', '/api/state')).body;
    assert.strictEqual(s.beacon.healthy, true);
    assert.deepStrictEqual(s.controller.entries.map((e) => e.key), ['Low Health', 'Health Gauge']);

    t.reader.emit('reading', ok({ hp: 0, dead: true }));
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'WoW Death');

    // A late combat log PLAYER_ALIVE must not end the death effect while the beacon owns state.
    t.app.parser.parse = () => ({ event: 'SPELL_CAST_SUCCESS' });
    t.app.tracker.process = (ev) => [ev, { event: 'PLAYER_ALIVE', synthetic: true, destIsPlayer: true }];
    t.app.handleLine('stub');
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'WoW Death');

    t.reader.emit('reading', ok({ hp: 1 }));
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'Solid Color');

    // Beacon lost beyond the grace period: marked down, log takes over.
    t.reader.emit('reading', { ok: false, why: 'no marker' });
    await sleep(450);
    t.app.feedBeacon(null);
    s = (await t.call('GET', '/api/state')).body;
    assert.strictEqual(s.beacon.healthy, false);
    assert.strictEqual(s.beacon.why, 'no marker');
  } finally {
    await t.close();
  }
});

test('api: settings update the live trackers and persist', async () => {
  const t = await startApp();
  try {
    const r = await t.call('PUT', '/api/settings', { lowHealthThreshold: 0.4 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(t.app.beacon.threshold, 0.4);
    assert.strictEqual(t.app.tracker.threshold, 0.4);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(t.dir, 'config.json'), 'utf8')).lowHealthThreshold, 0.4);
    assert.strictEqual((await t.call('PUT', '/api/settings', { lowHealthThreshold: 5 })).status, 400);
    assert.strictEqual((await t.call('PUT', '/api/settings', { bogus: 1 })).status, 400);

    await t.call('PUT', '/api/settings', { beaconEnabled: false });
    assert.strictEqual(t.reader.started, false);
    await t.call('PUT', '/api/settings', { beaconEnabled: true });
    assert.strictEqual(t.reader.started, true);

    await t.call('PUT', '/api/settings', { baseline: 'Rainbow' });
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'Rainbow');
    assert.strictEqual(t.app.controller.followManual, false);
  } finally {
    await t.close();
  }
});

test('api: editing an effect rewrites its file and re-applies it if showing', async () => {
  const t = await startApp();
  try {
    await t.call('POST', '/api/preview', { effect: 'WoW Death', ms: 5000 });
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'WoW Death');
    const applied = t.srgb.state.applied.length;

    const r = await t.call('PUT', '/api/effects/death', { ...t.app.effects.death, colors: ['#ff00ff', '#00ffff'] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.colors, ['#ff00ff', '#00ffff']);
    await sleep(40);
    assert.strictEqual(t.srgb.state.applied.length, applied + 1, 'effect re-applied');
    const html = fs.readFileSync(path.join(t.dir, 'Effects', 'WoW Death.html'), 'utf8');
    assert.match(html, /#ff00ff/);
    assert.match(fs.readFileSync(path.join(t.dir, 'effects.json'), 'utf8'), /#ff00ff/);

    assert.strictEqual((await t.call('PUT', '/api/effects/death', { colors: ['nope'] })).status, 400);

    // Effect heartbeat from inside SignalRGB (an <img> request, no header).
    const hash = effectsLib.designHash(t.app.effects.death);
    const ping = await fetch(`${t.base}/api/effect-ping?name=WoW%20Death&frames=120&v=${hash}`);
    assert.strictEqual(ping.headers.get('content-type'), 'image/gif');
    const s = (await t.call('GET', '/api/state')).body;
    assert.strictEqual(s.pings['WoW Death'].frames, 120);
    assert.strictEqual(s.pings['WoW Death'].current, true);

    await t.call('POST', '/api/preview/stop');
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'Solid Color');

    const reset = await t.call('POST', '/api/effects/death/reset');
    assert.deepStrictEqual(reset.body.colors, effectsLib.DEFAULT_EFFECTS.death.colors);
  } finally {
    await t.close();
  }
});

test('api: rules are validated, saved, and changed rules end their effect', async () => {
  const t = await startApp();
  try {
    t.reader.emit('reading', ok());
    t.reader.emit('reading', ok({ hp: 0.1 }));
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'WoW Low Health');

    const rules = (await t.call('GET', '/api/rules')).body;
    const bad = JSON.parse(JSON.stringify(rules));
    bad.rules[0].dest = 'me';
    assert.strictEqual((await t.call('PUT', '/api/rules', bad)).status, 400);

    const next = JSON.parse(JSON.stringify(rules));
    next.rules.find((r) => r.name === 'Low Health').effect = 'Rainbow';
    assert.strictEqual((await t.call('PUT', '/api/rules', next)).status, 200);
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'Solid Color', 'changed rule was cleared');
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'rules.json'), 'utf8'));
    assert.strictEqual(saved.rules.find((r) => r.name === 'Low Health').effect, 'Rainbow');

    // Next low health uses the new effect.
    t.reader.emit('reading', ok({ hp: 1 }));
    t.reader.emit('reading', ok({ hp: 0.1 }));
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'Rainbow');
  } finally {
    await t.close();
  }
});

test('api: install restarts SignalRGB only when an effect is missing', async () => {
  const t = await startApp();
  try {
    let r = await t.call('POST', '/api/effects/install');
    assert.deepStrictEqual(r.body, { restarted: false, missing: [] });
    assert.strictEqual(t.restarts(), 0);
    t.app.client.listEffects = async () => [{ id: 'Solid Color.html', name: 'Solid Color' }];
    r = await t.call('POST', '/api/effects/install');
    assert.strictEqual(r.body.restarted, true);
    assert.ok(r.body.missing.includes('WoW Death'));
    assert.strictEqual(t.restarts(), 1);
  } finally {
    await t.close();
  }
});

test('api: zones compositor while in game, zone words and ambience over the image channel', async () => {
  const t = await startApp({ zones: true });
  const word = async (k) => {
    const buf = Buffer.from(await (await fetch(`${t.base}/api/w.bmp?k=${k}`)).arrayBuffer());
    return buf.readInt32LE(22) === 2 ? null : buf.readInt32LE(18) - 1;
  };
  try {
    assert.ok(fs.existsSync(path.join(t.dir, 'Effects', 'WoW Bridge.html')));
    assert.strictEqual(t.srgb.state.current, 'Solid Color'); // not in game yet
    t.reader.emit('reading', ok({ hasMana: true, mana: 0.5, amb: ['102030', '000000', 'ff0000', '0000ff'] }));
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'WoW Bridge');
    const idx = Object.keys(t.app.effects);
    const manaIdx = idx.indexOf('mana') + 1;
    // Ceiling (zone 0) shows ambience (0); the radiator (zone 1) shows the health gauge;
    // the other PC zones show the mana gauge.
    const healthIdx = idx.indexOf('health') + 1;
    assert.strictEqual(await word('z0'), 0 | (healthIdx << 4) | (manaIdx << 8));
    assert.strictEqual(await word('z1'), manaIdx | (manaIdx << 4) | (manaIdx << 8));
    const hi = await word('a0h'), lo = await word('a0l');
    assert.deepStrictEqual([hi >> 4, ((hi & 15) << 4) | (lo >> 8), lo & 255], [0x10, 0x20, 0x30]);
    assert.strictEqual(await word('bogus'), null);

    // Death is "all": the ceiling joins in.
    t.reader.emit('reading', ok({ hp: 0, dead: true, hasMana: true, mana: 0.5 }));
    await sleep(40);
    const deathIdx = idx.indexOf('death') + 1;
    assert.strictEqual((await word('z0')) & 15, deathIdx);
    assert.strictEqual(t.srgb.state.current, 'WoW Bridge', 'still one effect; zones do the switching');

    // Preview bypasses the compositor.
    await t.call('POST', '/api/preview', { effect: 'WoW Victory', ms: 2000 });
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'WoW Victory');
    await t.call('POST', '/api/preview/stop');
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'WoW Bridge');

    // Leaving the game: back to normal effect switching and the baseline.
    t.reader.emit('reading', { ok: false, why: 'no marker' });
    await sleep(450);
    t.app.feedBeacon(null);
    await sleep(40);
    assert.notStrictEqual(t.srgb.state.current, 'WoW Bridge');

    const s = (await t.call('GET', '/api/state')).body;
    assert.strictEqual(s.zones.enabled, true);
    assert.strictEqual(s.zones.list.length, 6);

    // Ceiling left out: it shows the room light (index 15) even for "all" rules.
    t.reader.emit('reading', ok({ hp: 0, dead: true, hasMana: true, mana: 0.5 }));
    await sleep(40);
    assert.strictEqual((await t.call('PUT', '/api/settings', { ceilingEnabled: false, ceilingColor: '#112233' })).status, 200);
    assert.strictEqual((await word('z0')) & 15, 15);
    assert.strictEqual(((await word('z0')) >> 4) & 15, deathIdx, 'PC still shows death');
    assert.match(fs.readFileSync(path.join(t.dir, 'Effects', 'WoW Bridge.html'), 'utf8'), /"room":"#112233"/);
    assert.strictEqual((await t.call('PUT', '/api/settings', { ceilingColor: 'red' })).status, 400);
  } finally {
    await t.close();
  }
});

test('watchdog: silent effect is re-applied, then SignalRGB is restarted', async () => {
  const t = await startApp();
  try {
    t.app.cfg.watchdog = { enabled: true, staleMs: 1000 };
    await t.call('POST', '/api/preview', { effect: 'WoW Death', ms: 60000 });
    await sleep(40);
    const t0 = Date.now();
    const applies = () => t.srgb.state.applied.filter((n) => n === 'WoW Death').length;
    const first = applies();
    // Reporting normally: nothing happens.
    t.app.effectPing({ name: 'WoW Death', frames: 10 });
    t.app.watchdog(t0 + 500);
    assert.strictEqual(t.app.wd.step, 0);
    // Silent past staleMs: re-apply.
    t.app.watchdog(t0 + 5000);
    await sleep(40);
    assert.strictEqual(t.app.wd.step, 1);
    assert.strictEqual(applies(), first + 1, 're-applied');
    // A report after the re-apply clears it.
    t.app.effectPing({ name: 'WoW Death', frames: 1 });
    t.app.watchdog(Date.now() + 100);
    assert.strictEqual(t.app.wd.step, 0);
    // Silent again (simulated time well past the last grace period): re-apply, then restart.
    t.app.watchdog(t0 + 30000);
    await sleep(40);
    assert.strictEqual(t.app.wd.step, 1);
    t.app.watchdog(t0 + 60000);
    await sleep(40);
    assert.strictEqual(t.restarts(), 1);
    // Not a bridge effect: the watchdog stays out of it.
    await t.call('POST', '/api/preview', { effect: 'Rainbow', ms: 60000 });
    await sleep(40);
    t.app.watchdog(Date.now() + 60000);
    assert.strictEqual(t.app.wd.step, 0);
  } finally {
    await t.close();
  }
});

test('whole-effect mode skips part-only gauges but keeps part-only alerts', async () => {
  const t = await startApp(); // zones off
  try {
    // Health Gauge (radiator only, live gauge) is active once the beacon is up: skipped.
    t.reader.emit('reading', ok());
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'Solid Color');
    // Low Health (right fans only, an alert) still shows on everything.
    t.reader.emit('reading', ok({ hp: 0.1 }));
    await sleep(40);
    assert.strictEqual(t.srgb.state.current, 'WoW Low Health');
  } finally {
    await t.close();
  }
});

test('dry run never writes effect files or calls SignalRGB', async () => {
  const t = await startApp({ dryRun: true });
  try {
    assert.strictEqual(fs.existsSync(path.join(t.dir, 'Effects')), false);
    t.reader.emit('reading', ok());
    t.reader.emit('reading', ok({ hp: 0.1 }));
    await sleep(40);
    assert.deepStrictEqual(t.srgb.state.applied, []);
  } finally {
    await t.close();
  }
});

// ---------- beacon reader (real PowerShell, synthetic screenshots) ----------

const onWindows = process.platform === 'win32';

// Draws a beacon strip the way the addon does, at a given pixel scale.
function drawStrip(file, { unit = 5, bar = 80, hp = 0.5, flags = [0, 0, 0], result = null, layout = 2, ghost = 0, hasMana = 1, mana = 0.6 }) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 400, 200
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(30, 34, 40))
function Box($x, $w, $r, $gg, $b, $y = 0) { $br = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($r, $gg, $b)); $g.FillRectangle($br, $x, $y, $w, ${unit}) }
$x = 0
Box $x ${unit} 255 0 255; $x += ${unit}
Box $x ${unit} ${flags[0] * 255} ${flags[1] * 255} ${flags[2] * 255}; $x += ${unit}
${layout >= 2 ? `Box $x ${unit} ${result === 'won' ? '0 255 0' : result === 'wiped' ? '255 255 255' : '0 0 0'}; $x += ${unit}` : ''}
$fill = [int][Math]::Round(${bar} * ${hp})
if ($fill -gt 0) { Box $x $fill 255 0 0 }
Box ($x + $fill) (${bar} - $fill) 0 0 255
${layout === 3 ? `
$y = ${unit}
Box 0 ${unit} 255 255 0 $y
Box ${unit} ${unit} ${ghost * 255} ${hasMana * 255} 0 $y
Box ${unit * 2} ${unit} 0 0 0 $y
$mfill = [int][Math]::Round(${bar} * ${mana})
if ($mfill -gt 0) { Box ${unit * 3} $mfill 0 255 255 $y }
Box (${unit * 3} + $mfill) (${bar} - $mfill) 0 255 0 $y` : ''}
$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
}

function readStrip(file) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, '..', 'tools', 'beacon-reader.ps1'), '-ImagePath', file], { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(out.trim());
}

test('beacon reader decodes synthetic strips (both addon layouts)', { skip: !onWindows, timeout: 60000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-strip-'));
  try {
    const cases = [
      [{ hp: 0.5, flags: [0, 1, 0] }, { hp: 0.5, dead: false, combat: true, encounter: false, won: false, wiped: false, layout: 2 }],
      [{ hp: 0.25, flags: [0, 1, 1], result: 'won' }, { hp: 0.25, combat: true, encounter: true, won: true, wiped: false, layout: 2 }],
      [{ hp: 0, flags: [1, 0, 0], result: 'wiped' }, { hp: 0, dead: true, won: false, wiped: true, layout: 2 }],
      [{ hp: 1, layout: 1, unit: 4, bar: 76 }, { hp: 1, layout: 1, dead: false }],
      [{ hp: 0.4, layout: 1, flags: [1, 0, 0] }, { hp: 0.4, layout: 1, dead: true }],
      [{ hp: 0.7, layout: 3, mana: 0.35 }, { hp: 0.7, layout: 3, hasMana: true, mana: 0.35, ghost: false }],
      [{ hp: 1, layout: 3, flags: [1, 0, 0], ghost: 1, mana: 1 }, { layout: 3, dead: true, ghost: true, mana: 1 }],
      [{ hp: 0.9, layout: 3, hasMana: 0, mana: 0 }, { layout: 3, hasMana: false, mana: null }],
      [{ hp: 0.5, layout: 3, unit: 4, bar: 76, mana: 0 }, { layout: 3, hasMana: true, mana: 0 }],
    ];
    cases.forEach(([draw, want], i) => {
      const file = path.join(dir, `s${i}.png`);
      drawStrip(file, draw);
      const got = readStrip(file);
      assert.strictEqual(got.ok, true, JSON.stringify(got));
      for (const [k, v] of Object.entries(want)) {
        if ((k === 'hp' || k === 'mana') && typeof v === 'number') assert.ok(Math.abs(got[k] - v) < 0.02, `case ${i}: ${k} ${got[k]} vs ${v}`);
        else assert.strictEqual(got[k], v, `case ${i}: ${k}`);
      }
    });
    const blank = path.join(dir, 'blank.png');
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 200, 100; $b.Save('${blank.replace(/'/g, "''")}')`], { windowsHide: true });
    const b = readStrip(blank);
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.why, 'no marker');
    assert.deepStrictEqual(b.amb, ['000000', '000000', '000000', '000000']);
    // Ambience: 4 vertical slices of the view, left to right.
    const amb = path.join(dir, 'amb.png');
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap 400, 200; $g = [System.Drawing.Graphics]::FromImage($b)
$cols = @(@(200,0,0), @(0,200,0), @(0,0,200), @(90,90,90))
for ($i = 0; $i -lt 4; $i++) { $c = $cols[$i]; $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($c[0],$c[1],$c[2]))), $i * 100, 0, 100, 200) }
$b.Save('${amb.replace(/'/g, "''")}')`], { windowsHide: true });
    assert.deepStrictEqual(readStrip(amb).amb, ['c80000', '00c800', '0000c8', '5a5a5a']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
