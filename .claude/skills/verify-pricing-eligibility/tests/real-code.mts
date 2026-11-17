import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const pricing=process.env.PRICING_ELIGIBILITY_PRICING_ROOT ?? path.resolve('packages/pricing');
const dispatcher=process.env.PRICING_ELIGIBILITY_DISPATCHER_ROOT ?? path.resolve('packages/dispatcher');
const config=fileURLToPath(new URL('../models/vitest.config.mts',import.meta.url));
const vitest=path.resolve('node_modules/vitest/vitest.mjs');
let failed=false;
for (const [root, files] of [
  [pricing,['test/pricing-partial-eligibility.test.ts','test/section-13-coverage.test.ts','test/golden-replay.test.ts','contracts/consumer/quote-boundary.test.ts']],
  [dispatcher,['test/dispatcher-v2-eligibility.test.ts','test/dispatcher-v2.test.ts']]
]) {
  const result=spawnSync(process.execPath,[vitest,'run',...files,'--root',root,'--config',config,'--maxWorkers=1','--no-file-parallelism'],{stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) failed=true;
}
if (failed) process.exit(1);
