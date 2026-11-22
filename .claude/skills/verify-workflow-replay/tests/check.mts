import { strict as assert } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const source = process.env.WORKFLOW_VERIFY_SOURCE ?? path.resolve('packages/runtime/src/workflow.ts');
const {createWorkflowEngine, defineWorkflow} = await import(pathToFileURL(source).href);
let calls = 0;
let crash = true;
const workflow = defineWorkflow({
  name: 'journal-replay-check',
  async run(ctx: {step: (name: string, f: () => unknown) => Promise<unknown>}) {
    await ctx.step('once-recorded', () => { calls++; return 'saved'; });
    if (crash) { crash = false; throw new Error('simulated-host-crash'); }
    return 'done';
  },
});
const first = createWorkflowEngine();
await assert.rejects(first.start(workflow, {}, {runId:'run-1'}), /simulated-host-crash/);
assert.equal(calls, 1, 'the first invocation ran exactly once');
const result = await createWorkflowEngine({store: first.store}).resume(workflow, 'run-1', {});
assert.equal(result.status, 'completed');
assert.equal(calls, 1, 'a durably journaled step must not run again on resume');
console.log('PASS: journaled workflow step is reused after a crash');
