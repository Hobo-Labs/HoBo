import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['--import','tsx','packages/schema-tools/src/cli.ts','--check','--filter','packages/broker'],{stdio:'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
