import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS is required');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-wire-model-'));
const names = ['CheckUnknown', 'CheckVersion', 'CheckAmount', 'CheckParsedAmount', 'CheckParsedResidency', 'CheckIdentity', 'CheckV1Labels', 'CheckV2Labels', 'CheckPropertyText', 'CheckCanonical', 'CheckDigest'];
const cases = [
  [['CheckUnknown'], 'NoUnknown'],
  [['CheckVersion'], 'NoLegacy'],
  [['CheckAmount', 'CheckParsedAmount'], 'NoNegative'],
  [['CheckIdentity'], 'NoEmptyIdentity'],
  [['CheckV1Labels'], 'NoMixedV1Labels'],
  [['CheckV2Labels'], 'NoAmbiguousV2Labels'],
  [['CheckPropertyText'], 'CanonicalPropertyText'],
  [['CheckParsedResidency'], 'ValidResidency'],
  [['CheckCanonical'], 'Canonical'],
  [['CheckDigest'], 'MatchingDigest'],
] as const;
try {
  copyFileSync(fileURLToPath(new URL('../models/YardRequestWire.tla', import.meta.url)), path.join(scratch, 'YardRequestWire.tla'));
  for (const [mutation, invariant] of cases) {
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS ${names.map(name => `${name} = ${mutation.some(item => item === name) ? 'FALSE' : 'TRUE'}`).join('\n          ')}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'YardRequestWire.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected counterexample for ${mutation}/${invariant}`);
    }
    process.stdout.write(`Expected counterexample: ${mutation}/${invariant}\n`);
  }
  writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS ${names.map(name => `${name} = ${name === 'CheckAmount' ? 'FALSE' : 'TRUE'}`).join('\n          ')}\nSPECIFICATION Spec\nINVARIANT NoNegative\n`);
  const redundant = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'YardRequestWire.tla'], { cwd: scratch, encoding: 'utf8' });
  if (redundant.error) throw redundant.error;
  if (redundant.status !== 0 || !redundant.stdout.includes('No error has been found')) throw new Error(`expected parser guard to reject negative amounts: ${redundant.stdout}\n${redundant.stderr}`);
  process.stdout.write('Parser guard independently rejects negative amounts\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
