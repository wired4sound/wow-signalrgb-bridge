'use strict';
// Reads SignalRGB's device layout from its Qt settings in the registry (Windows only):
//   HKCU\Software\WhirlwindFX\SignalRgb\lighting\endpoint\<id>          alias, scale {x,y}, rotation
//   HKCU\Software\WhirlwindFX\SignalRgb\lighting\endpoint\<id>\position x, y (canvas units, top-left of the LED grid)
//   HKCU\Software\WhirlwindFX\SignalRgb\devices\<device>                 "Channel N" = JSON list of components
// Canvas is 320x200. A component's size on the canvas is Width*scale.x by Height*scale.y.

const { execFileSync } = require('child_process');

const REG = 'HKCU\\Software\\WhirlwindFX\\SignalRgb';

// Parses `reg query /s` output into { keyPath: { name: value } }.
function regTree(key) {
  const out = {};
  let cur = null;
  let text;
  try { text = execFileSync('reg', ['query', key, '/s'], { encoding: 'utf8', windowsHide: true }); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) { cur = line.trim(); out[cur] = {}; continue; }
    const m = /^\s+(.+?)\s{4}REG_\w+\s{4}(.*)$/.exec(line);
    if (m && cur) out[cur][m[1]] = m[2];
  }
  return out;
}

function parseJson(v, fallback) {
  try { return JSON.parse(v); } catch { return fallback; }
}

// Returns [{ id, name, channel, leds, grid: [w, h], x, y, w, h, rotation, hue }]; hue devices
// (Philips Hue lights) have no component and a fixed small box.
function readLayout() {
  const endpoints = regTree(`${REG}\\lighting\\endpoint`);
  const devices = regTree(`${REG}\\devices`);
  const comps = {};
  for (const vals of Object.values(devices)) {
    for (const [chan, v] of Object.entries(vals)) {
      if (!v.startsWith('[')) continue;
      for (const c of parseJson(v, [])) comps[c.ComponentId] = { ...c, channel: chan };
    }
  }
  const out = [];
  for (const [k, vals] of Object.entries(endpoints)) {
    if (k.endsWith('\\position')) continue;
    const id = k.split('\\').pop();
    const pos = endpoints[`${k}\\position`];
    if (!pos) continue;
    const scale = parseJson(vals.scale || '', { x: 1, y: 1 });
    const comp = comps[id];
    const hue = /Philips Hue Light/i.test(id);
    if (!comp && !hue) continue; // parent devices and unplaced headers
    const grid = comp ? [comp.Width, comp.Height] : [1, 1];
    out.push({
      id,
      name: vals.alias || (comp ? comp.DisplayName : id.split(':').pop().trim()),
      channel: comp ? comp.channel : null,
      component: comp ? comp.DisplayName : 'Hue light',
      leds: comp ? comp.LedCount : 1,
      grid,
      x: Number(pos.x),
      y: Number(pos.y),
      w: grid[0] * scale.x,
      h: grid[1] * scale.y,
      rotation: Number(vals.rotation || 0),
      hue,
    });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

// Decodes a QSettings "@Variant(" QColor blob (REG_BINARY shown by `reg query` as hex).
// Layout after "@Variant(": 4-byte type (0x43 = QColor), int8 spec, uint16 alpha,
// uint16 c1, c2, c3, pad. Spec 1 = RGB, 2 = HSV, 4 = HSL; hue is in 1/100 degree.
function decodeQColor(hexString) {
  const bytes = Buffer.from(String(hexString).replace(/[^0-9a-f]/gi, ''), 'hex');
  const chars = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) chars.push(bytes[i] | (bytes[i + 1] << 8));
  const start = chars.findIndex((c, i) => i >= 9 && c === 0x43 && chars[i - 1] === 0 && chars[i - 2] === 0 && chars[i - 3] === 0);
  if (start < 0) return null;
  const d = chars.slice(start + 1);
  const u16 = (i) => (d[i] << 8) | d[i + 1];
  const spec = d[0];
  const c1 = u16(3), c2 = u16(5), c3 = u16(7);
  let rgb;
  if (spec === 1) rgb = [c1, c2, c3].map((v) => v / 65535);
  else if (spec === 2 || spec === 4) {
    const h = c1 === 0xffff ? 0 : c1 / 100 / 360;
    const s = c2 / 65535;
    const l = c3 / 65535;
    const f = (n) => {
      const k = (n + h * 12) % 12;
      if (spec === 4) {
        const a = s * Math.min(l, 1 - l);
        return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      }
      const k6 = (n + h * 6) % 6; // HSV
      return l - l * s * Math.max(0, Math.min(k6, 4 - k6, 1));
    };
    rgb = spec === 4 ? [f(0), f(8), f(4)] : [f(5), f(3), f(1)];
  } else return null;
  return rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
}

const toHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// The color SignalRGB's built-in "Solid Color" effect shows, as the eye sees it: with
// Breathing on at speed 0 the effect holds the color at a steady 50% brightness.
function readSolidColor() {
  const tree = regTree(`${REG}\\effects\\Solid Color.html`);
  const vals = Object.values(tree)[0];
  if (!vals || !vals.color) return null;
  const rgb = decodeQColor(vals.color);
  if (!rgb) return null;
  const breathe = String(vals.breathe).toLowerCase() === 'true';
  const speed = Number(vals.speed || 0);
  const shown = breathe && speed === 0 ? rgb.map((v) => Math.round(v * 0.5)) : rgb;
  return { color: toHex(rgb), shown: toHex(shown), breathe, speed };
}

module.exports = { readLayout, regTree, decodeQColor, readSolidColor };
