import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if(!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-local-work-mutable-source-'));
try {
 copyFileSync(fileURLToPath(new URL('../models/LocalWorkBinding.tla',import.meta.url)),path.join(scratch,'LocalWorkBinding.tla'));
 writeFileSync(path.join(scratch,'MutableSource.cfg'),`CONSTANTS CheckSnapshot = TRUE\n          CheckMaterialize = TRUE\n          BindSnapshot = TRUE\n          BindDigest = TRUE\n          CheckAfterApproval = TRUE\n          CheckBeforeStart = TRUE\n          CheckWorker = TRUE\n          ExecuteSnapshot = FALSE\nSPECIFICATION Spec\nINVARIANT ActualWorkMatches\n`);
 const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','MutableSource.cfg','LocalWorkBinding.tla'],{cwd:scratch,encoding:'utf8'});
 if(result.error) throw result.error;
 const output=`${result.stdout}\n${result.stderr}`;
 if(result.status === 0 || !output.includes('Invariant ActualWorkMatches is violated')){process.stderr.write(output);throw new Error('expected mutable-source counterexample missing');}
 process.stdout.write('Expected counterexample: executing the mutable source can start work different from the approved copy.\n');
} finally {rmSync(scratch,{recursive:true,force:true});}
