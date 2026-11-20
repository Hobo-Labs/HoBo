import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-connection-model-'));
try {
  copyFileSync(fileURLToPath(new URL('../models/ConnectionAlias.tla', import.meta.url)), path.join(scratch, 'ConnectionAlias.tla'));
  for (const [broken, invariant] of [['GuardAlias','NoAliasRebind'], ['GuardAliasId','NamesUnambiguous'], ['GuardId','NamesUnambiguous']]) {
    const flags = ['GuardAlias','GuardAliasId','GuardId'].map((name) => `${name} = ${name === broken ? 'FALSE' : 'TRUE'}`).join('\n          ');
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS ${flags}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'ConnectionAlias.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) throw new Error(`${broken}: expected ${invariant} counterexample\n${output}`);
    console.log(`Expected counterexample: ${broken}/${invariant}`);
  }
  const source = readFileSync(fileURLToPath(new URL('../models/Connection.tla', import.meta.url)), 'utf8');
  const before = 'Authorize == /\\ phase \\in {"pending", "active", "needs-reauth"}';
  if (source.split(before).length !== 2) throw new Error('authorization mutation site is not unique');
  writeFileSync(path.join(scratch, 'Connection.tla'), source.replace(before, 'Authorize == /\\ phase \\in {"pending", "active", "needs-reauth", "revoked"}'));
  writeFileSync(path.join(scratch, 'Mutant.cfg'), 'SPECIFICATION Spec\nINVARIANT RevokedRemainsRevoked\nCHECK_DEADLOCK FALSE\n');
  const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'Connection.tla'], { cwd: scratch, encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('Invariant RevokedRemainsRevoked is violated')) throw new Error(`expected revoked transition counterexample\n${output}`);
  console.log('Expected counterexample: reauthorize/RevokedRemainsRevoked');
} finally { rmSync(scratch, { recursive: true, force: true }); }
