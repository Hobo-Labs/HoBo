import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-workflow-run-id-model-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/WorkflowRunIdBoundary.tla', import.meta.url)), path.join(scratch, 'WorkflowRunIdBoundary.tla'));
  for (const invariant of ['NoInvalidAccess', 'NoCoercedAlias']) {
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS GuardId = FALSE\n          SafeCheck = TRUE\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'WorkflowRunIdBoundary.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) throw new Error(`expected ${invariant} counterexample\n${output}`);
    console.log(`Expected counterexample: WorkflowRunIdBoundary/${invariant}`);
  }
  writeFileSync(path.join(scratch, 'Mutant.cfg'), 'CONSTANTS GuardId = TRUE\n          SafeCheck = FALSE\nSPECIFICATION Spec\nINVARIANT NoInvalidInspection\n');
  const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'WorkflowRunIdBoundary.tla'], { cwd: scratch, encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant NoInvalidInspection is violated')) throw new Error(`expected NoInvalidInspection counterexample\n${output}`);
  console.log('Expected counterexample: WorkflowRunIdBoundary/NoInvalidInspection');
} finally { rmSync(scratch, { recursive: true, force: true }); }
