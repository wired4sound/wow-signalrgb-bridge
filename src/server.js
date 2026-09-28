'use strict';
// Local settings page and JSON API. Binds to 127.0.0.1 only.
//
// Browsers let any web page send requests to localhost, so:
// - the Host header must be 127.0.0.1/localhost (blocks DNS rebinding), and
// - every write needs an "X-Bridge: 1" header, which a cross-site page can't add
//   without a CORS preflight this server never approves.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { PATTERNS, PARAMS } = require('./patterns');

const UI_DIR = path.join(__dirname, '..', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/patterns.js': [path.join(__dirname, 'patterns.js'), 'application/javascript; charset=utf-8'],
};
// 1x1 transparent GIF for effect pings.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// A black 24-bit BMP of the given size. Gauge effects read a live value from the
// image's dimensions (the one channel SignalRGB effects can receive from localhost).
function bmp(width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const b = Buffer.alloc(size);
  b.write('BM', 0, 'ascii');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(rowSize * height, 34);
  return b;
}

// 12-bit word 0..4095 -> width 1..4096 (height 1); null -> height 2 ("no value").
function wordImage(v) {
  if (!Number.isInteger(v) || v < 0) return bmp(1, 2);
  return bmp(Math.min(v, 4095) + 1, 1);
}

// value 0..1 -> width 1..1001; null -> height 2 ("no value").
function gaugeImage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bmp(1, 2);
  return bmp(Math.round(Math.min(1, Math.max(0, value)) * 1000) + 1, 1);
}
const MAX_BODY = 256 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('Body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function hostOk(req, port) {
  const h = String(req.headers.host || '').toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

function createServer(app, { port = 17700, onShutdown = null } = {}) {
  const routes = [
    ['POST', /^\/api\/shutdown$/, () => {
      if (!onShutdown) throw new Error('Shutdown is not available');
      setTimeout(onShutdown, 50);
      return { ok: true };
    }],
    ['GET', /^\/api\/state$/, () => app.getState()],
    ['GET', /^\/api\/settings$/, () => app.getSettings()],
    ['PUT', /^\/api\/settings$/, (m, body) => app.saveSettings(body)],
    ['GET', /^\/api\/rules$/, () => app.getRules()],
    ['PUT', /^\/api\/rules$/, (m, body) => app.saveRules(body)],
    ['GET', /^\/api\/effects$/, () => ({ effects: app.effects, patterns: PATTERNS, params: PARAMS, dir: app.effectsDir })],
    ['PUT', /^\/api\/effects\/([A-Za-z0-9_]+)$/, (m, body) => app.saveEffect(m[1], body)],
    ['POST', /^\/api\/effects\/([A-Za-z0-9_]+)\/reset$/, (m) => app.resetEffect(m[1])],
    ['POST', /^\/api\/effects\/install$/, () => app.installAndRestart()],
    ['POST', /^\/api\/preview$/, (m, body) => app.preview(body.effect, body.ms)],
    ['POST', /^\/api\/preview\/stop$/, () => { app.stopPreview(); return { ok: true }; }],
    ['POST', /^\/api\/test\/gauge$/, (m, body) => app.fakeGauge(body.source, body.value, body.ms)],
    ['POST', /^\/api\/test\/gauge-demo$/, (m, body) => app.gaugeDemo(body.source, body.secs)],
    ['GET', /^\/api\/signalrgb\/effects$/, async () => (await app.listSignalRGBEffects()).map((e) => e.name)],
  ];

  const server = http.createServer(async (req, res) => {
    if (!hostOk(req, server.address()?.port ?? port)) return send(res, 403, { error: 'Bad host' });
    const url = new URL(req.url, 'http://127.0.0.1');

    // Effect heartbeat: loaded as an <img> from inside SignalRGB, so no custom header.
    if (req.method === 'GET' && url.pathname === '/api/effect-ping') {
      app.effectPing(Object.fromEntries(url.searchParams));
      return send(res, 200, GIF, 'image/gif');
    }
    if (req.method === 'GET' && url.pathname === '/api/gauge.bmp') {
      return send(res, 200, gaugeImage(app.gaugeValue(url.searchParams.get('source'))), 'image/bmp');
    }
    if (req.method === 'GET' && url.pathname === '/api/w.bmp') {
      return send(res, 200, wordImage(app.channelWord(url.searchParams.get('k'))), 'image/bmp');
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const full = path.isAbsolute(file) ? file : path.join(UI_DIR, file);
      return fs.readFile(full, (err, data) => (err ? send(res, 404, { error: 'Not found' }) : send(res, 200, data, type)));
    }

    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (!m || req.method !== method) continue;
      if (method !== 'GET' && req.headers['x-bridge'] !== '1') return send(res, 403, { error: 'Missing X-Bridge header' });
      try {
        const body = method === 'GET' ? {} : await readBody(req);
        return send(res, 200, await fn(m, body));
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    return send(res, 404, { error: 'Not found' });
  });
  return server;
}

module.exports = { createServer, gaugeImage, wordImage };
