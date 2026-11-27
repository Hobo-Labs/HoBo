import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const model=fileURLToPath(new URL('../models/PricingSourceValues.tla',import.meta.url));
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-pricing-legacy-'));
try {
  copyFileSync(model,path.join(scratch,'PricingSourceValues.tla'));
  writeFileSync(path.join(scratch,'Legacy.cfg'),'CONSTANTS CheckBalance = TRUE\n          CheckCapacity = TRUE\n          CheckCharge = TRUE\n          CheckDerived = TRUE\n          CheckBasis = TRUE\n          CommitmentInCurrency = TRUE\nSPECIFICATION Spec\nINVARIANT AllAmountSafe\n');
  const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Legacy.cfg','PricingSourceValues.tla'],{cwd:scratch,encoding:'utf8'});
  if (result.error) throw result.error;
  const output=`${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant AllAmountSafe is violated')) {
    process.stderr.write(output);
    throw new Error('expected legacy pricing counterexample was not produced');
  }
  process.stdout.write('Expected counterexample: historical pricing can consume negative or excessive source amounts\n');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
