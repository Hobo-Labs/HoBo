import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-fuzz-restore-model-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/FuzzRestore.tla', import.meta.url)), path.join(scratch, 'FuzzRestore.tla'));
  for (const [broken, invariant] of [['PreserveBaseline', 'ReplayMatches'], ['LogRestore', 'ReplayMatches'], ['AdvanceClock', 'ReplacementAdvances'], ['CheckValidity', 'OnlyValidRestored'], ['AtomicReject', 'RejectedPreserves']]) {
    const flags = ['PreserveBaseline', 'LogRestore', 'AdvanceClock', 'CheckValidity', 'AtomicReject'].map((name) => `${name} = ${name === broken ? 'FALSE' : 'TRUE'}`).join('\n          ');
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS Limit = 2\n          ${flags}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'FuzzRestore.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected ${broken}/${invariant} counterexample`);
    }
    process.stdout.write(`Expected counterexample: ${broken}/${invariant}\n`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
