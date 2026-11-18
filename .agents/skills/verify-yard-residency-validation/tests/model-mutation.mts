import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS is required');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-residency-model-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/YardResidency.tla', import.meta.url)), path.join(scratch, 'YardResidency.tla'));
  writeFileSync(path.join(scratch, 'Mutant.cfg'), 'CONSTANTS EarlyExplicit = TRUE\nSPECIFICATION Spec\nINVARIANT ValidResidency\n');
  const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'YardResidency.tla'], { cwd: scratch, encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant ValidResidency is violated')) {
    process.stderr.write(output);
    throw new Error('expected invalid explicit residency counterexample');
  }
  process.stdout.write('Expected counterexample: early explicit residency acceptance\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
