import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-dev-bootstrap-model-'));
const cases = [
  ['CheckPath', 'NoInvalidUse'],
  ['RespectOverride', 'NoOverrideFallback'],
  ['HonorFailure', 'NoReadyAfterFailure'],
  ['VerifyOutput', 'NoReadyWithoutExecutable'],
] as const;
try {
  copyFileSync(fileURLToPath(new URL('../models/DevBootstrap.tla', import.meta.url)), path.join(scratch, 'DevBootstrap.tla'));
  for (const [broken, invariant] of cases) {
    const flags = ['CheckPath', 'RespectOverride', 'HonorFailure', 'VerifyOutput'].map((name) => `${name} = ${name === broken ? 'FALSE' : 'TRUE'}`).join('\n          ');
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS MaxAttempts = 2\n          ${flags}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'DevBootstrap.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) throw new Error(`${broken}: expected ${invariant} counterexample\n${output}`);
    console.log(`Expected counterexample: ${broken}/${invariant}`);
  }
  const model = path.join(scratch, 'DevBootstrap.tla');
  const original = readFileSync(model, 'utf8');
  const before = 'ELSE IF initialTarget';
  if (original.split(before).length !== 2) throw new Error('existing-target mutation site is not unique');
  writeFileSync(model, original.replace(before, 'ELSE IF FALSE'));
  writeFileSync(path.join(scratch, 'Mutant.cfg'), 'CONSTANTS MaxAttempts = 2\n          CheckPath = TRUE\n          RespectOverride = TRUE\n          HonorFailure = TRUE\n          VerifyOutput = TRUE\nSPECIFICATION Spec\nINVARIANT NoRedundantInstall\n');
  const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'DevBootstrap.tla'], { cwd: scratch, encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant NoRedundantInstall is violated')) throw new Error(`expected NoRedundantInstall counterexample\n${output}`);
  console.log('Expected counterexample: existing target/NoRedundantInstall');
} finally { rmSync(scratch, { recursive: true, force: true }); }
