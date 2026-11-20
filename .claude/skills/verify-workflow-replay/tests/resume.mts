import {strict as assert} from 'node:assert';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const source=process.env.WORKFLOW_VERIFY_SOURCE ?? path.resolve('packages/runtime/src/workflow.ts');
const {createWorkflowEngine,defineWorkflow}=await import(pathToFileURL(source).href);
let calls=0, crash=true;
const wf=defineWorkflow({name:'resume-check',async run(ctx: any,args: {id:string}) {
 await ctx.step('once',()=>{calls++;return args.id;});
 if (crash) {crash=false;throw new Error('host crash');}
 return ctx.seed;
}});
const engine=createWorkflowEngine({seed:'original-seed'});
await assert.rejects(engine.resume(wf,'missing',{id:'one'}),/run.Started/);
assert.equal(calls,0);
await assert.rejects(engine.start(wf,{id:'one'},{runId:'known'}),/host crash/);
const restarted=createWorkflowEngine({store:engine.store,seed:'other-seed'});
await assert.rejects(restarted.resume(wf,'known',{id:'other'}),/input/);
await assert.rejects(restarted.resume(defineWorkflow({name:'wrong',run:wf.run}),'known',{id:'one'}),/workflow/);
assert.equal((await restarted.resume(wf,'known',{id:'one'})).result,'original-seed');
assert.equal(calls,1);
console.log('PASS: resume requires the saved run and input and preserves its seed');
