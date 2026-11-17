import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const model=fileURLToPath(new URL('../models/MeteredBudget.tla',import.meta.url));
const config=fileURLToPath(new URL('../models/MeteredBudget.cfg',import.meta.url));
const original=readFileSync(model,'utf8');
const replay='Replay == /\\ \\E r \\in Requests : phase[r] = "held"\n          /\\ UNCHANGED vars';
const brokenReplay='Replay == \\E r \\in Requests:\n          /\\ phase[r] = "held"\n          /\\ phase\' = [phase EXCEPT ![r] = "new"]\n          /\\ amount\' = [amount EXCEPT ![r] = 0]\n          /\\ UNCHANGED <<issued, spent, evidenceGood, overrun, outside, badAdmission>>';
const cases=[
  ['missing-budget','/\\ phase[r] = "new" /\\ evidenceGood /\\ spent + Held + n <= Budget','/\\ phase[r] = "new" /\\ evidenceGood','SafeAdmission'],
  ['bad-evidence','/\\ phase[r] = "new" /\\ evidenceGood /\\ spent + Held + n <= Budget','/\\ phase[r] = "new" /\\ spent + Held + n <= Budget','SafeAdmission'],
  ['replay-release',replay,brokenReplay,'IssuedRetainsHold'],
];
for (const [label,oldText,newText,invariant] of cases) {
  if (!original.includes(oldText)) throw new Error(`model mutation ${label} no longer applies`);
  const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-meter-mutant-'));
  try {
    writeFileSync(path.join(scratch,'MeteredBudget.tla'),original.replace(oldText,newText));
    copyFileSync(config,path.join(scratch,'MeteredBudget.cfg'));
    const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','MeteredBudget.cfg','MeteredBudget.tla'],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    const output=`${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected ${label} counterexample was not produced`);
    }
    process.stdout.write(`Expected model counterexample: ${label} violates ${invariant}\n`);
  } finally { rmSync(scratch,{recursive:true,force:true}); }
}
