import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=process.env.BROKER_YARD_FUNDED_VERIFY_PACKAGE_ROOT ?? path.resolve('packages/broker');
const config=fileURLToPath(new URL('../models/vitest.config.mts',import.meta.url));
const vitest=path.resolve('node_modules/vitest/vitest.mjs');
const result=spawnSync(process.execPath,[vitest,'run','test/yard-funded-quote-race.test.ts','test/yard-policy-quote-binding.test.ts','test/hosting-budget.test.ts','test/yard-event-store-folds.test.ts','--root',root,'--config',config,'--maxWorkers=1','--no-file-parallelism'],{stdio:'inherit'});
if(result.error) throw result.error;
if(result.status!==0) process.exit(result.status ?? 1);
