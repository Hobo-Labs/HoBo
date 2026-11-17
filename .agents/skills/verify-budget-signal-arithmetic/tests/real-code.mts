import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const build=spawnSync('pnpm',['exec','turbo','run','build','--filter=@hobo/ci','--concurrency=2'],{stdio:'inherit'});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const config=fileURLToPath(new URL('../models/vitest.config.mts',import.meta.url));
const vitest=path.resolve('node_modules/vitest/vitest.mjs');
const targets=[
  [process.env.BUDGET_ARITHMETIC_BROKER_ROOT ?? path.resolve('packages/broker'),'test/budget-signal-arithmetic.test.ts'],
  [process.env.BUDGET_ARITHMETIC_CI_ROOT ?? path.resolve('packages/ci'),'test/budget-signal-policy.test.ts'],
];
let failed=false;
for (const [root,test] of targets) {
  const result=spawnSync(process.execPath,[vitest,'run',test,'--root',root,'--config',config,'--maxWorkers=1','--no-file-parallelism'],{stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) failed=true;
}
if (failed) process.exit(1);
