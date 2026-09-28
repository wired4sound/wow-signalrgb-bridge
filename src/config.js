'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  logsDir: '',
  playerName: '',
  lowHealthThreshold: 0.3,
  lowManaThreshold: 0.2,
  pollMs: 100,
  minApplyIntervalMs: 150,
  logLevel: 'info',
  signalrgb: { host: '127.0.0.1', port: 16038, timeoutMs: 2000, effectsDir: '' },
  baseline: null,
  // Screen beacon (SignalBeacon addon + tools/beacon-reader.ps1).
  beacon: { enabled: true, processName: 'WowB', intervalMs: 100, graceMs: 10000 },
  ui: { port: 17700 },
  // Zone compositor (src/zones.js): while in game, one effect draws every zone; zones
  // without a rule show the game's ambience. rects: { zone: [x, y, w, h] } on 320x200.
  // ceiling.enabled false: the Hue cans ignore rules and the game world and show ceiling.color.
  zones: {
    enabled: true, rects: null,
    ambience: { gain: 2.5, saturation: 1.4, floor: 0.06, smoothMs: 600 },
    ceiling: { enabled: true, color: '#ffffff' }, // #ffffff: daylight white at 100%
    normalColor: null, // PC color while not playing with the ceiling left out; null = SignalRGB's Solid Color
  },
};

// Re-apply a bridge effect that stopped reporting from SignalRGB, then restart SignalRGB.
DEFAULTS.watchdog = { enabled: true, staleMs: 15000 };

const NESTED = ['signalrgb', 'beacon', 'ui', 'zones', 'watchdog'];

const WOW_ROOTS = [
  'C:\\Program Files (x86)\\World of Warcraft',
  'C:\\Program Files\\World of Warcraft',
  'D:\\World of Warcraft',
  'D:\\Games\\World of Warcraft',
  'E:\\World of Warcraft',
  'E:\\Games\\World of Warcraft',
];

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${err.message}`);
  }
}

function loadConfig(file) {
  const user = fs.existsSync(file) ? readJson(file) : {};
  const cfg = { ...DEFAULTS, ...user };
  for (const k of NESTED) cfg[k] = { ...DEFAULTS[k], ...(user[k] || {}) };
  cfg.zones.ambience = { ...DEFAULTS.zones.ambience, ...(user.zones?.ambience || {}) };
  cfg.zones.ceiling = { ...DEFAULTS.zones.ceiling, ...(user.zones?.ceiling || {}) };
  return cfg;
}

// Finds <WoW root>/<flavor>/Logs folders. Prefers "forever" flavors, then the
// folder with the most recent combat log.
function findLogsDirs() {
  const found = [];
  for (const root of WOW_ROOTS) {
    let flavors;
    try { flavors = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of flavors) {
      if (!d.isDirectory()) continue;
      const logs = path.join(root, d.name, 'Logs');
      if (!fs.existsSync(logs)) continue;
      let newest = 0;
      try {
        for (const f of fs.readdirSync(logs)) {
          if (/^WoWCombatLog.*\.txt$/i.test(f)) newest = Math.max(newest, fs.statSync(path.join(logs, f)).mtimeMs);
        }
      } catch { /* ignore */ }
      found.push({ dir: logs, flavor: d.name, newest, forever: /forever/i.test(d.name) });
    }
  }
  return found.sort((a, b) => (b.forever - a.forever) || (b.newest - a.newest));
}

module.exports = { loadConfig, readJson, findLogsDirs };
