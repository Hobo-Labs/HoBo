import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve('packages/ci-gh-actions');
const vitest=path.resolve('node_modules/vitest/vitest.mjs');
const config=fileURLToPath(new URL('../models/hook-vitest.config.mts',import.meta.url));
const result=spawnSync(process.execPath,[vitest,'run','test/fleet-start-hook-receipt.test.ts','--root',root,'--config',config,'--maxWorkers=1','--no-file-parallelism'],{stdio:'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
