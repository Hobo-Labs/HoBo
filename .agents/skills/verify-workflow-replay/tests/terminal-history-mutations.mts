import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-workflow-terminal-model-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/WorkflowTerminalHistory.tla', import.meta.url)), path.join(scratch, 'WorkflowTerminalHistory.tla'));
  writeFileSync(path.join(scratch, 'Mutant.cfg'), 'CONSTANT RejectDuplicates = FALSE\nSPECIFICATION Spec\nINVARIANT DuplicateHistoryRefused\n');
  const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'WorkflowTerminalHistory.tla'], { cwd: scratch, encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant DuplicateHistoryRefused is violated')) throw new Error(`expected DuplicateHistoryRefused counterexample\n${output}`);
  console.log('Expected counterexample: WorkflowTerminalHistory/DuplicateHistoryRefused');
} finally { rmSync(scratch, { recursive: true, force: true }); }
