import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-signature-model-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/ResolutionSignature.tla',import.meta.url)),path.join(scratch,'ResolutionSignature.tla'));
  const names=['RequireTrust','RequireKeyMatch','RequireSignature','RequireDigest','RequireSigningMatch','RequirePublicOnly'];
  for (const [mutation,invariant] of [
    ['RequireTrust','EnrolledSigner'],['RequireKeyMatch','EnrolledSigner'],
    ['RequireSignature','ValidSignature'],['RequireDigest','MatchingDigest'],
    ['RequireSigningMatch','MatchingSigningKeys'],['RequirePublicOnly','PublicKeysOnly'],
  ]) {
    writeFileSync(path.join(scratch,'Mutant.cfg'),`CONSTANTS ${names.map(name=>`${name} = ${name === mutation ? 'FALSE' : 'TRUE'}`).join('\n          ')}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg','ResolutionSignature.tla'],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    const output=`${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output); throw new Error(`expected ${mutation}/${invariant} counterexample`);
    }
    process.stdout.write(`Expected signature counterexample: ${mutation}/${invariant}\n`);
  }
  copyFileSync(fileURLToPath(new URL('../models/ResolutionCanonical.tla',import.meta.url)),path.join(scratch,'ResolutionCanonical.tla'));
  writeFileSync(path.join(scratch,'Mutant.cfg'),'CONSTANT StableOrdering = FALSE\nSPECIFICATION Spec\nINVARIANT SameDocumentVerifies\n');
  const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg','ResolutionCanonical.tla'],{cwd:scratch,encoding:'utf8'});
  const output=`${result.stdout}\n${result.stderr}`;
  if (result.error) throw result.error;
  if (result.status === 0 || !output.includes('Invariant SameDocumentVerifies is violated')) {
    process.stderr.write(output); throw new Error('expected locale-dependent ordering counterexample');
  }
  process.stdout.write('Expected canonicalization counterexample: locale-dependent ordering\n');
} finally { rmSync(scratch,{recursive:true,force:true}); }
