import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-shared-policy-model-'));
const cases = [
  ['PolicyShape', String.raw`constraints \in {"missing", "array"}`, String.raw`constraints \in {"missing", "array", "null"}`, 'InvalidShapesRejected', ''],
  ['SharedBudget', String.raw`~costFits`, String.raw`FALSE`, 'BudgetFits', ''],
  ['SharedBudget', String.raw`(strict /\ ~native /\ ~planning)`, String.raw`FALSE`, 'DeferredNativeEvidence', ''],
  ['BudgetContext', String.raw`IF ValidateContext THEN "refused" ELSE "crashed"`, String.raw`IF FALSE THEN "refused" ELSE "crashed"`, 'NoMalformedInputCrash', 'CONSTANTS ValidateContext = TRUE\n          ValidateMeasurements = TRUE'],
  ['BudgetContext', String.raw`IF ValidateMeasurements`, String.raw`IF FALSE`, 'InvalidMeasurementsRefused', 'CONSTANTS ValidateContext = TRUE\n          ValidateMeasurements = TRUE'],
] as const;
try {
  for (const [model, before, after, invariant, constants] of cases) {
    const original = readFileSync(fileURLToPath(new URL(`../models/${model}.tla`, import.meta.url)), 'utf8');
    if (original.split(before).length !== 2) throw new Error(`${model}/${invariant}: mutation site is not unique`);
    writeFileSync(path.join(scratch, `${model}.tla`), original.replace(before, after));
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `${constants}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', `${model}.tla`], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) throw new Error(`${model}/${invariant}: expected counterexample\n${output}`);
    console.log(`Expected counterexample: ${model}/${invariant}`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
