'use strict';
// Tails the newest WoWCombatLog*.txt in a Logs folder and emits complete lines.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

const LOG_RE = /^WoWCombatLog.*\.txt$/i;
const CHUNK = 1024 * 1024;

class LogWatcher extends EventEmitter {
  constructor({ logsDir, pollMs = 100, rescanMs = 3000, fromStart = false }) {
    super();
    this.logsDir = logsDir;
    this.pollMs = pollMs;
    this.rescanMs = rescanMs;
    this.fromStart = fromStart;
    this.file = null;
    this.offset = 0;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.firstScan = true;
  }

  start() {
    this.rescan();
    this.pollTimer = setInterval(() => this.poll(), this.pollMs);
    this.rescanTimer = setInterval(() => this.rescan(), this.rescanMs);
  }

  stop() {
    clearInterval(this.pollTimer);
    clearInterval(this.rescanTimer);
  }

  findNewest() {
    let entries;
    try {
      entries = fs.readdirSync(this.logsDir);
    } catch (err) {
      this.emit('warn', `Cannot read logs folder ${this.logsDir}: ${err.message}`);
      return null;
    }
    let best = null;
    for (const name of entries) {
      if (!LOG_RE.test(name)) continue;
      const full = path.join(this.logsDir, name);
      try {
        const st = fs.statSync(full);
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs, size: st.size };
      } catch { /* file vanished */ }
    }
    return best;
  }

  rescan() {
    const newest = this.findNewest();
    if (!newest || newest.path === this.file) {
      this.firstScan = false;
      return;
    }
    this.file = newest.path;
    // The file present at startup is old history: skip to its end unless asked.
    // Any file that shows up later is a fresh session: read it from the top.
    this.offset = this.firstScan && !this.fromStart ? newest.size : 0;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.firstScan = false;
    this.emit('file', this.file);
  }

  poll() {
    if (!this.file) return;
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return;
    }
    if (st.size < this.offset) {
      this.offset = 0;
      this.buffer = '';
    }
    if (st.size === this.offset) return;

    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(CHUNK);
      while (this.offset < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        this.buffer += this.decoder.write(buf.subarray(0, n));
        this.flushLines();
      }
    } catch (err) {
      this.emit('warn', `Read error: ${err.message}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  flushLines() {
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop();
    for (const line of parts) if (line) this.emit('line', line);
  }
}

module.exports = { LogWatcher };
