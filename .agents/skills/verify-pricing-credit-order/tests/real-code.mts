import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=process.env.PRICING_VERIFY_PACKAGE_ROOT ?? path.resolve('packages/pricing');
const config=fileURLToPath(new URL('../models/vitest.config.mts',import.meta.url));
const vitest=path.resolve('node_modules/vitest/vitest.mjs');
const result=spawnSync(process.execPath,[vitest,'run','test/pricing-locale.test.ts','test/pricing-source-identity.test.ts','test/golden-replay.test.ts','test/adversarial-10.test.ts','contracts/consumer/quote-boundary.test.ts','--root',root,'--config',config,'--maxWorkers=1','--no-file-parallelism'],{stdio:'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
