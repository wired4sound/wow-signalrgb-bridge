'use strict';
// Zones: parts of the SignalRGB layout canvas (320x200) that show different things at once.
// The compositor effect ("WoW Bridge") draws each zone with its own winning rule; a zone
// with no rule shows the game's ambience (the colors of the WoW world, sampled by the
// beacon reader).
//
// Default rectangles match the author's SignalRGB layout (read with src/srgb-layout.js;
// `node tools/layout.js` prints yours and checks every device lands in a zone):
//   Hue ceiling lights y 10-17 | radiator fans bar y 31-41 | single fan on the left x 0-47, y 58-91 |
//   fans on the right x 249-300, y 48-125 | floor fans x 212-302, y 137-177 | strip y 188-197.
// Override with zones.rects in config.json. Zone keys are stable (rules.json uses them);
// labels are display names.

const ZONE_NAMES = ['ceiling', 'radiator', 'rear', 'back', 'bottom', 'strip'];
const ZONE_LABELS = {
  ceiling: 'Ceiling (Hue cans)', radiator: 'Liquid cooling fans', rear: 'Back fan (left)',
  back: 'Right fans', bottom: 'Bottom fans', strip: 'Side strip',
};
const GROUPS = {
  all: ZONE_NAMES,
  pc: ZONE_NAMES.filter((z) => z !== 'ceiling'),
};
// [x, y, w, h] in canvas units. Generous, non-overlapping, and covering each device.
const DEFAULT_RECTS = {
  ceiling: [0, 0, 320, 28],
  radiator: [0, 28, 320, 18],
  rear: [0, 46, 130, 139],
  back: [240, 46, 80, 79],
  bottom: [130, 125, 190, 60],
  strip: [0, 185, 320, 15],
};

function inRect([x, y, w, h], px, py) {
  return px >= x && px < x + w && py >= y && py < y + h;
}

// Which zone each SignalRGB device's center falls in (rotation-aware for 90/270).
// Hue lights must land in the ceiling; others anywhere but the ceiling.
function checkLayout(devices, rects = DEFAULT_RECTS) {
  return devices.map((d) => {
    const quarter = Math.abs(d.rotation % 180) === 90;
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    const w = quarter ? d.h : d.w;
    const h = quarter ? d.w : d.h;
    const zone = ZONE_NAMES.find((z) => inRect(rects[z], cx, cy)) || null;
    let problem = null;
    if (!zone) problem = 'outside every zone';
    else if (d.hue && zone !== 'ceiling') problem = 'Hue light outside the ceiling band';
    else if (!d.hue && zone === 'ceiling') problem = 'PC device inside the ceiling band';
    return { name: d.name, channel: d.channel, zone, box: [d.x + d.w / 2 - w / 2, d.y + d.h / 2 - h / 2, w, h], problem };
  });
}
const BITS = 4; // design index bits per zone (0 = ambience, 1..14 = designs, 15 = room light)
const ROOM_LIGHT = 15;

function expandZones(list) {
  const out = new Set();
  for (const z of list || ['all']) {
    if (GROUPS[z]) GROUPS[z].forEach((n) => out.add(n));
    else if (ZONE_NAMES.includes(z)) out.add(z);
    else throw new Error(`unknown zone "${z}" (use ${[...Object.keys(GROUPS), ...ZONE_NAMES].join(', ')})`);
  }
  return [...out];
}

// entries: controller entries (highest priority first is not assumed). ruleZones: rule name
// -> expanded zone list. designIndex: effect name -> index (1-based) or undefined.
// Returns per-zone { index, key } in ZONE_NAMES order.
// excluded: zones the bridge leaves out; they show the fixed room light instead.
function resolveZones(entries, ruleZones, designIndex, excluded = []) {
  const sorted = [...entries].sort((a, b) => b.priority - a.priority || b.seq - a.seq);
  return ZONE_NAMES.map((zone) => {
    if (excluded.includes(zone)) return { index: ROOM_LIGHT, key: null, effect: null, room: true };
    const e = sorted.find((x) => (ruleZones[x.key] || ZONE_NAMES).includes(zone) && designIndex[x.effect]);
    return e ? { index: designIndex[e.effect], key: e.key, effect: e.effect } : { index: 0, key: null, effect: null };
  });
}

// Packs zone indices into 12-bit words (3 zones each) for the image-size channel.
function packZones(indices) {
  const words = [];
  for (let i = 0; i < indices.length; i += 3) {
    let v = 0;
    for (let j = 0; j < 3; j++) v |= ((indices[i + j] || 0) & 15) << (BITS * j);
    words.push(v);
  }
  return words;
}

// ---- ambience ----

function hexToRgb(h) {
  const n = parseInt(String(h).replace('#', ''), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [0, 0, 0];
}

// Makes dim game colors usable as room light: gain, saturation, floor.
function grade([r, g, b], { gain = 2.5, saturation = 1.4, floor = 0.06 } = {}) {
  let c = [r * gain, g * gain, b * gain];
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  c = c.map((v) => lum + (v - lum) * saturation);
  const max = Math.max(...c);
  if (max > 255) c = c.map((v) => (v * 255) / max); // keep the hue when clipping
  const m2 = Math.max(...c);
  const min = floor * 255;
  if (m2 > 0 && m2 < min) c = c.map((v) => (v * min) / m2);
  return c.map((v) => Math.max(0, Math.min(255, Math.round(v))));
}

class Ambience {
  constructor(opts = {}) {
    this.opts = { gain: 2.5, saturation: 1.4, floor: 0.06, smoothMs: 600, ...opts };
    this.colors = null; // eased, graded [[r,g,b] x4]
    this.at = 0;
  }

  update(rawHex, now = Date.now()) {
    if (!Array.isArray(rawHex) || !rawHex.length) return;
    const target = rawHex.map((h) => grade(hexToRgb(h), this.opts));
    if (!this.colors || this.colors.length !== target.length) {
      this.colors = target;
    } else {
      const dt = Math.max(0, now - this.at);
      const k = this.opts.smoothMs > 0 ? 1 - Math.exp(-dt / this.opts.smoothMs) : 1;
      this.colors = this.colors.map((c, i) => c.map((v, j) => v + (target[i][j] - v) * k));
    }
    this.at = now;
  }

  hex() {
    return (this.colors || []).map((c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`);
  }

  // Two 12-bit words per color: (R<<4 | G>>4), ((G&15)<<8 | B).
  words() {
    const out = [];
    for (const c of this.colors || []) {
      const [r, g, b] = c.map((v) => Math.max(0, Math.min(255, Math.round(v))));
      out.push((r << 4) | (g >> 4), ((g & 15) << 8) | b);
    }
    return out;
  }
}

module.exports = {
  ZONE_NAMES, ZONE_LABELS, GROUPS, DEFAULT_RECTS, ROOM_LIGHT, expandZones, resolveZones, packZones, grade, Ambience, checkLayout,
};
