import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const build = spawnSync('pnpm', ['--filter', '@hobo/core', 'run', 'build'], { stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const root = process.env.BROKER_RESIDENCY_VERIFY_PACKAGE_ROOT ?? path.resolve('packages/broker');
const config = fileURLToPath(new URL('../models/vitest.config.mts', import.meta.url));
const vitest = path.resolve('node_modules/vitest/vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', 'test/yard-residency-validation.test.ts', 'test/yard-placement.test.ts', 'test/yard-matching.test.ts', '--root', root, '--config', config, '--maxWorkers=1', '--no-file-parallelism'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
