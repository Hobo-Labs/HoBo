import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS is required');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-wire-model-'));
const names = ['CheckUnknown', 'CheckVersion', 'CheckAmount', 'CheckIdentity', 'CheckCanonical', 'CheckDigest'];
const cases = [
  ['CheckUnknown', 'NoUnknown'],
  ['CheckVersion', 'NoLegacy'],
  ['CheckAmount', 'NoNegative'],
  ['CheckIdentity', 'NoEmptyIdentity'],
  ['CheckCanonical', 'Canonical'],
  ['CheckDigest', 'MatchingDigest'],
];
try {
  copyFileSync(fileURLToPath(new URL('../models/YardRequestWire.tla', import.meta.url)), path.join(scratch, 'YardRequestWire.tla'));
  for (const [mutation, invariant] of cases) {
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS ${names.map(name => `${name} = ${name === mutation ? 'FALSE' : 'TRUE'}`).join('\n          ')}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'YardRequestWire.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected counterexample for ${mutation}/${invariant}`);
    }
    process.stdout.write(`Expected counterexample: ${mutation}/${invariant}\n`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
