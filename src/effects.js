'use strict';
// Custom SignalRGB effects. Each effect is a stored design (pattern, colors, speed) in
// effects.json that is baked into a self-contained HTML file in SignalRGB's user
// Effects folder.
//
// Verified against SignalRGB 2.5.74:
// - New effect files are only discovered when SignalRGB starts.
// - Edits to an existing file are picked up the next time that effect is applied.
// - Effect pages can load images from localhost, but fetch/XHR/<script src> are blocked,
//   so settings have to be baked into the file rather than fetched live.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PATTERNS, PARAMS } = require('./patterns');

const PATTERNS_SRC = fs.readFileSync(path.join(__dirname, 'patterns.js'), 'utf8');

// id -> default design. The ids are stable; names are the SignalRGB effect names.
// `source` marks a slot that can show a live value (gauge pattern); the effect polls
// /api/gauge.bmp?source=<source> for it.
const DEFAULT_EFFECTS = {
  death:     { name: 'WoW Death',       pattern: 'solid',   colors: ['#ff0000'], brightness: 100 },
  ghost:     { name: 'WoW Ghost',       pattern: 'mix',     colors: ['#ffffff', '#5ec8ff'], speedMs: 4500, floor: 25, drift: 30, brightness: 100 },
  lowHealth: { name: 'WoW Low Health',  pattern: 'pulse',   colors: ['#ff0000'], speedMs: 1100, floor: 10, brightness: 100 },
  health:    { name: 'WoW Health',      pattern: 'gaugeColor', colors: ['#00ff00', '#ffd000', '#ff0000'], brightness: 100, source: 'health' },
  healthFull: { name: 'WoW Health Full', pattern: 'flash',  colors: ['#5dff5d', '#000000'], speedMs: 500, brightness: 100 },
  mana:      { name: 'WoW Mana',        pattern: 'gauge',   colors: ['#0050ff', '#000614'], brightness: 100, source: 'mana' },
  lowMana:   { name: 'WoW Low Mana',    pattern: 'pulse',   colors: ['#0080ff'], speedMs: 700, floor: 5, brightness: 100 },
  manaFull:  { name: 'WoW Mana Full',   pattern: 'flash',   colors: ['#4aa0ff', '#000000'], speedMs: 500, brightness: 100 },
  bossFight: { name: 'WoW Boss Fight',  pattern: 'wave',    colors: ['#ff4000', '#801000', '#ff9000'], speedMs: 4000, brightness: 100 },
  victory:   { name: 'WoW Victory',     pattern: 'sparkle', colors: ['#ffb000', '#ffffff', '#ffe066'], speedMs: 900, floor: 30, density: 60, brightness: 100 },
  wipe:      { name: 'WoW Wipe',        pattern: 'sweep',   colors: ['#ff2000', '#1a0000'], speedMs: 1600, width: 35, brightness: 100 },
  bloodlust: { name: 'WoW Bloodlust',   pattern: 'wave',    colors: ['#ff0000', '#ff6a00', '#8b0000'], speedMs: 900, brightness: 100 },
  combat:    { name: 'WoW In Combat',   pattern: 'breathe', colors: ['#ff5a1f'], speedMs: 3000, floor: 35, brightness: 80 },
  crit:      { name: 'WoW Crit',        pattern: 'flash',   colors: ['#ffffff', '#ffd000'], speedMs: 200, brightness: 100 },
};

const HEX = /^#[0-9a-f]{6}$/i;

function liveSlots() {
  return Object.values(DEFAULT_EFFECTS).filter((e) => e.source).map((e) => e.name).join(', ');
}

function defaultEffectsDir() {
  return path.join(os.homedir(), 'Documents', 'WhirlwindFX', 'Effects');
}

// Validates and normalizes one design. Throws with a readable message.
function normalizeEffect(id, def, base = DEFAULT_EFFECTS[id]) {
  if (!base) throw new Error(`Unknown effect "${id}"`);
  // Names and sources are fixed: renaming would need a SignalRGB restart.
  const d = { ...base, ...def, name: base.name };
  if (base.source) d.source = base.source; else delete d.source;
  if (!PATTERNS[d.pattern]) throw new Error(`${d.name}: unknown pattern "${d.pattern}"`);
  if (PATTERNS[d.pattern].live && !d.source) throw new Error(`${d.name}: the ${PATTERNS[d.pattern].label} pattern needs a live value; only ${liveSlots()} have one`);
  if (!Array.isArray(d.colors) || !d.colors.length) throw new Error(`${d.name}: colors must be a non-empty list`);
  d.colors = d.colors.slice(0, 3).map((c) => {
    if (!HEX.test(c)) throw new Error(`${d.name}: "${c}" is not a #rrggbb color`);
    return c.toLowerCase();
  });
  for (const key of Object.keys(PARAMS)) {
    if (d[key] === undefined) continue;
    const p = PARAMS[key];
    const n = Number(d[key]);
    if (!Number.isFinite(n)) throw new Error(`${d.name}: ${key} must be a number`);
    d[key] = Math.min(p.max, Math.max(p.min, Math.round(n)));
  }
  return d;
}

function loadEffects(file) {
  let stored = {};
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    stored = raw.effects || raw;
  }
  const out = {};
  for (const id of Object.keys(DEFAULT_EFFECTS)) out[id] = normalizeEffect(id, stored[id] || {});
  return out;
}

function saveEffects(file, effects) {
  fs.writeFileSync(file, `${JSON.stringify({ effects }, null, 2)}\n`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// pingPort: the bridge's web server. The effect loads a tiny image from it every few
// seconds (images are the one request type SignalRGB allows) so the bridge can confirm
// the effect is really rendering, and see any script error.
function designHash(def) {
  return crypto.createHash('sha1').update(JSON.stringify(def)).digest('hex').slice(0, 8);
}

function renderEffectHtml(def, { pingPort = 17700 } = {}) {
  const cfg = JSON.stringify(def).replace(/</g, '\\u003c');
  const hash = designHash(def);
  const ping = Number(pingPort) > 0 ? `
  var frames = 0, lastError = "";
  window.onerror = function (msg, src, line) { lastError = String(msg) + " @" + line; ping(); };
  function ping() {
    var img = new Image();
    img.src = "http://127.0.0.1:${Number(pingPort)}/api/effect-ping?name=" + encodeURIComponent(CFG.name)
      + "&v=${hash}&frames=" + frames + "&level=" + (typeof state.level === "number" ? state.level : "") + "&error=" + encodeURIComponent(lastError) + "&t=" + Date.now();
  }
  setInterval(ping, 3000);
  setTimeout(ping, 300);` : `
  var frames = 0;`;
  // Live value for gauges. fetch/XHR are blocked in SignalRGB, but an image's size is
  // readable: width - 1 is the value in 0.1% steps; height 2 means "no value".
  const live = PATTERNS[def.pattern]?.live && def.source && Number(pingPort) > 0 ? `
  state.level = 0;
  function pollLevel() {
    var img = new Image();
    img.onload = function () { state.level = img.naturalHeight === 2 ? 0 : (img.naturalWidth - 1) / 1000; };
    img.src = "http://127.0.0.1:${Number(pingPort)}/api/gauge.bmp?source=" + encodeURIComponent(CFG.source) + "&t=" + Date.now();
  }
  setInterval(pollLevel, 100);
  pollLevel();` : '';
  return `<head>
  <title>${escapeHtml(def.name)}</title>
  <meta description="Generated by wow-signalrgb-bridge. Edit it in the bridge settings page, not here: changes are overwritten."/>
  <meta publisher="wow-signalrgb-bridge" />
</head>

<body style="margin: 0; padding: 0;">
  <canvas id="exCanvas" width="320" height="200"></canvas>
</body>

<script>
${PATTERNS_SRC}
</script>
<script>
  var CFG = ${cfg};
  var canvas = document.getElementById("exCanvas");
  var ctx = canvas.getContext("2d");
  var start = Date.now();
  var state = {};${ping}${live}
  function update() {
    WowPatterns.render(ctx, 320, 200, Date.now() - start, CFG, state);
    frames++;
    window.requestAnimationFrame(update);
  }
  window.requestAnimationFrame(update);
</script>
`;
}

const COMPOSITOR_NAME = 'WoW Bridge';

// The zone compositor: one effect holding every design. Each zone draws the design the
// bridge says is winning there (index 1..n into DESIGNS), or the game's ambience (0).
// State arrives through image sizes (see src/server.js /api/w.bmp and /api/gauge.bmp):
//   z0..z2: 2 zones x 5 bits each; a<i>h / a<i>l: ambience color i as two 12-bit words.
// roomLight: the fixed color for zones the bridge leaves out (zone index 31).
// normalColor: what PC zones show with nothing to draw while not in game (zone index 30).
function renderCompositorHtml(effects, { pingPort = 17700, zones, roomLight = '#ffffff', normalColor = '#000000' }) {
  const designs = Object.values(effects);
  if (designs.length > 29) throw new Error('The compositor supports at most 29 designs (5-bit zone indices).');
  const port = Number(pingPort);
  const hex = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
  const room = hex(roomLight, '#000000');
  const normal = hex(normalColor, '#000000');
  const data = JSON.stringify({ designs, zones, room, normal }).replace(/</g, '\\u003c');
  const hash = designHash({ designs, zones, room, normal });
  return `<head>
  <title>${COMPOSITOR_NAME}</title>
  <meta description="Generated by wow-signalrgb-bridge: draws every zone (ceiling, PC parts) at once while you play. Edit it in the bridge settings page."/>
  <meta publisher="wow-signalrgb-bridge" />
</head>

<body style="margin: 0; padding: 0;">
  <canvas id="exCanvas" width="320" height="200"></canvas>
</body>

<script>
${PATTERNS_SRC}
</script>
<script>
  var DATA = ${data};
  var BASE = "http://127.0.0.1:${port}";
  var ctx = document.getElementById("exCanvas").getContext("2d");
  var start = Date.now();
  var zoneIdx = DATA.zones.map(function () { return 0; });
  var zoneState = DATA.zones.map(function () { return { idx: -1, state: {} }; });
  var ambIn = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], ambHi = [0, 0, 0, 0], ambLo = [0, 0, 0, 0];
  var amb = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  var frames = 0, lastError = "", tick = 0, lastT = 0;
  // Live values for gauge designs (mana, health, ...), polled per source.
  var levels = {}, sources = [];
  DATA.designs.forEach(function (d) { if (d.source && sources.indexOf(d.source) < 0) sources.push(d.source); });
  sources.forEach(function (s) { levels[s] = 0; });

  function word(key, cb) {
    var img = new Image();
    img.onload = function () { if (img.naturalHeight === 1) cb(img.naturalWidth - 1); };
    img.src = BASE + "/api/w.bmp?k=" + key + "&t=" + Date.now();
  }
  function setAmb(i) {
    var hi = ambHi[i], lo = ambLo[i];
    ambIn[i] = [hi >> 4, ((hi & 15) << 4) | (lo >> 8), lo & 255];
  }
  function poll() {
    tick++;
    // 2 zones per word, 5 bits each.
    for (var p = 0; p * 2 < zoneIdx.length; p++) (function (p) {
      word("z" + p, function (v) { for (var j = 0; j < 2 && p * 2 + j < zoneIdx.length; j++) zoneIdx[p * 2 + j] = (v >> (5 * j)) & 31; });
    })(p);
    sources.forEach(function (s) {
      var img = new Image();
      img.onload = function () { levels[s] = img.naturalHeight === 2 ? 0 : (img.naturalWidth - 1) / 1000; };
      img.src = BASE + "/api/gauge.bmp?source=" + encodeURIComponent(s) + "&t=" + Date.now();
    });
    if (tick % 2 === 0) for (var i = 0; i < 4; i++) (function (i) {
      word("a" + i + "h", function (v) { ambHi[i] = v; setAmb(i); });
      word("a" + i + "l", function (v) { ambLo[i] = v; setAmb(i); });
    })(i);
  }
  function hex(c) { return c.map(function (v) { var s = Math.round(v).toString(16); return s.length < 2 ? "0" + s : s; }).join(""); }
  function ping() {
    var img = new Image();
    img.src = BASE + "/api/effect-ping?name=" + encodeURIComponent(${JSON.stringify(COMPOSITOR_NAME)})
      + "&v=${hash}&frames=" + frames + "&level=" + (levels.mana || 0) + "&hp=" + (levels.health || 0)
      + "&z=" + zoneIdx.join(".") + "&amb=" + hex(amb[0])
      + "&error=" + encodeURIComponent(lastError) + "&t=" + Date.now();
  }
  window.onerror = function (msg, src, line) { lastError = String(msg) + " @" + line; ping(); };
  setInterval(poll, 100);
  setInterval(ping, 3000);
  poll();
  setTimeout(ping, 300);

  function drawAmbience(x, y, w, h) {
    // 4 vertical slices across the whole canvas, clipped to the area being drawn.
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    for (var i = 0; i < 4; i++) {
      var c = amb[i];
      ctx.fillStyle = "rgb(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + ")";
      ctx.fillRect(i * 80, 0, 80, 200);
    }
    ctx.restore();
  }

  function update() {
    var now = Date.now(), t = now - start, dt = lastT ? now - lastT : 16;
    lastT = now;
    var k = Math.min(1, dt / 150); // ease between 5 Hz ambience samples
    for (var i = 0; i < 4; i++) for (var j = 0; j < 3; j++) amb[i][j] += (ambIn[i][j] - amb[i][j]) * k;
    drawAmbience(0, 0, 320, 200);
    for (var z = 0; z < DATA.zones.length; z++) {
      var zone = DATA.zones[z], idx = zoneIdx[z];
      // The zone's main rect plus any extra parts (a part with axis "y" is drawn rotated,
      // so a horizontal bar runs along a vertically placed device).
      var areas = [{ rect: zone.rect }].concat(zone.parts || []);
      if (idx === 31 || idx === 30) {
        ctx.fillStyle = idx === 31 ? DATA.room : DATA.normal;
        areas.forEach(function (a) { ctx.fillRect(a.rect[0], a.rect[1], a.rect[2], a.rect[3]); });
        continue;
      }
      if (!idx || !DATA.designs[idx - 1]) {
        areas.slice(1).forEach(function (a) { drawAmbience(a.rect[0], a.rect[1], a.rect[2], a.rect[3]); });
        continue;
      }
      if (zoneState[z].idx !== idx) zoneState[z] = { idx: idx, state: {}, t0: t };
      var def = DATA.designs[idx - 1], st = zoneState[z].state;
      if (def.source) st.level = levels[def.source] || 0;
      st.range = zone.gaugeRange || null;
      st.reverse = !!zone.gaugeReverse;
      for (var a = 0; a < areas.length; a++) {
        var r = areas[a].rect;
        ctx.save();
        ctx.beginPath(); ctx.rect(r[0], r[1], r[2], r[3]); ctx.clip();
        if (areas[a].axis === "y") {
          // pattern x (0..320) -> part height; pattern y (0..200) -> part width.
          if (areas[a].reverse) ctx.setTransform(0, -r[3] / 320, r[2] / 200, 0, r[0], r[1] + r[3]);
          else ctx.setTransform(0, r[3] / 320, r[2] / 200, 0, r[0], r[1]);
        }
        WowPatterns.render(ctx, 320, 200, t - zoneState[z].t0, def, st);
        ctx.restore();
      }
    }
    frames++;
    window.requestAnimationFrame(update);
  }
  window.requestAnimationFrame(update);
</script>
`;
}

function effectFile(dir, def) {
  return path.join(dir, `${def.name}.html`);
}

// Writes the given designs (plus the zone compositor when opts.zones is given). Returns
// { written, added } where added lists effect names whose files did not exist before
// (SignalRGB needs a restart to see those).
function installEffects(effects, dir = defaultEffectsDir(), opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const added = [];
  const files = Object.values(effects).map((def) => ({ name: def.name, html: renderEffectHtml(def, opts) }));
  if (opts.zones) files.push({ name: COMPOSITOR_NAME, html: renderCompositorHtml(effects, opts) });
  for (const { name, html } of files) {
    const file = effectFile(dir, { name });
    const existed = fs.existsSync(file);
    if (existed && fs.readFileSync(file, 'utf8') === html) continue;
    fs.writeFileSync(file, html);
    written.push(name);
    if (!existed) added.push(name);
  }
  return { written, added };
}

module.exports = {
  DEFAULT_EFFECTS, COMPOSITOR_NAME, designHash, loadEffects, saveEffects, normalizeEffect,
  renderEffectHtml, renderCompositorHtml, installEffects, defaultEffectsDir,
};
