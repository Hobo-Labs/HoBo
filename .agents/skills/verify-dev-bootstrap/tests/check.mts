import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.env.HOBO_BOOTSTRAP_VERIFY_ROOT ?? process.cwd();
const tests = ['scripts/test/dev-env-bootstrap.test.ts', 'scripts/test/mise-install-retry.test.ts'].map((file) => path.join(root, file));
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...tests], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
