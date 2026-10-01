// Lighting patterns shared by the generated SignalRGB effects and the web UI previews.
// Runs in SignalRGB's effect WebKit and in the browser, and is require()-able from Node
// (for the schema). Keep it dependency free and plain ES2015.
(function (root) {
  'use strict';

  var PATTERNS = {
    solid:   { label: 'Solid',          colors: 1, params: ['brightness'] },
    breathe: { label: 'Breathe',        colors: 1, params: ['speedMs', 'floor', 'brightness'] },
    pulse:   { label: 'Heartbeat',      colors: 1, params: ['speedMs', 'floor', 'brightness'] },
    mix:     { label: 'Breathing mix',  colors: 2, params: ['speedMs', 'floor', 'drift', 'brightness'] },
    wave:    { label: 'Color wave',     colors: 3, params: ['speedMs', 'brightness'] },
    flash:   { label: 'Flash',          colors: 2, params: ['speedMs', 'brightness'] },
    sweep:   { label: 'Sweep',          colors: 2, params: ['speedMs', 'width', 'brightness'] },
    sparkle: { label: 'Sparkle',        colors: 3, params: ['speedMs', 'floor', 'density', 'brightness'] },
    // Live value (e.g. mana) as a fill. The effect sets state.level (0..1); without one
    // (the settings page preview) it shows a slow demo sweep.
    gauge:   { label: 'Live gauge (fill left to right)', colors: 2, params: ['brightness'], live: true },
    // Same live value, but every light shows it at once (fades Empty -> Fill), so it
    // doesn't depend on where devices sit in the SignalRGB layout.
    gaugeFade: { label: 'Live gauge (all lights fade)', colors: 2, params: ['brightness'], live: true },
    // Every light shows one color that moves Full -> Middle -> Empty with the value
    // (e.g. health: green -> yellow -> red).
    gaugeColor: { label: 'Live color (full / middle / empty)', colors: 3, params: ['brightness'], live: true },
    // The fill gauge, blinking with a heartbeat (e.g. the mana bar while mana is low).
    gaugeBlink: { label: 'Live gauge, blinking', colors: 2, params: ['speedMs', 'floor', 'brightness'], live: true },
  };

  var PARAMS = {
    speedMs:    { label: 'Speed (ms per cycle)', min: 100, max: 10000, step: 50, def: 2000 },
    floor:      { label: 'Minimum brightness %', min: 0, max: 100, step: 1, def: 15 },
    brightness: { label: 'Brightness %',         min: 5, max: 100, step: 1, def: 100 },
    drift:      { label: 'Color drift speed',    min: 0, max: 100, step: 1, def: 30 },
    width:      { label: 'Band width %',         min: 5, max: 100, step: 1, def: 30 },
    density:    { label: 'Sparkle density',      min: 1, max: 100, step: 1, def: 40 },
  };

  var STRIPES = 32;

  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
  }

  function num(v, key) {
    var p = PARAMS[key];
    var n = Number(v);
    if (!isFinite(n)) n = p.def;
    return Math.min(p.max, Math.max(p.min, n));
  }

  function lerp(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function css(c, level) {
    return 'rgb(' + Math.round(c[0] * level) + ',' + Math.round(c[1] * level) + ',' + Math.round(c[2] * level) + ')';
  }

  // Resolves a stored effect definition into numbers and rgb arrays once per frame.
  function resolve(def) {
    var info = PATTERNS[def.pattern] || PATTERNS.solid;
    var colors = (def.colors || []).map(hexToRgb);
    while (colors.length < info.colors) colors.push(colors.length ? [0, 0, 0] : [255, 255, 255]);
    return {
      pattern: PATTERNS[def.pattern] ? def.pattern : 'solid',
      colors: colors,
      speedMs: num(def.speedMs, 'speedMs'),
      floor: num(def.floor, 'floor') / 100,
      brightness: num(def.brightness, 'brightness') / 100,
      drift: num(def.drift, 'drift') / 100,
      width: num(def.width, 'width') / 100,
      density: num(def.density, 'density') / 100,
    };
  }

  function stripes(ctx, w, h, colorAt) {
    var sw = w / STRIPES;
    for (var i = 0; i < STRIPES; i++) {
      ctx.fillStyle = colorAt(i / STRIPES, (i + 0.5) / STRIPES);
      ctx.fillRect(Math.floor(i * sw), 0, Math.ceil(sw) + 1, h);
    }
  }

  // state: a per-canvas object the pattern may keep things in (sparkles).
  function render(ctx, w, h, tMs, def, state) {
    var c = resolve(def);
    var phase = (tMs % c.speedMs) / c.speedMs;
    var B = c.brightness;
    var level;

    switch (c.pattern) {
      case 'breathe':
        level = c.floor + (1 - c.floor) * (Math.sin(phase * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5);
        ctx.fillStyle = css(c.colors[0], level * B);
        ctx.fillRect(0, 0, w, h);
        break;

      case 'pulse':
        // sin^2 spends more time dark, which reads as a heartbeat rather than a fade.
        level = c.floor + (1 - c.floor) * Math.pow(Math.sin(phase * Math.PI), 2);
        ctx.fillStyle = css(c.colors[0], level * B);
        ctx.fillRect(0, 0, w, h);
        break;

      case 'mix': {
        level = c.floor + (1 - c.floor) * (Math.sin(phase * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5);
        var secs = tMs / 1000;
        var driftRate = c.drift * 2;
        stripes(ctx, w, h, function (x) {
          var m = Math.sin(x * Math.PI * 2 + secs * driftRate) * 0.5 + 0.5;
          return css(lerp(c.colors[0], c.colors[1], m), level * B);
        });
        break;
      }

      case 'wave': {
        var n = c.colors.length;
        stripes(ctx, w, h, function (x) {
          var p = ((x + phase) % 1) * n;
          var i = Math.floor(p);
          var f = p - i;
          var s = f * f * (3 - 2 * f); // smoothstep between neighbours
          return css(lerp(c.colors[i % n], c.colors[(i + 1) % n], s), B);
        });
        break;
      }

      case 'flash':
        ctx.fillStyle = css(phase < 0.5 ? c.colors[0] : c.colors[1], B);
        ctx.fillRect(0, 0, w, h);
        break;

      case 'sweep': {
        var half = c.width / 2;
        var center = -half + phase * (1 + c.width);
        stripes(ctx, w, h, function (x, mid) {
          var d = Math.abs(mid - center);
          var k = d >= half ? 0 : Math.cos((d / half) * Math.PI / 2);
          return css(lerp(c.colors[1], c.colors[0], k), B);
        });
        break;
      }

      case 'sparkle': {
        var cols = 32, rows = 20;
        var cw = w / cols, ch = h / rows;
        state.sparks = state.sparks || [];
        state.lastT = state.lastT === undefined ? tMs : state.lastT;
        var dt = Math.max(0, Math.min(250, tMs - state.lastT));
        state.lastT = tMs;
        // density 1 -> ~5 new sparks/s, 100 -> ~200/s.
        state.carry = (state.carry || 0) + dt / 1000 * (5 + 195 * c.density);
        while (state.carry >= 1) {
          state.carry -= 1;
          var pick = c.colors.length > 1 ? 1 + Math.floor(Math.random() * (c.colors.length - 1)) : 0;
          state.sparks.push({ x: Math.floor(Math.random() * cols), y: Math.floor(Math.random() * rows), born: tMs, color: pick });
        }
        ctx.fillStyle = css(c.colors[0], c.floor * B);
        ctx.fillRect(0, 0, w, h);
        var alive = [];
        for (var k = 0; k < state.sparks.length; k++) {
          var sp = state.sparks[k];
          var age = (tMs - sp.born) / c.speedMs;
          if (age >= 1) continue;
          alive.push(sp);
          var a = Math.sin(age * Math.PI);
          var base = c.floor;
          ctx.fillStyle = css(lerp(c.colors[0], c.colors[sp.color], a), (base + (1 - base) * a) * B);
          ctx.fillRect(Math.floor(sp.x * cw), Math.floor(sp.y * ch), Math.ceil(cw), Math.ceil(ch));
        }
        state.sparks = alive.length > 2000 ? alive.slice(-2000) : alive;
        break;
      }

      case 'gauge':
      case 'gaugeBlink':
      case 'gaugeFade':
      case 'gaugeColor': {
        var target = typeof state.level === 'number' ? Math.min(1, Math.max(0, state.level))
          : Math.sin(tMs / 1600) * 0.5 + 0.5;
        var gdt = state.gaugeT === undefined ? 1000 : Math.max(0, tMs - state.gaugeT);
        state.gaugeT = tMs;
        // Ease toward the target (~120ms time constant) so 10 Hz updates look smooth.
        state.shown = state.shown === undefined ? target : state.shown + (target - state.shown) * Math.min(1, gdt / 120);
        var lvl = state.shown;
        if (c.pattern === 'gaugeFade') {
          ctx.fillStyle = css(lerp(c.colors[1], c.colors[0], lvl), B);
          ctx.fillRect(0, 0, w, h);
          break;
        }
        if (c.pattern === 'gaugeColor') {
          var col = lvl >= 0.5 ? lerp(c.colors[1], c.colors[0], (lvl - 0.5) * 2) : lerp(c.colors[2], c.colors[1], lvl * 2);
          ctx.fillStyle = css(col, B);
          ctx.fillRect(0, 0, w, h);
          break;
        }
        // Calibration (per zone, set by the compositor): the visible LEDs only cover
        // state.range[0]..state.range[1] of the canvas width; state.reverse anchors the bar
        // at the range's right end so it empties toward it. Lit interval: [lo, hi].
        var r0 = state.range ? state.range[0] : 0, r1 = state.range ? state.range[1] : 1;
        var full = lvl >= 0.999, lo, hi;
        if (state.reverse) { lo = full ? 0 : r1 - lvl * (r1 - r0); hi = 1; }
        else { lo = 0; hi = full ? 1 : r0 + lvl * (r1 - r0); }
        if (c.pattern === 'gaugeBlink') B *= c.floor + (1 - c.floor) * Math.pow(Math.sin(phase * Math.PI), 2);
        stripes(ctx, w, h, function (x) {
          var from = x, to = x + 1 / STRIPES;
          var cover = Math.max(0, Math.min(to, hi) - Math.max(from, lo)) * STRIPES;
          return css(lerp(c.colors[1], c.colors[0], Math.min(1, cover)), B);
        });
        break;
      }

      default:
        ctx.fillStyle = css(c.colors[0], B);
        ctx.fillRect(0, 0, w, h);
    }
  }

  var api = { PATTERNS: PATTERNS, PARAMS: PARAMS, render: render, resolve: resolve, hexToRgb: hexToRgb };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WowPatterns = api;
})(this);
