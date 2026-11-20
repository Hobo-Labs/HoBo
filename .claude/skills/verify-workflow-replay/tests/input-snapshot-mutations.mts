import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-workflow-input-model-'));
const cases = [['CheckInput', 'NoInvalidEffect'], ['CheckInput', 'NoInvalidRecord'], ['CheckSnapshot', 'EffectMatchesJournal']] as const;
try {
  copyFileSync(fileURLToPath(new URL('../models/WorkflowInputSnapshot.tla', import.meta.url)), path.join(scratch,'WorkflowInputSnapshot.tla'));
  for (const [name, invariant] of cases) {
    writeFileSync(path.join(scratch,'Mutant.cfg'), `CONSTANTS CheckInput = ${name === 'CheckInput' ? 'FALSE' : 'TRUE'}\n          CheckSnapshot = ${name === 'CheckSnapshot' ? 'FALSE' : 'TRUE'}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg','WorkflowInputSnapshot.tla'],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected WorkflowInputSnapshot/${name}/${invariant} counterexample`);
    }
    process.stdout.write(`Expected counterexample: WorkflowInputSnapshot/${name}/${invariant}\n`);
  }
} finally { rmSync(scratch,{recursive:true,force:true}); }
