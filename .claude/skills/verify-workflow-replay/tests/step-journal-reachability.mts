import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-workflow-compensation-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/WorkflowStepJournal.tla', import.meta.url)), path.join(scratch, 'WorkflowStepJournal.tla'));
  writeFileSync(path.join(scratch, 'Reachability.cfg'), 'CONSTANT EnforceConsumption = TRUE\nSPECIFICATION Spec\nINVARIANT NoCompensatedCompletion\n');
  const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Reachability.cfg', 'WorkflowStepJournal.tla'], { cwd: scratch, encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant NoCompensatedCompletion is violated')) throw new Error(`expected compensated completion to be reachable\n${output}`);
  console.log('Reachable: caught failure, later outcome, completed workflow');
} finally { rmSync(scratch, { recursive: true, force: true }); }
