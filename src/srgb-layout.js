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

module.exports = { readLayout, regTree };
