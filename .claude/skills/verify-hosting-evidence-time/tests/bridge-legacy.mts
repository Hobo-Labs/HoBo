import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-bridge-time-legacy-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/BridgeEvidence.tla',import.meta.url)),path.join(scratch,'BridgeEvidence.tla'));
  writeFileSync(path.join(scratch,'Legacy.cfg'),'CONSTANT Current = FALSE\nSPECIFICATION Spec\nINVARIANT NoFuture\n');
  const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Legacy.cfg','BridgeEvidence.tla'],{cwd:scratch,encoding:'utf8'});
  if (result.error) throw result.error;
  const output=`${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant NoFuture is violated')) {
    process.stderr.write(output);
    throw new Error('expected historical bridge counterexample was not produced');
  }
  process.stdout.write('Expected historical bridge counterexample: future entitlement accepted\n');
} finally { rmSync(scratch,{recursive:true,force:true}); }
