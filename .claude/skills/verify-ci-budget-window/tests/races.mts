import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const source=fileURLToPath(new URL('../counterexamples/',import.meta.url));
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-ci-start-races-'));
try {
  copyFileSync(path.join(source,'StartFenceRace.tla'),path.join(scratch,'StartFenceRace.tla'));
  for (const [name,property] of [['AssignmentChanges','StillAssignedAtReceipt'],['ClaimSettles','StillLiveAtReceipt']]) {
    copyFileSync(path.join(source,`${name}.cfg`),path.join(scratch,`${name}.cfg`));
    const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config',`${name}.cfg`,'StartFenceRace.tla'],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    const output=`${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${property} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected ${property} counterexample was not produced`);
    }
    process.stdout.write(`Expected counterexample: ${property}\n`);
  }
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
