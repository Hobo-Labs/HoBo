import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if(!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-bindle-runtime-model-'));
const names=['CheckOci','CheckWasm','NoInventOci','NoInventWasm','PreserveDeclared','PreserveMixed'];
const cases=[['CheckOci','RequiredOci'],['CheckWasm','RequiredWasm'],['NoInventOci','NoUnneededOci'],['NoInventWasm','NoUnneededWasm'],['PreserveDeclared','DeclaredPreserved'],['PreserveMixed','RequiredWasm']];
try {
 copyFileSync(fileURLToPath(new URL('../models/BindleRuntimeInference.tla',import.meta.url)),path.join(scratch,'BindleRuntimeInference.tla'));
 for(const [mutation,invariant] of cases){
  writeFileSync(path.join(scratch,'Mutant.cfg'),`CONSTANTS MaxItems = 2\n          ${names.map(name=>`${name} = ${name === mutation ? 'FALSE' : 'TRUE'}`).join('\n          ')}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
  const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg','BindleRuntimeInference.tla'],{cwd:scratch,encoding:'utf8'});
  if(result.error) throw result.error;
  const output=`${result.stdout}\n${result.stderr}`;
  if(result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)){ process.stderr.write(output); throw new Error(`expected ${mutation}/${invariant} counterexample`); }
  process.stdout.write(`Expected model counterexample: ${mutation}/${invariant}\n`);
 }
} finally {rmSync(scratch,{recursive:true,force:true});}
