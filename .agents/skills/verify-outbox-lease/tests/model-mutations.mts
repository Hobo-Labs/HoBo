import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const source = readFileSync(fileURLToPath(new URL('../models/DeliveryLease.tla', import.meta.url)), 'utf8');
const before = '/\\ generation = trackedGeneration';
if (source.split(before).length !== 2) throw new Error('generation guard mutation site is not unique');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-delivery-model-mutant-'));
try {
  writeFileSync(path.join(scratch, 'DeliveryLease.tla'), source.replace(before, '/\\ TRUE'));
  writeFileSync(path.join(scratch, 'Mutant.cfg'), 'CONSTANT MaxAttempts = 3\nSPECIFICATION Spec\nINVARIANT NoStaleAcknowledgment\n');
  const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'DeliveryLease.tla'], { cwd: scratch, encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant NoStaleAcknowledgment is violated')) {
    process.stderr.write(output);
    throw new Error('expected stale acknowledgment counterexample');
  }
  console.log('Expected counterexample: remove attempt guard/NoStaleAcknowledgment');
} finally { rmSync(scratch, { recursive: true, force: true }); }
