import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const vitest=path.resolve('node_modules/vitest/vitest.mjs');
const config=fileURLToPath(new URL('../models/vitest.config.mts',import.meta.url));
const bindles=process.env.BINDLE_RUNTIME_VERIFY_PACKAGE_ROOT ?? path.resolve('packages/bindles');
function run(args){
 const result=spawnSync(process.execPath,[vitest,'run',...args,'--config',config,'--maxWorkers=1','--no-file-parallelism'],{stdio:'inherit'});
 if(result.error) throw result.error;
 if(result.status !== 0) process.exit(result.status ?? 1);
}
run(['test/bindle.test.ts','test/requirements.test.ts','--root',bindles]);
const build=spawnSync('pnpm',['exec','turbo','run','build','--filter=@hobo/bindles','--concurrency=2'],{stdio:'inherit'});
if(build.error) throw build.error;
if(build.status !== 0) process.exit(build.status ?? 1);
run(['test/declared-runtime-binding.test.ts','--root',path.resolve('packages/hobo'),'-t','infers actual resource runtimes']);
