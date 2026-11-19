import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(skillRoot, '../../..');
const root =
	process.env.BROKER_BUDGET_VERIFY_PACKAGE_ROOT ?? path.join(repoRoot, 'packages/broker');
const config = fileURLToPath(new URL('../models/vitest.config.mts', import.meta.url));
const vitest = path.join(repoRoot, 'node_modules/vitest/vitest.mjs');
const result = spawnSync(
	process.execPath,
	[
		vitest,
		'run',
		'test/budget-authority.property.test.ts',
		'test/budget-admission-denial.test.ts',
		'--root',
		root,
		'--config',
		config,
		'--maxWorkers=1',
		'--no-file-parallelism',
	],
	{ stdio: 'inherit', cwd: repoRoot },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);