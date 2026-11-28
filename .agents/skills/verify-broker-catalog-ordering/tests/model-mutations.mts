import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const jar=process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-catalog-model-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/CatalogOrdering.tla',import.meta.url)),path.join(scratch,'CatalogOrdering.tla'));
  const names=['CheckPrice','CheckUnit','CheckIdentity','ExactCompare','StableTie'];
  for (const [mutation,invariant] of [
    ['CheckPrice','OnlyValidPrices'],['CheckUnit','ComparableUnits'],['CheckIdentity','UniqueIdentities'],
    ['ExactCompare','MinimumPrice'],['StableTie','DeterministicTie'],
  ]) {
    writeFileSync(path.join(scratch,'Mutant.cfg'),`CONSTANTS ${names.map(name=>`${name} = ${name === mutation ? 'FALSE' : 'TRUE'}`).join('\n          ')}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg','CatalogOrdering.tla'],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    const output=`${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output); throw new Error(`expected ${mutation}/${invariant} counterexample`);
    }
    process.stdout.write(`Expected catalog counterexample: ${mutation}/${invariant}\n`);
  }
  copyFileSync(fileURLToPath(new URL('../models/CatalogSnapshot.tla',import.meta.url)),path.join(scratch,'CatalogSnapshot.tla'));
  writeFileSync(path.join(scratch,'Mutant.cfg'),'CONSTANT CheckSnapshot = FALSE\nSPECIFICATION Spec\nINVARIANT StableSelection\n');
  const result=spawnSync('java',['-XX:+UseParallelGC','-cp',jar,'tlc2.TLC','-workers','1','-config','Mutant.cfg','CatalogSnapshot.tla'],{cwd:scratch,encoding:'utf8'});
  const output=`${result.stdout}\n${result.stderr}`;
  if (result.error) throw result.error;
  if (result.status === 0 || !output.includes('Invariant StableSelection is violated')) {
    process.stderr.write(output); throw new Error('expected changed catalog evidence counterexample');
  }
  process.stdout.write('Expected catalog counterexample: CheckSnapshot/StableSelection\n');

} finally { rmSync(scratch,{recursive:true,force:true}); }
