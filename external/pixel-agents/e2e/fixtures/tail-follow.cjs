#!/usr/bin/env node
'use strict';

const fs = require('fs');

const style = process.argv[2];
const files = process.argv.slice(3).filter(Boolean);
if (!style || files.length === 0) {
  process.stderr.write('usage: tail-follow.cjs <style> <file> [file...]\n');
  process.exit(2);
}

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

const STYLES = {
  monitor: {
    color: '\u001b[33m',
    title: 'e2e monitor',
    sub:
      'yellow [test] = actions + checks from the Playwright test · ' +
      'magenta [external·tag] = detached mock claude sessions · cosmetic only',
  },
  external: {
    color: '\u001b[35m',
    title: 'external sessions monitor',
    sub:
      'streams narration from mock claude processes that Pixel Agents adopts\n' +
      '(external sessions have no terminal of their own)',
  },
  test: {
    color: '\u001b[33m',
    title: 'test narrator',
    sub:
      'streams the actions this Playwright test performs and the checks it makes\n' +
      '(cosmetic only — assertions run in the test process, not in this terminal)',
  },
};

const preset = STYLES[style];
if (preset) {
  process.stdout.write(
    `${preset.color}══ ${preset.title} ══${RESET}\n` + `${DIM}${preset.sub}${RESET}\n\n`,
  );
}

const positions = new Array(files.length).fill(0);

setInterval(() => {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size < positions[i]) positions[i] = 0;
    if (stat.size > positions[i]) {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(stat.size - positions[i]);
      fs.readSync(fd, buffer, 0, buffer.length, positions[i]);
      fs.closeSync(fd);
      positions[i] = stat.size;
      process.stdout.write(buffer.toString('utf8'));
    }
  }
}, 250);
