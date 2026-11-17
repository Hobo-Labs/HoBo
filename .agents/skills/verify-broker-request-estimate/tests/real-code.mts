import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const vitest=path.resolve('node_modules/vitest/vitest.mjs');
const config=fileURLToPath(new URL('../models/vitest.config.mts',import.meta.url));
const cases=[
  [process.env.BROKER_REQUEST_VERIFY_PACKAGE_ROOT ?? path.resolve('packages/broker'),'test/request-estimate-presence.test.ts'],
  [process.env.BROKER_REQUEST_VERIFY_PACKAGE_ROOT ?? path.resolve('packages/broker'),'test/local-host.test.ts'],
  [process.env.HOBO_REQUEST_VERIFY_PACKAGE_ROOT ?? path.resolve('packages/hobo'),'test/broker-command.test.ts'],
];
for (const [root,test] of cases) {
  const result=spawnSync(process.execPath,[vitest,'run',test,'--root',root,'--config',config,'--maxWorkers=1','--no-file-parallelism'],{stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode=result.status ?? 1;
}
