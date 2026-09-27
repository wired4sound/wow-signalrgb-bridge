'use strict';
// Minimal client for the SignalRGB Pro local API (http://127.0.0.1:16038/api/v1).
// All API specifics live here, since SignalRGB says endpoints may change.

class SignalRGBError extends Error {}

class SignalRGBClient {
  constructor({ host = '127.0.0.1', port = 16038, timeoutMs = 2000 } = {}) {
    this.base = `http://${host}:${port}/api/v1`;
    this.timeoutMs = timeoutMs;
    this.effectCache = null;
  }

  async request(method, path, body) {
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SignalRGBError(`Cannot reach SignalRGB at ${this.base} (${err.cause?.code || err.message}). Is SignalRGB running?`);
    }
    if (res.status === 403) {
      throw new SignalRGBError('SignalRGB returned 403. Sign in to your Pro account in SignalRGB.');
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok || (json && json.status && json.status !== 'ok')) {
      const msg = json?.errors?.[0]?.title || json?.errors?.[0]?.detail || text || res.statusText;
      throw new SignalRGBError(`${method} ${path} failed (${res.status}): ${msg}`);
    }
    return json;
  }

  static items(json) {
    const d = json?.data;
    if (Array.isArray(d)) return d;
    return d?.items || [];
  }

  async getCurrentEffect() {
    const json = await this.request('GET', '/lighting');
    const d = json?.data || {};
    return {
      id: d.id,
      name: d.attributes?.name,
      enabled: d.attributes?.enabled,
      brightness: d.attributes?.global_brightness,
    };
  }

  async listEffects(refresh = false) {
    if (this.effectCache && !refresh) return this.effectCache;
    const json = await this.request('GET', '/lighting/effects');
    this.effectCache = SignalRGBClient.items(json).map((e) => ({ id: e.id, name: e.attributes?.name || e.id }));
    return this.effectCache;
  }

  async resolveEffectId(name) {
    const find = (list) => list.find((e) => e.name.toLowerCase() === name.toLowerCase());
    let hit = find(await this.listEffects());
    if (!hit) hit = find(await this.listEffects(true));
    if (!hit) throw new SignalRGBError(`Effect "${name}" not found in SignalRGB`);
    return hit.id;
  }

  async applyEffect(id) {
    return this.request('POST', `/lighting/effects/${encodeURIComponent(id)}/apply`);
  }

  async listPresets(id) {
    const json = await this.request('GET', `/lighting/effects/${encodeURIComponent(id)}/presets`);
    return SignalRGBClient.items(json).map((p) => p.id || p.attributes?.name || p);
  }

  async applyPreset(id, preset) {
    return this.request('PATCH', `/lighting/effects/${encodeURIComponent(id)}/presets`, { preset });
  }

  async setBrightness(value) {
    return this.request('PATCH', '/lighting/global_brightness', { global_brightness: value });
  }

  async applyByName(name, preset = null) {
    const id = await this.resolveEffectId(name);
    await this.applyEffect(id);
    if (preset) await this.applyPreset(id, preset);
  }
}

module.exports = { SignalRGBClient, SignalRGBError };
