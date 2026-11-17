import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');
const generator = path.join(root, 'scripts/generate-messages.ts');

test('protocol generation detects missing and stale output without changing it', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pixel-protocol-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'messages.ts');
  const run = (...args) =>
    spawnSync(process.execPath, [tsx, generator, '--output', output, ...args], {
      cwd: root,
      encoding: 'utf8',
    });

  const missing = run('--check');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /generated messages are stale/);

  const generated = run();
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(
    readFileSync(output, 'utf8'),
    readFileSync(path.join(root, 'core/src/messages.ts'), 'utf8'),
  );
  const current = run('--check');
  assert.equal(current.status, 0, current.stderr);

  writeFileSync(output, 'stale\n');
  const stale = run('--check');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /generated messages are stale/);
  assert.equal(readFileSync(output, 'utf8'), 'stale\n');
});
