import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS is required');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-saga-authorization-model-'));
const cases = [
  ['CheckInitial', 'InitialAdmissionAuthorized'],
  ['CheckBoundary', 'ProviderCallAuthorized'],
  ['CheckCached', 'CachedResultAuthorized'],
  ['CheckIsolation', 'ProviderPlanIsolated'],
] as const;
try {
  copyFileSync(fileURLToPath(new URL('../models/YardSagaAuthorization.tla', import.meta.url)), path.join(scratch, 'YardSagaAuthorization.tla'));
  for (const [mutation, invariant] of cases) {
    const names = ['CheckInitial', 'CheckBoundary', 'CheckCached', 'CheckIsolation'];
    const constants = names.map(name => `${name} = ${name === mutation ? 'FALSE' : 'TRUE'}`).join('\n');
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANTS ${constants}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'YardSagaAuthorization.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`expected counterexample for ${mutation}/${invariant}`);
    }
    process.stdout.write(`Expected counterexample: ${mutation}/${invariant}\n`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
