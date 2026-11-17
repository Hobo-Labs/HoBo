import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.env.WORKFLOW_VERIFY_PACKAGE_ROOT ?? path.resolve('packages/runtime');
const config = fileURLToPath(new URL('../models/vitest.config.mts',import.meta.url));
const vitest = path.resolve('node_modules/vitest/vitest.mjs');
const result = spawnSync(process.execPath,[vitest,'run','test/authoring/workflow-replay.property.test.ts','test/authoring/workflow-sleep.test.ts','test/authoring/workflow-step-history.test.ts','test/authoring/workflow-concurrent-append.test.ts','test/authoring/workflow-command-provenance.test.ts','test/authoring/workflow-tree-replay.test.ts','test/authoring/workflow-sleep-completion.test.ts','test/authoring/workflow-command-lifetime.test.ts','--root',root,'--config',config,'--maxWorkers=1','--no-file-parallelism'],{stdio:'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
