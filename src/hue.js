'use strict';
// Ceiling alerts straight through the Hue Bridge's local API (v1 REST), for when the Hue
// lights are left out of SignalRGB: the cans stay on whatever the Hue app set, and an
// alert flashes them, then puts every light back exactly as it was (on, brightness,
// color or color temperature). Plain commands, no Entertainment stream, so nothing drops.
//
// The key comes from pairing (`node tools/hue-pair.js`, press the bridge's button) and
// lives in hue.local.json (git-ignored): { "ip": "192.168.1.20", "key": "..." }.
// Hue asks for at most ~10 light commands per second; a double flash on 4 lights is 16
// commands over 1.5 s, sent a few ms apart.

const fs = require('fs');
const https = require('https');
const path = require('path');

const LOCAL_FILE = path.resolve(__dirname, '..', 'hue.local.json');

function readLocal(file = LOCAL_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeLocal(data, file = LOCAL_FILE) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function request(ip, method, urlPath, body, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    // The bridge uses a self-signed certificate.
    const req = https.request({
      host: ip, path: urlPath, method, rejectUnauthorized: false, timeout: timeoutMs,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// sRGB hex -> Hue xy (wide gamut formula from Hue's docs).
function hexToXy(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const lin = (v) => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const s = X + Y + Z;
  return s ? [Number((X / s).toFixed(4)), Number((Y / s).toFixed(4))] : [0.3127, 0.329];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HueAlerts {
  // lights: Hue light ids, or names (matched case-insensitively) resolved on first use.
  constructor({ ip, key, lights = [], log, requestFn = request } = {}) {
    this.ip = ip;
    this.key = key;
    this.wanted = lights;
    this.ids = null;
    this.log = log;
    this.request = requestFn;
    this.busy = false;
    this.last = null; // { at, ok, error } for the UI
  }

  api(method, p, body) { return this.request(this.ip, method, `/api/${this.key}${p}`, body); }

  async lightIds() {
    if (this.ids) return this.ids;
    const all = await this.api('GET', '/lights');
    if (Array.isArray(all) && all[0]?.error) throw new Error(`Hue: ${all[0].error.description}`);
    const byName = Object.fromEntries(Object.entries(all).map(([id, l]) => [String(l.name).toLowerCase(), id]));
    const ids = this.wanted.map((w) => (all[w] ? String(w) : byName[String(w).toLowerCase()])).filter(Boolean);
    if (!ids.length) throw new Error(`Hue: none of the lights ${JSON.stringify(this.wanted)} found`);
    this.ids = ids;
    return ids;
  }

  // Sends one command to every light, a few ms apart (Hue's rate guidance).
  async all(ids, stateFor) {
    for (const id of ids) {
      const body = stateFor(id);
      if (body) this.api('PUT', `/lights/${id}/state`, body).catch((e) => this.log?.warn(`Hue light ${id}: ${e.message}`));
      await sleep(25);
    }
  }

  // color: #rrggbb; times: flashes; onMs: how long each flash lasts; gapMs: back to the
  // saved look in between. Ignored while another alert runs (e.g. the same boss kill from
  // the beacon and from the combat log).
  async flash({ color = '#ffffff', times = 2, onMs = 450, gapMs = 350 } = {}) {
    if (this.busy) return false;
    this.busy = true;
    try {
      const ids = await this.lightIds();
      const lights = await this.api('GET', '/lights');
      const saved = Object.fromEntries(ids.map((id) => [id, lights[id]?.state || {}]));
      const restore = (id) => {
        const s = saved[id];
        if (!s.on) return { on: false, transitiontime: 0 };
        const out = { on: true, bri: s.bri, transitiontime: 0 };
        if (s.colormode === 'ct' && s.ct) out.ct = s.ct;
        else if (s.xy) out.xy = s.xy;
        return out;
      };
      const xy = hexToXy(color);
      for (let i = 0; i < times; i++) {
        await this.all(ids, () => ({ on: true, bri: 254, xy, transitiontime: 0 }));
        await sleep(onMs);
        await this.all(ids, restore);
        if (i < times - 1) await sleep(gapMs);
      }
      this.last = { at: Date.now(), ok: true, color, times };
      return true;
    } catch (err) {
      this.last = { at: Date.now(), ok: false, error: err.message };
      this.log?.warn(`Hue alert failed: ${err.message}`);
      return false;
    } finally {
      this.busy = false;
    }
  }
}

// How a rule's design turns into a flash: flash designs keep their rhythm (durationMs /
// speedMs flashes), a solid color is one long flash, anything else two flashes.
function alertFor(rule, design) {
  const color = design?.colors?.[0] || '#ffffff';
  const dur = rule.durationMs || 1000;
  if (design?.pattern === 'flash' && design.speedMs) {
    const times = Math.max(1, Math.round(dur / design.speedMs));
    return { color, times, onMs: Math.round(design.speedMs * 0.9), gapMs: Math.round(design.speedMs * 0.7) };
  }
  if (design?.pattern === 'solid') return { color, times: 1, onMs: dur };
  return { color, times: 2 };
}

// Link-button pairing: POST /api until the button has been pressed (or the time runs out).
async function pair(ip, { devicetype = 'wow-signalrgb-bridge#pc', timeoutMs = 30000, requestFn = request } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await requestFn(ip, 'POST', '/api', { devicetype });
    const ok = Array.isArray(r) && r[0]?.success?.username;
    if (ok) return r[0].success.username;
    const err = Array.isArray(r) && r[0]?.error;
    if (err && err.type !== 101) throw new Error(`Hue: ${err.description}`);
    if (Date.now() > end) throw new Error('Timed out: press the round button on the Hue Bridge, then run this again');
    await sleep(1000);
  }
}

module.exports = { HueAlerts, alertFor, pair, hexToXy, readLocal, writeLocal, request, LOCAL_FILE };
