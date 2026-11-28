import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const model=fileURLToPath(new URL('../models/PricingEligibility.tla',import.meta.url));
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-pricing-legacy-'));
try {
  copyFileSync(model,path.join(scratch,'PricingEligibility.tla'));
  writeFileSync(path.join(scratch,'Legacy.cfg'),'CONSTANTS CheckCompleteness = TRUE\n          PartialIneligible = TRUE\n          RequireEligible = TRUE\nSPECIFICATION Spec\nINVARIANT AllSelectionSafe\n');
  const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Legacy.cfg','PricingEligibility.tla'],{cwd:scratch,encoding:'utf8'});
  if (result.error) throw result.error;
  const output=`${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant AllSelectionSafe is violated')) {
    process.stderr.write(output);
    throw new Error('expected legacy pricing counterexample was not produced');
  }
  process.stdout.write('Expected counterexample: historical partial state or missing eligibility can be selected\n');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
