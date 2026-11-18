import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-replay-proto-model-'));
const cases = [[['CheckNumeric', 'CheckDecoded'], 'ExactPosition'], [['CheckDecoded'], 'ExactPosition'], [['CheckWire'], 'ExactPosition'], [['CheckMarker'], 'CorrectVersion'], [['PreserveEmpty'], 'EmptyPreserved']] as const;
try {
  copyFileSync(fileURLToPath(new URL('../models/ReplayProtoAdapter.tla', import.meta.url)), path.join(scratch, 'ReplayProtoAdapter.tla'));
  for (const [broken, invariant] of cases) {
    const constants = ['CheckNumeric', 'CheckDecoded', 'CheckWire', 'CheckMarker', 'PreserveEmpty'].map((name) => `${name} = ${broken.some((entry) => entry === name) ? 'FALSE' : 'TRUE'}`).join('\n          ');
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS ${constants}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'ReplayProtoAdapter.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected ReplayProtoAdapter/${broken.join('+')}/${invariant} counterexample`);
    }
    process.stdout.write(`Expected counterexample: ReplayProtoAdapter/${broken.join('+')}/${invariant}\n`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
