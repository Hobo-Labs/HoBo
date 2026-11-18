import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const vitest = path.resolve('node_modules/vitest/vitest.mjs');
const checks = [
  [process.env.BUILD_EPOCH_COMPONENT_ROOT ?? path.resolve('packages/componentize'), 'test/source-date-epoch.test.ts', '../models/component-vitest.config.mts'],
  [process.env.BUILD_EPOCH_CLI_ROOT ?? path.resolve('packages/cli'), 'test/container-build.test.ts', '../models/cli-vitest.config.mts'],
];
for (const [root, test, config] of checks) {
  const result = spawnSync(process.execPath, [vitest, 'run', test, '--root', root, '--config', fileURLToPath(new URL(config, import.meta.url)), '--maxWorkers=1', '--no-file-parallelism'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
