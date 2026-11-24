import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve('packages/ci');
const vitest=path.resolve('node_modules/vitest/vitest.mjs');
const result=spawnSync(process.execPath,[vitest,'run','test/fleet-v2-store-conformance.test.ts','--root',root,'--maxWorkers=1','--no-file-parallelism'],{stdio:'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
