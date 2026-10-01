#!/usr/bin/env node
'use strict';
// Hue events: listens to the Hue Bridge's live event stream (API v2) with the key SignalRGB
// saved (never printed) and logs every change the bridge reports, as it happens: light
// on/off, brightness, color, scenes, automations (behavior instances), sensors, the
// Entertainment area. SignalRGB's own stream frames are not reported; anything that is
// logged here while SignalRGB streams came from somewhere else.
//   node tools/hue-events.js [minutes=120]

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

function bridge() {
  const [id, info] = JSON.parse(regValues(`${SVC}\\ipCache`).cache || '[]')[0] || [];
  if (!id) throw new Error('No Hue Bridge in SignalRGB settings');
  const key = regValues(`${SVC}\\${id}`).username;
  if (!key) throw new Error('SignalRGB has no Hue key saved');
  return { ip: info.ip, key };
}

function get(b, path) {
  return new Promise((resolve, reject) => {
    https.get({ host: b.ip, path, rejectUnauthorized: false, headers: { 'hue-application-key': b.key } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const stamp = () => new Date().toLocaleTimeString('en-US', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');

async function main() {
  const minutes = Number(process.argv[2]) || 120;
  const b = bridge();
  // Names for ids, so the log is readable.
  const names = {};
  for (const type of ['light', 'room', 'zone', 'grouped_light', 'scene', 'behavior_instance', 'entertainment_configuration', 'device', 'motion', 'button']) {
    try {
      const r = await get(b, `/clip/v2/resource/${type}`);
      for (const x of r.data || []) names[x.id] = `${type}:${x.metadata?.name || x.id.slice(0, 8)}`;
    } catch { /* optional */ }
  }
  for (const x of Object.values(names)) if (x.startsWith('behavior_instance:')) console.log(`automation on the bridge: ${x.slice(18)}`);
  console.log(`${stamp()} listening to ${b.ip} for ${minutes} min`);

  const start = () => {
    const req = https.get({ host: b.ip, path: '/eventstream/clip/v2', rejectUnauthorized: false, headers: { 'hue-application-key': b.key, Accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
          if (!data) continue;
          let events;
          try { events = JSON.parse(data); } catch { continue; }
          for (const ev of events) {
            for (const d of ev.data || []) {
              const who = names[d.id] || `${d.type}:${d.id.slice(0, 8)}`;
              const owner = d.owner ? ` (${names[d.owner.rid] || d.owner.rtype})` : '';
              const { id, id_v1, owner: _o, type, ...rest } = d;
              console.log(`${stamp()} ${ev.type} ${who}${owner} ${JSON.stringify(rest)}`);
            }
          }
        }
      });
      res.on('end', () => { console.log(`${stamp()} stream ended, reconnecting`); setTimeout(start, 2000); });
    });
    req.on('error', (e) => { console.log(`${stamp()} error ${e.message}, reconnecting`); setTimeout(start, 5000); });
  };
  start();
  setTimeout(() => { console.log(`${stamp()} done`); process.exit(0); }, minutes * 60000);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
