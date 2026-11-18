import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-workflow-local-model-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/WorkflowLocalLease.tla', import.meta.url)), path.join(scratch,'WorkflowLocalLease.tla'));
  for (const name of ['RequireLease','HoldPending']) {
    writeFileSync(path.join(scratch,'Mutant.cfg'), `CONSTANTS Workers = {"first", "retry"}\n          RequireLease = ${name === 'RequireLease' ? 'FALSE' : 'TRUE'}\n          HoldPending = ${name === 'HoldPending' ? 'FALSE' : 'TRUE'}\nSPECIFICATION Spec\nINVARIANT NoOverlap\n`);
    const result = spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg','WorkflowLocalLease.tla'],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes('Invariant NoOverlap is violated')) {
      process.stderr.write(output);
      throw new Error(`expected WorkflowLocalLease/${name} counterexample`);
    }
    process.stdout.write(`Expected counterexample: WorkflowLocalLease/${name}/NoOverlap\n`);
  }
} finally { rmSync(scratch,{recursive:true,force:true}); }
