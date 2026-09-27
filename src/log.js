'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl) => (...args) => {
    if (LEVELS[lvl] < min) return;
    const stamp = new Date().toTimeString().slice(0, 8);
    const fn = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
    fn(`${stamp} ${lvl.toUpperCase().padEnd(5)}`, ...args);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

module.exports = { createLogger };
