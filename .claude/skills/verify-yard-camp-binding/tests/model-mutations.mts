import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS is required');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-camp-model-'));
const models = [
  ['YardCampBinding', ['PreserveEnv', 'ValidateEnv', 'CheckParent', 'HonorExplicit'], [
    ['PreserveEnv', 'EnvCaptured'], ['ValidateEnv', 'InvalidRefused'],
    ['CheckParent', 'ParentBound'], ['HonorExplicit', 'ExplicitPreserved'],
  ]],
  ['YardCampGeneration', ['PrecheckCamp', 'PostcheckCamp', 'RecordUncertain'], [
    ['PrecheckCamp', 'NoKnownForeignHold'], ['PrecheckCamp', 'NoKnownForeignEffect'],
    ['PostcheckCamp', 'NoForeignReceipt'], ['RecordUncertain', 'MismatchUncertain'],
  ]],
  ['CampExact', ['CheckExactId'], [
    ['CheckExactId', 'NoExactSubstitution'], ['CheckExactId', 'NoUnidentifiedExactWork'],
  ]],
] as const;
try {
  for (const [model, names, cases] of models) {
    copyFileSync(fileURLToPath(new URL(`../models/${model}.tla`, import.meta.url)), path.join(scratch, `${model}.tla`));
    for (const [mutation, invariant] of cases) {
      writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS ${names.map(name => `${name} = ${name === mutation ? 'FALSE' : 'TRUE'}`).join('\n          ')}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
      const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', `${model}.tla`], { cwd: scratch, encoding: 'utf8' });
      if (result.error) throw result.error;
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
        process.stderr.write(output);
        throw new Error(`expected counterexample for ${model}/${mutation}/${invariant}`);
      }
      process.stdout.write(`Expected counterexample: ${model}/${mutation}/${invariant}\n`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
