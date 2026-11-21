import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.env.CI_RUNNER_CORRELATION_PACKAGE_ROOT ?? path.resolve('packages/ci-gh-actions');
const config = fileURLToPath(new URL('../models/vitest.config.mts', import.meta.url));
const vitest = path.resolve('node_modules/vitest/vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', 'test/runner-correlation-priority.test.ts', 'test/runner-cross-run-safety.test.ts', 'test/runner-pagination-safety.test.ts', 'test/runner-unknown-status-safety.test.ts', '--root', root, '--config', config, '--maxWorkers=1', '--no-file-parallelism'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
