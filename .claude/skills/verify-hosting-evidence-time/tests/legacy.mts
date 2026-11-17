import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const cases=[
  ['FinancialFreshness','NoFuture','CONSTRAINT ValidInput\n'],
  ['FinancialFreshness','ValidCalendar',''],
  ['FinancialFreshness','FreshAdmitted','CONSTRAINT ValidInput\n'],
  ['FinancialHistory','NoOlder',''],
  ['FinancialHistory','EqualChangeNeedsEvidence',''],
  ['FinancialHistory','NewerAccepted',''],
];
for (const [model,invariant,constraint] of cases) {
  const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-financial-time-legacy-'));
  try {
    copyFileSync(fileURLToPath(new URL(`../models/${model}.tla`,import.meta.url)),path.join(scratch,`${model}.tla`));
    writeFileSync(path.join(scratch,'Legacy.cfg'),`CONSTANT Current = FALSE\nSPECIFICATION Spec\n${constraint}INVARIANT ${invariant}\n`);
    const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Legacy.cfg',`${model}.tla`],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    const output=`${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected historical ${model}/${invariant} counterexample was not produced`);
    }
    process.stdout.write(`Expected historical counterexample: ${model}/${invariant}\n`);
  } finally { rmSync(scratch,{recursive:true,force:true}); }
}
