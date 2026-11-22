import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-workflow-parallel-'));
const cases = [
  [false, true, true, 'NoUnscheduledEffect'],
  [true, false, true, 'NoDifferentNameEffect'],
  [true, true, false, 'NoRecordedEffectRepeated'],
  [true, true, true, 'NoValidRecovery'],
] as const;
try {
  copyFileSync(fileURLToPath(new URL('../models/WorkflowParallelReplay.tla', import.meta.url)), path.join(scratch, 'WorkflowParallelReplay.tla'));
  for (const [schedule, name, reuse, invariant] of cases) {
    const bool = (value: boolean) => value ? 'TRUE' : 'FALSE';
    writeFileSync(path.join(scratch, 'Check.cfg'), `CONSTANTS EnforceSchedule = ${bool(schedule)}\n          EnforceName = ${bool(name)}\n          ReuseLater = ${bool(reuse)}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Check.cfg', 'WorkflowParallelReplay.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) throw new Error(`expected ${invariant} counterexample\n${output}`);
    console.log(invariant === 'NoValidRecovery' ? 'Reachable: scheduled gap resumes and reuses later outcome' : `Expected counterexample: ${invariant}`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
