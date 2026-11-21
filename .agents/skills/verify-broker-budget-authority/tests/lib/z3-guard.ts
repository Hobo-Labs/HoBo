import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const Z3_VERSION = '4.15.4';

interface Z3GuardOptions {
	proofDir: string;
	scratchDir: string;
	install?: (target: string, env: Record<string, string>) => void;
}

function probe(env: Record<string, string>): { status: number | null; version: string } {
	const result = spawnSync('python3', ['-c', 'import z3; print(z3.get_version_string())'], {
		env,
		encoding: 'utf8',
	});
	return { status: result.status, version: (result.stdout ?? '').trim() };
}

export function ensureZ3(
	env: Record<string, string>,
	options: Z3GuardOptions,
): Record<string, string> {
	const target = path.join(options.scratchDir, 'python');
	if (env.BUDGET_Z3_PYTHONPATH) {
		env.PYTHONPATH =
			env.BUDGET_Z3_PYTHONPATH +
			(env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : '');
	}
	const ambient = probe(env);
	if (ambient.status === 0 && ambient.version === Z3_VERSION) return env;

	if (options.install) {
		options.install(target, env);
	} else {
		const install = spawnSync(
			'python3',
			[
				'-m',
				'pip',
				'install',
				'--disable-pip-version-check',
				'--no-cache-dir',
				'--no-deps',
				'--require-hashes',
				'--only-binary=:all:',
				'--target',
				target,
				'-r',
				path.join(options.proofDir, 'requirements-z3.txt'),
			],
			{ env, cwd: options.proofDir, stdio: 'inherit' },
		);
		if (install.error) throw install.error;
		if (install.status !== 0)
			throw new Error(`Z3 installation failed (${install.status ?? 'no exit status'})`);
	}

	env.PYTHONPATH = target;
	env.BUDGET_Z3_PYTHONPATH = target;
	const installed = probe(env);
	if (installed.status !== 0 || installed.version !== Z3_VERSION) {
		throw new Error(
			`expected Z3 ${Z3_VERSION}, got ${installed.version || 'no importable Z3'}`,
		);
	}
	return env;
}
