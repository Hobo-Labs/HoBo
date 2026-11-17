import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-yard-local-model-'));
const cases = [
 ['LocalHostingProof',['CheckAuthority','CheckBinding','CheckPolicy','CheckObligations','CheckEvidence','CheckZero'],[
  ['CheckAuthority','HasAuthority'],['CheckBinding','BoundWork'],['CheckPolicy','PolicyAllows'],['CheckObligations','ObligationsMet'],['CheckEvidence','PolicyEvidence'],['CheckZero','ZeroLiability']]],
 ['LocalHostingContext',['CheckIdentities','CheckAuthorities','CheckEvidence','CheckFinal'],[
  ['CheckIdentities','IdentitiesCurrent'],['CheckAuthorities','AuthoritiesCurrent'],['CheckEvidence','EvidenceCurrent'],['CheckFinal','CurrentAtReceipt']]],
 ['LocalYardGeneration',['RequireFunding'],[['RequireFunding','FundedGeneration']]],
] as const;
try {
 for(const [model,names,mutations] of cases){
  copyFileSync(fileURLToPath(new URL(`../models/${model}.tla`,import.meta.url)),path.join(scratch,`${model}.tla`));
  for(const [mutation,invariant] of mutations){
   writeFileSync(path.join(scratch,'Mutant.cfg'),`CONSTANTS ${names.map(name=>`${name} = ${name === mutation ? 'FALSE' : 'TRUE'}`).join('\n          ')}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
   const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg',`${model}.tla`],{cwd:scratch,encoding:'utf8'});
   if(result.error) throw result.error;
   const output=`${result.stdout}\n${result.stderr}`;
   if(result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)){
    process.stderr.write(output); throw new Error(`expected ${model}/${mutation}/${invariant} counterexample`);
   }
   process.stdout.write(`Expected counterexample: ${model}/${mutation}/${invariant}\n`);
  }
 }
} finally {rmSync(scratch,{recursive:true,force:true});}
