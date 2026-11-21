import { strict as assert } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const source = process.env.WORKFLOW_VERIFY_SOURCE ?? path.resolve('packages/runtime/src/workflow.ts');
const { createWorkflowEngine, defineWorkflow } = await import(pathToFileURL(source).href);
const { WorkflowFailure } = await import(pathToFileURL(path.join(path.dirname(source),'errors.ts')).href);
for (const fail of [false,true]) {
 const engine = createWorkflowEngine();
 let executions = 0;
 const wf = defineWorkflow({name:'terminal-check',async run(ctx: any,input: string) {
  executions++;
  const result = await ctx.step('value',()=>input);
  if (fail) throw new WorkflowFailure('declined',{step:'value'});
  return result;
 }});
 const first = await engine.start(wf,'input',{runId:'terminal'});
 const before = await engine.journal(first.runId);
 const resumed = await createWorkflowEngine({store:engine.store}).resume(wf,first.runId,'input');
 assert.deepEqual(resumed,first);
 assert.equal(executions,1);
 assert.deepEqual(await engine.journal(first.runId),before);
}
console.log('PASS: terminal outcomes return without executing or appending');
