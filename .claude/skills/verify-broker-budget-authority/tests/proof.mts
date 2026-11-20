import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(skillRoot, '../../..');
const proofDir = path.join(skillRoot, 'proof');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'hobo-budget-z3-'));
const env: Record<string, string> = { ...process.env } as Record<string, string>;
for (const key of ['BROKER_PROOF_MUTATION', 'BROKER_SCOPE_PROOF_MUTATION']) {
	delete env[key];
}
try {
	const target = path.join(scratch, 'python');
	let probe = spawnSync('python3', ['-c', 'import z3; print(z3.get_version_string())'], {
		env,
		encoding: 'utf8',
	});
	const version = probe.stdout.trim();
	if (probe.status !== 0 || version !== '4.15.4') {
		const install = spawnSync(
			'python3',
			[
				'-m',
				'pip',
				'install',
				'--disable-pip-version-check',
				'--no-cache-dir',
				'--no-deps',
				'--target',
				target,
				'-r',
				path.join(proofDir, 'requirements-z3.txt'),
			],
			{ env, cwd: proofDir, stdio: 'inherit' },
		);
		if (install.error) throw install.error;
		if (install.status !== 0) throw new Error(`Z3 installation failed (${install.status ?? 'no exit status'})`);
		probe = spawnSync('python3', ['-c', 'import z3; print(z3.get_version_string())'], {
			env: { ...env, PYTHONPATH: target },
			encoding: 'utf8',
		});
		if (probe.stdout.trim() !== '4.15.4') throw new Error(`expected Z3 4.15.4, got ${probe.stdout.trim()}`);
		env.PYTHONPATH = target;
	}
	if (env.BUDGET_Z3_PYTHONPATH) {
		env.PYTHONPATH = env.BUDGET_Z3_PYTHONPATH + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : '');
	}
	for (const name of ['broker_induction.py', 'scope_induction.py']) {
		const proof = path.join(proofDir, name);
		const result = spawnSync('python3', [proof], { env, stdio: 'inherit', cwd: repoRoot });
		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}