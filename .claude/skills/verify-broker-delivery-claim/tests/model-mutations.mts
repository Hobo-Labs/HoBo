import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-delivery-model-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/BrokerDelivery.tla',import.meta.url)),path.join(scratch,'BrokerDelivery.tla'));
  for (const [mutation,invariant] of [
    ['CheckOrigin','AuthenticDispatch'],['CheckFreshness','FreshAtDispatch'],
    ['CheckContext','ContextAtDispatch'],['ClaimOnce','AtMostOnce'],
  ]) {
    const names=['CheckOrigin','CheckFreshness','CheckContext','ClaimOnce'];
    writeFileSync(path.join(scratch,'Mutant.cfg'),`CONSTANTS ${names.map(name=>`${name} = ${name === mutation ? 'FALSE' : 'TRUE'}`).join('\n          ')}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg','BrokerDelivery.tla'],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    const output=`${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected ${mutation}/${invariant} counterexample`);
    }
    process.stdout.write(`Expected delivery counterexample: ${mutation}/${invariant}\n`);
  }
  copyFileSync(fileURLToPath(new URL('../models/BrokerResolutionClaim.tla',import.meta.url)),path.join(scratch,'BrokerResolutionClaim.tla'));
  for (const mutation of ['LockRequests','CheckIssued']) {
    writeFileSync(path.join(scratch,'Mutant.cfg'),`CONSTANTS LockRequests = ${mutation === 'LockRequests' ? 'FALSE' : 'TRUE'}\n          CheckIssued = ${mutation === 'CheckIssued' ? 'FALSE' : 'TRUE'}\nSPECIFICATION Spec\nINVARIANT AtMostOneReceipt\n`);
    const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg','BrokerResolutionClaim.tla'],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    const output=`${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes('Invariant AtMostOneReceipt is violated')) {
      process.stderr.write(output); throw new Error(`expected ${mutation}/AtMostOneReceipt counterexample`);
    }
    process.stdout.write(`Expected resolution counterexample: ${mutation}/AtMostOneReceipt\n`);
  }

} finally { rmSync(scratch,{recursive:true,force:true}); }
