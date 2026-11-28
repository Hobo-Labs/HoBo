import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if(!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-local-work-model-'));
const names=['CheckSnapshot','CheckMaterialize','BindSnapshot','BindDigest','CheckAfterApproval','CheckBeforeStart','CheckWorker','ExecuteSnapshot'];
const cases=[
 ['CheckSnapshot','SnapshotRequired'],
 ['CheckMaterialize','ExecutionBindsInputs'],
 ['BindSnapshot','ExecutionBindsInputs'],
 ['BindDigest','ProofBindsInputs'],
 ['CheckAfterApproval','NoChangedPreparation'],
 ['CheckBeforeStart','LaunchWasChecked'],
 ['CheckWorker','WorkerSnapshotChecked'],
 ['ExecuteSnapshot','ActualWorkMatches'],
];
try {
 copyFileSync(fileURLToPath(new URL('../models/LocalWorkBinding.tla',import.meta.url)),path.join(scratch,'LocalWorkBinding.tla'));
 for(const [mutation,invariant] of cases){
  writeFileSync(path.join(scratch,'Mutant.cfg'),`CONSTANTS ${names.map(name=>`${name} = ${name === mutation ? 'FALSE' : 'TRUE'}`).join('\n          ')}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
  const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg','LocalWorkBinding.tla'],{cwd:scratch,encoding:'utf8'});
  if(result.error) throw result.error;
  const output=`${result.stdout}\n${result.stderr}`;
  if(result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)){process.stderr.write(output);throw new Error(`expected ${mutation}/${invariant} counterexample`);}
  process.stdout.write(`Expected model counterexample: ${mutation}/${invariant}\n`);
 }
} finally {rmSync(scratch,{recursive:true,force:true});}
