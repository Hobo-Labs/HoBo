import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS;
if (!jar) throw new Error('TLA2TOOLS must point to the checked TLC jar');
const source = readFileSync(fileURLToPath(new URL('../models/BudgetRouting.tla', import.meta.url)), 'utf8');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-budget-model-mutant-'));
const cases = [
  ['running-evidence', '/\\ reservation[c] = "pending" \\/ finalEvidence[c]', '/\\ TRUE', 'RunningSettlementNeedsEvidence'],
  ['admission-fence', '/\\ snapSeq[c] = seq /\\ held + spent + 1 <= Cap', '/\\ TRUE', 'NoUnfundedAdmission'],
  ['overrun-marker', "overrunSeen' = (overrunSeen \\/ actual > 1)", "overrunSeen' = overrunSeen", 'BudgetSafeUntilProviderOverrun'],
];
try {
  for (const [name, before, after, invariant] of cases) {
    if (source.split(before).length !== 2) throw new Error(`${name}: mutation site is not unique`);
    writeFileSync(path.join(scratch, 'BudgetRouting.tla'), source.replace(before, after));
    writeFileSync(path.join(scratch, 'Mutant.cfg'), `CONSTANT Clients = {"a", "b"}\nSPECIFICATION Spec\nINVARIANT ${invariant}\n`);
    const result = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'Mutant.cfg', 'BudgetRouting.tla'], { cwd: scratch, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
      process.stderr.write(output);
      throw new Error(`${name}: expected ${invariant} counterexample`);
    }
    console.log(`Expected counterexample: ${name}/${invariant}`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
