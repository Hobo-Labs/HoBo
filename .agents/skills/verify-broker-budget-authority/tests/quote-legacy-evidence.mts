import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const model=fileURLToPath(new URL('../models/BrokerQuoteAuthorization.tla',import.meta.url));
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-pricing-legacy-'));
try {
  copyFileSync(model,path.join(scratch,'BrokerQuoteAuthorization.tla'));
  writeFileSync(path.join(scratch,'Legacy.cfg'),'SPECIFICATION Spec\nINVARIANT AllQuoteSafe\n');
  const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Legacy.cfg','BrokerQuoteAuthorization.tla'],{cwd:scratch,encoding:'utf8'});
  if (result.error) throw result.error;
  const output=`${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant AllQuoteSafe is violated')) {
    process.stderr.write(output);
    throw new Error('expected legacy pricing counterexample was not produced');
  }
  process.stdout.write('Expected counterexample: historical raw quote authorization lacks eligibility evidence\n');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
