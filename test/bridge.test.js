'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { CombatLogParser, splitFields } = require('../src/parser');
const { StateTracker } = require('../src/tracker');
const { RuleEngine, loadRules } = require('../src/rules');
const { SignalRGBClient } = require('../src/signalrgb');
const { EffectController } = require('../src/controller');

const TS = '9/26/2026 19:26:01.1230-4  ';
const ME = 'Player-4184-00A1B2C3,"Testchar-Forever",0x511,0x0';
const BOSS = 'Creature-0-4184-409-1234-11502-0000ABCDEF,"Ragnaros",0x10a48,0x0';
const ADV_ME = (hp) => `Player-4184-00A1B2C3,0000000000000000,${hp},5000,100,200,1500,0,0,0,0,100,100,0,-1.0,2.0,232,1.57,60`;

test('splitFields handles quotes and brackets', () => {
  assert.deepStrictEqual(splitFields('A,"b, c",[1,2],(3,4),nil'), ['A', 'b, c', '[1,2]', '(3,4)', 'nil']);
});

test('parses mainline SPELL_DAMAGE crit with advanced block', () => {
  const p = new CombatLogParser();
  p.parse(`${TS}COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,1.60.1,PROJECT_ID,18`);
  const ev = p.parse(`${TS}SPELL_DAMAGE,${ME},${BOSS},133,"Fireball",0x4,${ADV_ME(5000)},3900,3900,-1,4,0,0,0,1,nil,nil,ST`);
  assert.strictEqual(ev.event, 'SPELL_DAMAGE');
  assert.strictEqual(ev.spellId, 133);
  assert.strictEqual(ev.spellName, 'Fireball');
  assert.strictEqual(ev.sourceFlags, 0x511);
  assert.strictEqual(ev.adv.currentHP, 5000);
  assert.strictEqual(ev.adv.level, 60);
  assert.strictEqual(ev.amount, 3900);
  assert.strictEqual(ev.overkill, -1);
  assert.strictEqual(ev.critical, true);
  assert.strictEqual(ev.aoe, false);
});

test('parses classic-layout damage without baseAmount', () => {
  const p = new CombatLogParser();
  p.parse('9/26 19:26:01.123  COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,1.15.7,PROJECT_ID,2');
  const adv17 = 'Player-4184-00A1B2C3,0000000000000000,1000,5000,100,200,1500,0,0,100,100,0,-1.0,2.0,232,1.57,60';
  const ev = p.parse(`9/26 19:26:01.123  SWING_DAMAGE,${BOSS},${ME},${adv17},500,-1,1,0,0,0,nil,nil,nil,nil`);
  assert.strictEqual(ev.adv.currentHP, 1000);
  assert.strictEqual(ev.adv.level, 60);
  assert.strictEqual(ev.amount, 500);
  assert.strictEqual(ev.overkill, -1);
  assert.strictEqual(ev.critical, false);
});

test('learns advanced length from SPELL_CAST_SUCCESS', () => {
  const p = new CombatLogParser();
  p.parse(`${TS}SPELL_CAST_SUCCESS,${ME},${BOSS},133,"Fireball",0x4,${ADV_ME(5000)}`);
  assert.strictEqual(p.advLen, 19);
});

test('parses real WoW Forever lines', () => {
  const p = new CombatLogParser();
  p.parse('9/26/2026 19:26:23.477-4  COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,1.60.1,PROJECT_ID,18');
  const dmg = p.parse('9/26/2026 20:54:02.549-4  SPELL_DAMAGE,Player-0000-00000001,"Testpriest-ClassicBetaPvP-",0x511,0x80000000,Creature-0-4615-2999-93242-250484-0002B86879,"Spider",0x10a48,0x80000000,8102,"Mind Blast",0x20,Creature-0-4615-2999-93242-250484-0002B86879,0000000000000000,827,924,64,0,685,0,0,0,1,0,0,0,1724.40,118.07,0,2.7583,15,97,96,-1,32,0,0,0,nil,nil,nil,ST');
  assert.strictEqual(dmg.spellName, 'Mind Blast');
  assert.strictEqual(dmg.adv.currentHP, 827);
  assert.strictEqual(dmg.adv.level, 15);
  assert.strictEqual(dmg.amount, 97);
  assert.strictEqual(dmg.overkill, -1);
  assert.strictEqual(dmg.critical, false);
  const env = p.parse('9/26/2026 22:14:25.396-4  ENVIRONMENTAL_DAMAGE,0000000000000000,nil,0x80000000,0x80000000,Player-0000-00000010,"Otherplayer-ClassicBetaPvP2-",0x548,0x80000000,Player-0000-00000010,0000000000000000,456,501,370,0,860,0,0,0,0,512,512,0,1614.40,219.55,1458,5.4321,9,Falling,45,45,0,1,0,0,0,nil,nil,nil');
  assert.strictEqual(env.environmentalType, 'Falling');
  assert.strictEqual(env.amount, 45);
  assert.strictEqual(env.adv.currentHP, 456);
  const heal = p.parse('9/26/2026 20:53:46.632-4  SPELL_HEAL,Player-0000-00000011,"Healer-ClassicBetaPvP2-",0x528,0x80000000,Player-0000-00000011,"Healer-ClassicBetaPvP2-",0x528,0x80000000,647,"Holy Light",0x2,Player-0000-00000011,0000000000000000,1141,0,556,0,1169,0,0,0,0,967,0,0,0.00,0.00,0,0.0000,0,240,240,101,0,1');
  assert.strictEqual(heal.amount, 240);
  assert.strictEqual(heal.overhealing, 101);
  assert.strictEqual(heal.critical, true);
});

test('parses encounter and aura events', () => {
  const p = new CombatLogParser();
  const end = p.parse(`${TS}ENCOUNTER_END,672,"Ragnaros",9,40,1,245000`);
  assert.strictEqual(end.success, true);
  assert.strictEqual(end.encounterName, 'Ragnaros');
  const aura = p.parse(`${TS}SPELL_AURA_APPLIED,${ME},${ME},2825,"Bloodlust",0x8,BUFF`);
  assert.strictEqual(aura.auraType, 'BUFF');
  assert.strictEqual(aura.spellName, 'Bloodlust');
});

test('tracker identifies player and emits low health, death, alive', () => {
  const p = new CombatLogParser();
  const t = new StateTracker({ lowHealthThreshold: 0.3 });
  const names = (line) => t.process(p.parse(TS + line)).map((e) => e.event);

  assert.deepStrictEqual(names(`SPELL_CAST_SUCCESS,${ME},${BOSS},133,"Fireball",0x4,${ADV_ME(5000)}`),
    ['SPELL_CAST_SUCCESS', 'PLAYER_IDENTIFIED']);
  assert.ok(names(`SPELL_DAMAGE,${BOSS},${ME},1,"Hit",0x4,${ADV_ME(1000)},4000,4000,-1,4,0,0,0,nil,nil,nil,nil,ST`)
    .includes('PLAYER_LOW_HEALTH_START'));
  assert.ok(names(`SPELL_HEAL,${ME},${ME},2,"Heal",0x2,${ADV_ME(4000)},3000,3000,0,0,nil`)
    .includes('PLAYER_LOW_HEALTH_END'));
  assert.ok(names(`UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,${ME},0,0`).includes('PLAYER_DIED'));
  assert.ok(!names(`SPELL_AURA_REMOVED,${ME},${ME},9,"Buff",0x1,BUFF`).includes('PLAYER_ALIVE'));
  assert.ok(names(`SPELL_CAST_SUCCESS,${ME},${BOSS},133,"Fireball",0x4,${ADV_ME(5000)}`).includes('PLAYER_ALIVE'));
});

test('rules activate and clear with inherited spell filter', () => {
  const rules = loadRules({
    rules: [{
      name: 'Lust', event: 'SPELL_AURA_APPLIED', spellName: 'Bloodlust', dest: 'player',
      effect: 'X', durationMs: 40000, clearOn: { event: 'SPELL_AURA_REMOVED', dest: 'player' },
    }],
  });
  const calls = [];
  const ctl = {
    active: new Set(),
    isActive(k) { return this.active.has(k); },
    activate(e) { this.active.add(e.key); calls.push(`+${e.key}`); },
    clear(k) { this.active.delete(k); calls.push(`-${k}`); },
  };
  const engine = new RuleEngine(rules, ctl);
  const base = { destIsPlayer: true, destFlags: 0x511 };
  engine.handle({ ...base, event: 'SPELL_AURA_APPLIED', spellName: 'Bloodlust' });
  engine.handle({ ...base, event: 'SPELL_AURA_REMOVED', spellName: 'Arcane Intellect' });
  engine.handle({ ...base, event: 'SPELL_AURA_REMOVED', spellName: 'Bloodlust' });
  assert.deepStrictEqual(calls, ['+Lust', '-Lust']);
});

test('rules reject bad unit filters', () => {
  assert.throws(() => loadRules({ rules: [{ name: 'a', event: 'X', effect: 'Y', dest: 'me' }] }), /dest must be/);
});

// Mock SignalRGB API to exercise the client and controller over real HTTP.
function mockSignalRGB() {
  const state = { current: 'Rainbow', applied: [], presets: [] };
  const effects = [
    { id: 'Rainbow.html', attributes: { name: 'Rainbow' } },
    { id: '-Abc123', attributes: { name: 'WoW Death' } },
    { id: '-Def456', attributes: { name: 'WoW Bloodlust' } },
  ];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ api_version: '1.0', status: 'ok', data })); };
      const url = decodeURIComponent(req.url);
      if (req.method === 'GET' && url === '/api/v1/lighting') {
        return send({ id: state.current, attributes: { name: state.current, enabled: true, global_brightness: 50 } });
      }
      if (req.method === 'GET' && url === '/api/v1/lighting/effects') return send({ items: effects });
      const m = /^\/api\/v1\/lighting\/effects\/(.+)\/(apply|presets)$/.exec(url);
      if (m && m[2] === 'apply' && req.method === 'POST') {
        const e = effects.find((x) => x.id === m[1]);
        state.current = e.attributes.name;
        state.applied.push(state.current);
        return send({});
      }
      if (m && m[2] === 'presets' && req.method === 'PATCH') {
        state.presets.push(JSON.parse(body).preset);
        return send({});
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ status: 'error', errors: [{ title: 'not found' }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('controller applies by priority and restores baseline over HTTP', async () => {
  const { server, state, port } = await mockSignalRGB();
  try {
    const client = new SignalRGBClient({ port });
    const ctl = new EffectController(client, { minApplyIntervalMs: 20 });
    await ctl.init();
    assert.strictEqual(ctl.baseline.effect, 'Rainbow');

    ctl.activate({ key: 'Lust', effect: 'WoW Bloodlust', priority: 60, durationMs: 150 });
    await sleep(60);
    ctl.activate({ key: 'Death', effect: 'WoW Death', preset: 'Grey', priority: 100 });
    await sleep(60);
    assert.strictEqual(state.current, 'WoW Death');
    assert.deepStrictEqual(state.presets, ['Grey']);

    await sleep(150); // Lust expires underneath Death: no change
    assert.strictEqual(state.current, 'WoW Death');

    ctl.clear('Death');
    await sleep(60);
    assert.strictEqual(state.current, 'Rainbow');
    assert.deepStrictEqual(state.applied, ['WoW Bloodlust', 'WoW Death', 'Rainbow']);
  } finally {
    server.close();
  }
});

test('controller reports a missing effect once and keeps running', async () => {
  const { server, port } = await mockSignalRGB();
  try {
    const errors = [];
    const log = { info() {}, warn() {}, debug() {}, error: (m) => errors.push(m) };
    const ctl = new EffectController(new SignalRGBClient({ port }), { minApplyIntervalMs: 0, log });
    await ctl.init();
    ctl.activate({ key: 'A', effect: 'Nope', durationMs: 20 });
    await sleep(80);
    ctl.activate({ key: 'A', effect: 'Nope', durationMs: 20 });
    await sleep(80);
    assert.strictEqual(errors.filter((e) => /not found/.test(e)).length, 1);
  } finally {
    server.close();
  }
});

test('controller ignores a stale read right after restoring baseline', async () => {
  // Mimics SignalRGB: GET /lighting keeps reporting the old effect after an apply.
  const client = {
    reported: 'Rainbow',
    applied: [],
    async getCurrentEffect() { return { name: this.reported }; },
    async applyByName(name) { this.applied.push(name); },
  };
  const ctl = new EffectController(client, { minApplyIntervalMs: 0, settleMs: 100 });
  await ctl.init();

  ctl.activate({ key: 'A', effect: 'Electric' });
  await sleep(20);
  client.reported = 'Electric'; // now visible
  ctl.clear('A');
  await sleep(20); // baseline restored, but the read still says Electric
  ctl.activate({ key: 'B', effect: 'Ice Storm' });
  await sleep(20);
  assert.strictEqual(ctl.baseline.effect, 'Rainbow');

  ctl.clear('B');
  await sleep(20);
  client.reported = 'Solid Color'; // manual change in SignalRGB
  await sleep(120);
  ctl.activate({ key: 'C', effect: 'Electric' });
  await sleep(20);
  assert.strictEqual(ctl.baseline.effect, 'Solid Color');
  assert.deepStrictEqual(client.applied, ['Electric', 'Rainbow', 'Ice Storm', 'Rainbow', 'Electric']);
});

test('real WoW Forever sample: boss kill and death fire in order', () => {
  const fs = require('fs');
  const path = require('path');
  const rules = loadRules(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8')));
  const calls = [];
  const ctl = {
    active: new Set(),
    isActive(k) { return this.active.has(k); },
    activate(e) { this.active.add(e.key); calls.push(`+${e.key}`); },
    clear(k) { this.active.delete(k); calls.push(`-${k}`); },
  };
  const engine = new RuleEngine(rules, ctl);
  const parser = new CombatLogParser();
  const tracker = new StateTracker();
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'forever-sample.txt'), 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const ev = parser.parse(line);
    if (ev) for (const e of tracker.process(ev)) engine.handle(e);
  }
  assert.strictEqual(tracker.playerGUID, 'Player-0000-00000001');
  assert.deepStrictEqual(calls, [
    '+Boss Fight', '-Boss Fight', '+Boss Victory',
    '+Low Health', '-Low Health', '+Death', '-Death',
  ]);
});
