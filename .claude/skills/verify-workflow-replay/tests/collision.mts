import { strict as assert } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const source=process.env.WORKFLOW_VERIFY_SOURCE ?? path.resolve('packages/runtime/src/workflow.ts');
const {createWorkflowEngine,defineWorkflow}=await import(pathToFileURL(source).href);
let calls=0;
const wf=defineWorkflow({name:'repeat-engine',async run(ctx: any,args: {id:string}) {return ctx.step('value',()=>{calls++;return args.id;});}});
const firstEngine=createWorkflowEngine();
const first=await firstEngine.start(wf,{id:'first'});
const second=await createWorkflowEngine({store:firstEngine.store}).start(wf,{id:'second'});
assert.notEqual(first.runId,second.runId,'fresh runs across engine restarts need distinct run IDs');
assert.equal(second.result,'second','a new workflow must not reuse an earlier input result');
assert.equal(calls,2);
const raceEngine=createWorkflowEngine();
const rival=createWorkflowEngine({store:raceEngine.store});
const claims=await Promise.allSettled([
  raceEngine.start(wf,{id:'left'},{runId:'shared'}),
  rival.start(wf,{id:'right'},{runId:'shared'}),
]);
assert.equal(claims.filter((claim: PromiseSettledResult<unknown>)=>claim.status==='fulfilled').length,1,'one fresh start may claim an ID');
assert.equal(claims.filter((claim: PromiseSettledResult<unknown>)=>claim.status==='rejected').length,1,'a conflicting fresh start must fail before effects');
assert.equal(calls,3);
console.log('PASS: fresh runs have distinct identities');
