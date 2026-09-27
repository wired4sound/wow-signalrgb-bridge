#!/usr/bin/env node
'use strict';
// WoW -> SignalRGB bridge.
//
//   node src/index.js                  run live (combat log + screen beacon + settings page)
//   node src/index.js --open           same, and open the settings page in the browser
//   node src/index.js --dry-run        log effect changes without calling SignalRGB
//   node src/index.js --replay <file>  run a saved log through the rules, print matches
//
// Other flags: --logs <dir>, --config <file>, --rules <file>, --from-start, --verbose, --no-beacon

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { loadConfig, readJson } = require('./config');
const { createLogger } = require('./log');
const { CombatLogParser } = require('./parser');
const { StateTracker } = require('./tracker');
const { RuleEngine, loadRules } = require('./rules');
const { BridgeApp, ROOT } = require('./app');
const { createServer } = require('./server');

function parseArgs(argv) {
  const args = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--logs', '--config', '--rules', '--replay'].includes(a)) args[a.slice(2)] = argv[++i];
    else args.flags.add(a);
  }
  return args;
}

// Replay: no timers, no SignalRGB, no beacon. Prints what each rule would do.
function replay(file, cfg, rules, log) {
  const fake = {
    active: new Set(),
    isActive(k) { return this.active.has(k); },
    activate(e) { this.active.add(e.key); log.info(`+ ${e.key} -> ${e.effect} [${e.reason}]`); },
    clear(k, why) { this.active.delete(k); log.info(`- ${k} (${why})`); },
  };
  for (const r of rules) r.durationMs = r.durationMs || 1; // silence the no-duration warning
  const parser = new CombatLogParser();
  const tracker = new StateTracker({ playerName: cfg.playerName || null, lowHealthThreshold: cfg.lowHealthThreshold, log });
  const engine = new RuleEngine(rules, fake, { log });
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const ev = line && parser.parse(line);
    if (ev) for (const e of tracker.process(ev)) engine.handle(e);
  }
  log.info(`Replayed ${lines.length} lines`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configFile = path.resolve(args.config || path.join(ROOT, 'config.json'));
  const rulesFile = path.resolve(args.rules || path.join(ROOT, 'rules.json'));

  if (args.replay) {
    const cfg = loadConfig(configFile);
    const log = createLogger(args.flags.has('--verbose') ? 'debug' : cfg.logLevel);
    return replay(path.resolve(args.replay), cfg, loadRules(readJson(rulesFile)), log);
  }

  const app = new BridgeApp({
    configFile,
    rulesFile,
    dryRun: args.flags.has('--dry-run'),
    logsDir: args.logs || null,
    fromStart: args.flags.has('--from-start'),
    verbose: args.flags.has('--verbose'),
  });
  if (args.flags.has('--no-beacon')) app.cfg.beacon.enabled = false;

  const port = app.cfg.ui.port;
  const server = createServer(app, { port, onShutdown: () => stop() });
  const url = `http://127.0.0.1:${port}/`;
  server.on('error', (err) => app.log.error(`Settings page unavailable on port ${port}: ${err.message}`));
  server.listen(port, '127.0.0.1', () => {
    app.log.info(`Settings page: ${url}`);
    if (args.flags.has('--open')) exec(`start "" "${url}"`);
  });

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    server.close();
    await app.stop();
    process.exit(0);
  }

  await app.start();
  // SIGHUP: console window closed. SIGBREAK: Ctrl+Break.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, stop);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
