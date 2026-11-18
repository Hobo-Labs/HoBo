import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-replay-vector-model-'));
const cases = [['UseMap', 'RecordedMaximum'], ['OwnOnly', 'SelectedOwnEntries']] as const;
try {
  copyFileSync(fileURLToPath(new URL('../models/ReplaySequenceVector.tla', import.meta.url)), path.join(scratch, 'ReplaySequenceVector.tla'));
  for (const [broken, invariant] of cases) {
    const constants = `Streams = {"ordinary", "__proto__"}\n          LegacySpecial = {"__proto__"}\n          MaxEvents = 2\n          MaxSeq = 2\n          UseMap = ${broken === 'UseMap' ? 'FALSE' : 'TRUE'}\n          OwnOnly = ${broken === 'OwnOnly' ? 'FALSE' : 'TRUE'}`;
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS ${constants}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'ReplaySequenceVector.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected ReplaySequenceVector/${broken}/${invariant} counterexample`);
    }
    process.stdout.write(`Expected counterexample: ReplaySequenceVector/${broken}/${invariant}\n`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
