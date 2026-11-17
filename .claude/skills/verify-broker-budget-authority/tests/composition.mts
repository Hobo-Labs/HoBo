import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const config = fileURLToPath(new URL('../models/vitest.config.mts', import.meta.url));
const vitest = path.resolve('node_modules/vitest/vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', 'test/hosting-budget-authority.test.ts', '--root', path.resolve('packages/hobo'), '--config', config, '--maxWorkers=1', '--no-file-parallelism'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
