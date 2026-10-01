#!/usr/bin/env node
'use strict';
// Hue watch: polls the Hue Bridge SignalRGB streams to (with the key SignalRGB saved in
// the registry, never printed) and logs every change of the Entertainment area's stream
// (active, and whether SignalRGB or another app owns it) and of each light's state
// (on, brightness, color mode, reachable). Use it to find out why the ceiling cans change.
// Note: while streaming, the bridge doesn't report streamed colors in the light state, so
// a light's bri/ct only moves when something else (an automation, the Hue app) sets it.
//   node tools/hue-watch.js [minutes=120] [intervalMs=1000]

const https = require('https');
const { execFileSync } = require('child_process');

const SVC = 'HKCU\\Software\\WhirlwindFX\\SignalRgb\\services\\Philips Hue';

function regValues(key) {
  const out = {};
  const text = execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{4}REG_\w+\s{4}(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function bridgeInfo() {
  const cache = JSON.parse(regValues(`${SVC}\\ipCache`).cache || '[]');
  if (!cache.length) throw new Error('No Hue Bridge in SignalRGB settings');
  const [id, info] = cache[0];
  const cfg = regValues(`${SVC}\\${id}`);
  if (!cfg.username) throw new Error('SignalRGB has no Hue key saved');
  return { ip: info.ip, username: cfg.username, area: cfg.selectedArea || null, areaName: cfg.selectedAreaName || '' };
}

function get(ip, path) {
  return new Promise((resolve, reject) => {
    // The bridge uses a self-signed certificate.
    const req = https.get({ host: ip, path, rejectUnauthorized: false, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const stamp = () => new Date().toLocaleTimeString('en-US', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');

async function main() {
  const minutes = Number(process.argv[2]) || 120;
  const interval = Number(process.argv[3]) || 1000;
  const b = bridgeInfo();
  const base = `/api/${b.username}`;
  const groups = await get(b.ip, `${base}/groups`);
  if (Array.isArray(groups) && groups[0]?.error) throw new Error(`Hue Bridge: ${groups[0].error.description}`);
  const areaId = b.area && groups[b.area] ? b.area
    : Object.keys(groups).find((k) => groups[k].type === 'Entertainment' && groups[k].name === b.areaName);
  if (!areaId) throw new Error('Entertainment area not found');
  const lightIds = groups[areaId].lights;
  const allLights = await get(b.ip, `${base}/lights`);
  const names = Object.fromEntries(lightIds.map((id) => [id, allLights[id]?.name || id]));
  console.log(`${stamp()} watching "${groups[areaId].name}" (area ${areaId}) on ${b.ip}: ${lightIds.map((id) => `${id}=${names[id]}`).join(', ')}`);

  const last = {};
  let lastError = '';
  const end = Date.now() + minutes * 60000;
  const tick = async () => {
    try {
      const [g, lights] = await Promise.all([get(b.ip, `${base}/groups/${areaId}`), get(b.ip, `${base}/lights`)]);
      if (lastError) { console.log(`${stamp()} bridge reachable again`); lastError = ''; }
      const s = g.stream || {};
      const owner = !s.owner ? 'none' : s.owner === b.username ? 'SignalRGB' : 'ANOTHER APP';
      const streamLine = `stream active=${!!s.active} owner=${owner}`;
      if (last.stream !== streamLine) { console.log(`${stamp()} ${streamLine}`); last.stream = streamLine; }
      for (const id of lightIds) {
        const st = lights[id]?.state || {};
        // xy rounded to 0.02 so tiny drift doesn't flood the log; white is around (0.31, 0.33).
        const xy = Array.isArray(st.xy) ? ` xy=${st.xy.map((v) => (Math.round(v * 50) / 50).toFixed(2)).join(',')}` : '';
        const line = `on=${st.on} bri=${st.bri} mode=${st.colormode}${xy}${st.colormode === 'ct' ? ` ct=${st.ct}` : ''} reachable=${st.reachable}`;
        if (last[id] !== line) { console.log(`${stamp()} ${names[id]}: ${line}`); last[id] = line; }
      }
    } catch (e) {
      if (lastError !== e.message) { console.log(`${stamp()} bridge error: ${e.message}`); lastError = e.message; }
    }
    if (Date.now() < end) setTimeout(tick, interval);
    else console.log(`${stamp()} done`);
  };
  tick();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
