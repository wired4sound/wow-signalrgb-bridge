'use strict';
// Zones: parts of the SignalRGB layout canvas (320x200) that show different things at once.
// The compositor effect ("WoW Bridge") draws each zone with its own winning rule; a zone
// with no rule shows the game's ambience (the colors of the WoW world, sampled by the
// beacon reader).
//
// Default rectangles match the author's SignalRGB layout "Main" (read with src/srgb-layout.js;
// `node tools/layout.js` prints yours and checks every device lands in a zone). The ceiling
// lights sit in a top band; below it the case is drawn in proportion as seen through its
// glass (x 88-232, y 32-198): 3 top exhaust fans, the AIO's radiator fans (one set, wired
// in parallel by the AIO), a rear fan on the left, 2 fans stacked on the right, 2 floor
// fans, and the strip along the bottom edge (its hidden front part runs up the right edge).
// Override with zones.rects in config.json. Zone keys are stable (rules.json uses them);
// labels are display names.

const ZONE_NAMES = [
  'ceiling', 'topLeft', 'topMiddle', 'topRight', 'radiator', 'rear',
  'rightTop', 'rightBottom', 'floorLeft', 'floorRight', 'strip',
];
const ZONE_LABELS = {
  ceiling: 'Ceiling (Hue cans)', topLeft: 'Top left fan', topMiddle: 'Top middle fan', topRight: 'Top right fan',
  radiator: 'Liquid cooling fans', rear: 'Back fan', rightTop: 'Right top fan', rightBottom: 'Right bottom fan',
  floorLeft: 'Floor left fan', floorRight: 'Floor right fan', strip: 'Side strip',
};
const GROUPS = {
  all: ZONE_NAMES,
  pc: ZONE_NAMES.filter((z) => z !== 'ceiling'),
};
// Zones from before the fans were split up (kept so old rules still load).
const LEGACY = { back: ['rightTop', 'rightBottom'], bottom: ['floorLeft', 'floorRight'] };
// [x, y, w, h] in canvas units. Generous, non-overlapping, and covering each device.
const DEFAULT_RECTS = {
  ceiling: [0, 0, 320, 30],
  topLeft: [96, 30, 41, 15],
  topMiddle: [137, 30, 41, 15],
  topRight: [178, 30, 54, 15],
  radiator: [104, 45, 128, 20],
  rear: [80, 45, 24, 60],
  rightTop: [180, 66, 52, 38],
  rightBottom: [180, 104, 52, 36],
  floorLeft: [140, 145, 42, 35],
  floorRight: [182, 145, 50, 35],
  strip: [80, 182, 160, 18],
};

// Extra, possibly rotated, areas that belong to a zone (zones.parts in config.json):
//   { "strip": [{ "rect": [x, y, w, h], "axis": "y", "reverse": true }] }
// A part with axis 'y' is drawn rotated: the pattern's left-to-right runs along the part's
// height (reverse: from the bottom up). Useful when a device sits vertically in the layout
// but is a horizontal bar in real life and you'd rather not move it in SignalRGB.
// The strip's hidden front part stands vertically at the case's right edge.
const DEFAULT_PARTS = { strip: [{ rect: [232, 55, 10, 135] }] };

function inRect([x, y, w, h], px, py) {
  return px >= x && px < x + w && py >= y && py < y + h;
}

// Which zone each SignalRGB device's center falls in (rotation-aware for 90/270).
// Hue lights must land in the ceiling; others anywhere but the ceiling.
function checkLayout(devices, rects = DEFAULT_RECTS, parts = DEFAULT_PARTS) {
  return devices.map((d) => {
    const quarter = Math.abs(d.rotation % 180) === 90;
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    const w = quarter ? d.h : d.w;
    const h = quarter ? d.w : d.h;
    // Parts are drawn on top of the plain rects, so they win.
    const zone = ZONE_NAMES.find((z) => (parts[z] || []).some((p) => inRect(p.rect, cx, cy)))
      || ZONE_NAMES.find((z) => rects[z] && inRect(rects[z], cx, cy)) || null;
    let problem = null;
    // Unnamed "Default Strip - N" placeholders on empty motherboard headers light nothing.
    const placeholder = /^Default Strip - \d+$/.test(d.name || '');
    if (!zone && placeholder) problem = null;
    else if (!zone) problem = 'outside every zone';
    else if (d.hue && zone !== 'ceiling') problem = 'Hue light outside the ceiling band';
    else if (!d.hue && zone === 'ceiling') problem = 'PC device inside the ceiling band';
    return { name: d.name, channel: d.channel, zone, box: [d.x + d.w / 2 - w / 2, d.y + d.h / 2 - h / 2, w, h], problem };
  });
}
// SignalRGB device names (as set in its layout, case and spaces ignored) -> zone. A device
// marked part adds an extra area to its zone instead of setting the zone's main rect.
const DEVICE_ZONES = {
  topleft: 'topLeft', topmiddle: 'topMiddle', topright: 'topRight',
  coolingfans: 'radiator', liquidcoolingfans: 'radiator', radiator: 'radiator', aio: 'radiator',
  rearfan: 'rear', backfan: 'rear',
  righttop: 'rightTop', rightbottom: 'rightBottom',
  floorleft: 'floorLeft', floorright: 'floorRight',
  sidestrip: 'strip', strip: 'strip', frontstrip: ['strip', 'part'],
};

// Zone rects and parts from where the devices actually sit in the SignalRGB layout, so the
// zones follow the layout when it's edited there. Boxes are rotation-aware and clipped to
// the canvas. The ceiling is a full-width band down to the Hue lights (never over the PC).
// Zones with no matching device get an empty rect. Returns null when nothing matched.
function zonesFromLayout(devices) {
  const rects = {};
  const parts = {};
  const clip = ([x, y, w, h]) => {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(320, Math.ceil(x + w)), y1 = Math.min(200, Math.ceil(y + h));
    return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
  };
  let hueBottom = 0;
  let pcTop = 200;
  for (const c of checkLayout(devices, {}, {})) {
    const d = devices.find((x) => x.name === c.name && x.channel === c.channel) || {};
    if (d.hue) { hueBottom = Math.max(hueBottom, c.box[1] + c.box[3]); continue; }
    const m = DEVICE_ZONES[String(c.name || '').toLowerCase().replace(/[^a-z]/g, '')];
    if (!m) continue;
    const [zone, part] = Array.isArray(m) ? m : [m];
    const box = clip(c.box);
    if (!box) continue;
    pcTop = Math.min(pcTop, box[1]);
    if (part || rects[zone]) {
      // A vertical part runs a bar (gauge) along its length.
      (parts[zone] = parts[zone] || []).push(box[3] > box[2] ? { rect: box, axis: 'y' } : { rect: box });
    } else {
      rects[zone] = box;
    }
  }
  if (!Object.keys(rects).length && !Object.keys(parts).length) return null;
  if (hueBottom) rects.ceiling = [0, 0, 320, Math.max(1, Math.min(Math.ceil(hueBottom) + 2, pcTop))];
  for (const z of ZONE_NAMES) if (!rects[z]) rects[z] = [0, 0, 0, 0];
  return { rects, parts };
}

// Design index per zone, 5 bits: 0 = ambience (game world), 1..29 = designs,
// 30 = normal color (PC while not playing), 31 = room light (ceiling left out).
const BITS = 5;
const PER_WORD = 2; // zones per 12-bit channel word
const NORMAL = 30;
const ROOM_LIGHT = 31;
const MAX_DESIGNS = 29;

function expandZones(list) {
  const out = new Set();
  for (const z of list || ['all']) {
    if (GROUPS[z]) GROUPS[z].forEach((n) => out.add(n));
    else if (LEGACY[z]) LEGACY[z].forEach((n) => out.add(n));
    else if (ZONE_NAMES.includes(z)) out.add(z);
    else throw new Error(`unknown zone "${z}" (use ${[...Object.keys(GROUPS), ...ZONE_NAMES].join(', ')})`);
  }
  return [...out];
}

// entries: controller entries (highest priority first is not assumed). ruleZones: rule name
// -> expanded zone list. designIndex: effect name -> index (1-based) or undefined.
// Returns per-zone { index, key } in ZONE_NAMES order.
// excluded: zones the bridge leaves out; they show the fixed room light instead, except
// while a rule that names the zone directly (namedZones: rule name -> zones) is active.
// idleIndex: what a zone with no rule shows (0 = game world ambience, NORMAL = normal color).
function resolveZones(entries, ruleZones, designIndex, excluded = [], idleIndex = 0, namedZones = {}) {
  const sorted = [...entries].sort((a, b) => b.priority - a.priority || b.seq - a.seq);
  return ZONE_NAMES.map((zone) => {
    if (excluded.includes(zone)) {
      const n = sorted.find((x) => (namedZones[x.key] || []).includes(zone) && designIndex[x.effect]);
      if (n) return { index: designIndex[n.effect], key: n.key, effect: n.effect };
      return { index: ROOM_LIGHT, key: null, effect: null, room: true };
    }
    const e = sorted.find((x) => (ruleZones[x.key] || ZONE_NAMES).includes(zone) && designIndex[x.effect]);
    if (e) return { index: designIndex[e.effect], key: e.key, effect: e.effect };
    return { index: idleIndex, key: null, effect: null, normal: idleIndex === NORMAL };
  });
}

// Packs zone indices into 12-bit words (2 zones x 5 bits each) for the image-size channel.
function packZones(indices) {
  const words = [];
  for (let i = 0; i < indices.length; i += PER_WORD) {
    let v = 0;
    for (let j = 0; j < PER_WORD; j++) v |= ((indices[i + j] || 0) & 31) << (BITS * j);
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
  ZONE_NAMES, ZONE_LABELS, GROUPS, LEGACY, DEFAULT_RECTS, DEFAULT_PARTS, ROOM_LIGHT, NORMAL, MAX_DESIGNS, BITS, PER_WORD, DEVICE_ZONES, zonesFromLayout, expandZones, resolveZones, packZones, grade, Ambience, checkLayout,
};
