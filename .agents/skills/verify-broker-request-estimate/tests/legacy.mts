import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const model=fileURLToPath(new URL('../models/EstimatePresence.tla',import.meta.url));
for (const invariant of ['UnknownRejected','ConflictsRejected']) {
  const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-estimate-legacy-'));
  try {
    copyFileSync(model,path.join(scratch,'EstimatePresence.tla'));
    writeFileSync(path.join(scratch,'Legacy.cfg'),`CONSTANT Current = FALSE\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Legacy.cfg','EstimatePresence.tla'],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    const output=`${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected historical ${invariant} counterexample was not produced`);
    }
    process.stdout.write(`Expected historical counterexample: ${invariant}\n`);
  } finally { rmSync(scratch,{recursive:true,force:true}); }
}
