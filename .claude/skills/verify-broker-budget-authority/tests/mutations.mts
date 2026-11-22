import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureZ3 } from './lib/z3-guard.ts';

const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(skillRoot, '../../..');
const proofDir = path.join(skillRoot, 'proof');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-budget-z3-'));
const env: Record<string, string> = { ...process.env } as Record<string, string>;
for (const key of ['BROKER_PROOF_MUTATION', 'BROKER_SCOPE_PROOF_MUTATION']) {
	delete env[key];
}
try {
	ensureZ3(env, { proofDir, scratchDir: scratch });
	for (const name of ['models.py', 'implementation.py', 'proofs.py']) {
		const script = path.join(skillRoot, 'mutations', name);
		const result = spawnSync('python3', [script], { env, stdio: 'inherit', cwd: repoRoot });
		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
