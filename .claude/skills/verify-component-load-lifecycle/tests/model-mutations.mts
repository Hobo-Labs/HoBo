import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-component-load-model-'));
const flags = ['GuardLoaded', 'GuardLoading', 'CheckIdentity', 'CaptureLeases', 'ReleaseClaim'];
const invariants = ['Exclusive', 'Exclusive', 'CorrectIdentity', 'CapturedLeases', 'FailureReleased'];
try {
  copyFileSync(fileURLToPath(new URL('../models/ComponentLoad.tla', import.meta.url)), path.join(scratch, 'ComponentLoad.tla'));
  for (const [index, broken] of flags.entries()) {
    const constants = flags.map((name) => `${name} = ${name === broken ? 'FALSE' : 'TRUE'}`).join('\n          ');
    const invariant = invariants[index];
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS ${constants}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'ComponentLoad.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected ${broken}/${invariant} counterexample`);
    }
    process.stdout.write(`Expected counterexample: ${broken}/${invariant}\n`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
