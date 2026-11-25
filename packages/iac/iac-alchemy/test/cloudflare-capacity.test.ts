import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
let directory = "";

beforeAll(() => {
	directory = mkdtempSync(join(packageDir, ".cloudflare-test-dist-"));
	const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
	const compiled = spawnSync(
		process.execPath,
		[compiler, "-p", join(packageDir, "tsconfig.json"), "--outDir", directory],
		{ encoding: "utf8", timeout: 30_000 },
	);
	expect(compiled.error).toBeUndefined();
	expect(compiled.status, compiled.stderr).toBe(0);
}, 45_000);

afterAll(() => {
	if (directory !== "") rmSync(directory, { recursive: true, force: true });
});

function run(program: string) {
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", program],
		{
			encoding: "utf8",
			timeout: 15_000,
			env: { ...process.env, NODE_OPTIONS: "" },
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

function moduleUrl(name: string): string {
	return JSON.stringify(pathToFileURL(join(directory, `${name}.js`)).href);
}

it("retains timed-out work until native settlement, then releases capacity", () => {
	const result = run(`
import { createCloudflareDeadline } from ${moduleUrl("cloudflare-native-await")};
import { CLOUDFLARE_NATIVE_MAX_OUTSTANDING as max } from ${moduleUrl("cloudflare-capacity")};
const finish = [], outcomes = [];
for (let i=0; i<max; i++) {
  const promise = new Promise(resolve => finish.push(resolve));
  let began; const started=new Promise(resolve=>{began=resolve;});
  const deadline = createCloudflareDeadline();
  outcomes.push(deadline.run(() => {began(); return promise;}).catch(() => undefined));
  await started;
  deadline.close();
}
await Promise.all(outcomes);
let starts=0;
const blocked = createCloudflareDeadline();
try { await blocked.run(() => { starts++; return Promise.resolve('wrong'); }); } catch {}
blocked.close();
finish[0]('late');
await new Promise(resolve => setImmediate(resolve));
const next = createCloudflareDeadline();
const value = (await next.run(() => { starts++; return Promise.resolve('ok'); })).value;
next.close();
process.stdout.write(JSON.stringify({ max, starts, value }));
`);
	expect(result).toEqual({ max: 128, starts: 1, value: "ok" });
});

it("quarantines unobservable starts and refuses further native calls", () => {
	const result = run(`
import { createCloudflareDeadline } from ${moduleUrl("cloudflare-native-await")};
import { CLOUDFLARE_NATIVE_MAX_OUTSTANDING as max } from ${moduleUrl("cloudflare-capacity")};
let traps=0, starts=0;
for (let i=0; i<max; i++) {
  const deadline=createCloudflareDeadline();
  try { await deadline.run(() => ({ get then() { traps++; throw Error('then'); } })); } catch {}
  deadline.close();
}
const deadline=createCloudflareDeadline();
try { await deadline.run(() => { starts++; return Promise.resolve(); }); } catch {}
deadline.close();
process.stdout.write(JSON.stringify({ starts, traps }));
`);
	expect(result).toEqual({ starts: 0, traps: 0 });
});

it("keeps cancellation capacity until settlement and quarantines failures", () => {
	const result = run(`
import { cancelCloudflareNative, CLOUDFLARE_NATIVE_MAX_OUTSTANDING as max } from ${moduleUrl("cloudflare-capacity")};
const finish=[];
for (let i=0; i<max; i++) cancelCloudflareNative(() => new Promise(resolve => finish.push(resolve)));
let starts=0;
const blocked=cancelCloudflareNative(() => { starts++; return Promise.resolve(); });
finish[0]();
await new Promise(resolve => setImmediate(resolve));
const next=cancelCloudflareNative(() => { starts++; return Promise.reject(Error('cancel failed')); });
await new Promise(resolve => setImmediate(resolve));
const stillBlocked=cancelCloudflareNative(() => { starts++; return Promise.resolve(); });
process.stdout.write(JSON.stringify({ blocked, next, stillBlocked, starts }));
`);
	expect(result).toEqual({
		blocked: "unavailable",
		next: "pending",
		stillBlocked: "unavailable",
		starts: 1,
	});
});

it("closes deadlines and uses the captured timer despite replacement", () => {
	const result = run(`
import { createCloudflareDeadline } from ${moduleUrl("cloudflare-native-await")};
const original=globalThis.setTimeout;
let traps=0, starts=0, afterClose=false;
globalThis.setTimeout=()=>{ traps++; throw Error('replaced timer'); };
try {
  const live=createCloudflareDeadline();
  const value=(await live.run(()=>Promise.resolve('ok'))).value;
  live.close();
  try { await live.run(()=>{ starts++; return Promise.resolve(); }); } catch { afterClose=true; }
  process.stdout.write(JSON.stringify({ value, traps, starts, afterClose }));
} finally { globalThis.setTimeout=original; }
`);
	expect(result).toEqual({
		value: "ok",
		traps: 0,
		starts: 0,
		afterClose: true,
	});
});

it("expires once when synchronous work outlasts the monotonic deadline", () => {
	const result = run(`
let time=0, aborts=0, retired=0;
Object.defineProperty(performance, 'now', { configurable: true, value: () => time });
const { awaitCloudflareNative, isCloudflareNativeTimeout } = await import(${moduleUrl("cloudflare-native-await")});
let timedOut=false;
try { await awaitCloudflareNative(() => { time=10001; return Promise.resolve('late'); }, () => aborts++, () => { retired++; return 'none'; }); }
catch (error) { timedOut=isCloudflareNativeTimeout(error); }
await new Promise(resolve => setImmediate(resolve));
process.stdout.write(JSON.stringify({ timedOut, aborts, retired }));
`);
	expect(result).toEqual({ timedOut: true, aborts: 1, retired: 1 });
});

it("rechecks expiry between native arrival and the caller continuation", () => {
	const result = run(`
let time=0, aborts=0, retired=0, finish, began;
Object.defineProperty(performance, 'now', { configurable: true, value: () => time });
const { awaitCloudflareNative, isCloudflareNativeTimeout } = await import(${moduleUrl("cloudflare-native-await")});
const native=new Promise(resolve => { finish=resolve; });
const started=new Promise(resolve=>{began=resolve;});
const work=awaitCloudflareNative(() => {began();return native;}, () => aborts++, () => { retired++; return 'none'; });
await started;
finish('arrived');
queueMicrotask(() => { time=10001; });
let timedOut=false;
try { await work; } catch (error) { timedOut=isCloudflareNativeTimeout(error); }
process.stdout.write(JSON.stringify({ timedOut, aborts, retired }));
`);
	expect(result).toEqual({ timedOut: true, aborts: 1, retired: 1 });
});

it("keeps byte-view bounds when a stream changes numeric intrinsics", () => {
	const result = run(`
import { readCloudflareByteStream } from ${moduleUrl("cloudflare-byte-stream")};
let pulls=0, second=0, traps=0;
const originalMin=Math.min, originalSafe=Number.isSafeInteger;
const stream=new ReadableStream({
  type:'bytes',
  pull(controller) {
    pulls++;
    const view=controller.byobRequest.view;
    if (pulls===1) {
      view[0]=7;
      Math.min=()=>{ traps++; return 2_000_000; };
      Number.isSafeInteger=()=>{ traps++; return true; };
      controller.byobRequest.respond(1);
    } else {
      second=view.byteLength;
      controller.close();
      controller.byobRequest.respond(0);
    }
  }
});
let bytes;
try { bytes=new Uint8Array(await readCloudflareByteStream(stream,1,false,kind=>Error(kind))); }
finally { Math.min=originalMin; Number.isSafeInteger=originalSafe; }
process.stdout.write(JSON.stringify({ pulls, second, traps, bytes:[...bytes] }));
`);
	expect(result).toEqual({ pulls: 2, second: 1, traps: 0, bytes: [7] });
});

it("does not lose bytes to inherited numeric setters", () => {
	const result = run(`
import { readCloudflareByteStream } from ${moduleUrl("cloudflare-byte-stream")};
const stream=new ReadableStream({ type:'bytes', start(c) { c.enqueue(new Uint8Array([7])); c.close(); } });
let traps=0;
const work=readCloudflareByteStream(stream,10,false,kind=>Error(kind));
Object.defineProperty(Array.prototype, '0', { configurable:true, set(value) {
  traps++;
  Object.defineProperty(this, '0', { value, writable:true, configurable:true, enumerable:true });
} });
let bytes;
try { bytes=new Uint8Array(await work); }
finally { delete Array.prototype[0]; }
process.stdout.write(JSON.stringify({ bytes:[...bytes], traps }));
`);
	expect(result).toEqual({ bytes: [7], traps: 0 });
});

it("quarantines a stream if releasing its genuine reader fails", () => {
	const result = run(`
const nativeRelease=ReadableStreamBYOBReader.prototype.releaseLock;
ReadableStreamBYOBReader.prototype.releaseLock=function() { throw Error('release failed'); };
const { readCloudflareByteStream } = await import(${moduleUrl("cloudflare-byte-stream")});
const { reserveCloudflareNative, CLOUDFLARE_NATIVE_MAX_OUTSTANDING: max } = await import(${moduleUrl("cloudflare-capacity")});
const stream=new ReadableStream({ type:'bytes', start(c) { c.enqueue(new Uint8Array([7])); c.close(); } });
let rejected=false;
try { await readCloudflareByteStream(stream,10,false,kind=>Error(kind)); } catch { rejected=true; }
await new Promise(resolve=>setImmediate(resolve));
let available=0;
for (let i=0; i<max; i++) { if (reserveCloudflareNative() !== undefined) available++; }
ReadableStreamBYOBReader.prototype.releaseLock=nativeRelease;
process.stdout.write(JSON.stringify({ rejected, available, max }));
`);
	expect(result).toEqual({ rejected: true, available: 127, max: 128 });
});

it("expires and aborts when a late start throws, is unobservable, or rejects", () => {
	const result = run(`
let time=0, aborts=0;
Object.defineProperty(performance, 'now', { configurable:true, value:()=>time });
const { awaitCloudflareNative, isCloudflareNativeTimeout }=await import(${moduleUrl("cloudflare-native-await")});
const outcomes=[];
for (const mode of ['throw','unobservable','reject']) {
  time=0;
  try {
    await awaitCloudflareNative(() => {
      time=10001;
      if (mode==='throw') throw Error('start failed');
      if (mode==='unobservable') return {};
      return Promise.reject(Error('native failed'));
    }, () => aborts++);
    outcomes.push(false);
  } catch (error) { outcomes.push(isCloudflareNativeTimeout(error)); }
}
await new Promise(resolve=>setImmediate(resolve));
process.stdout.write(JSON.stringify({ aborts, outcomes }));
`);
	expect(result).toEqual({ aborts: 3, outcomes: [true, true, true] });
});

it("transfers every saturated late operation to its cleanup", () => {
	const result = run(`
import { createCloudflareDeadline } from ${moduleUrl("cloudflare-native-await")};
import { cancelCloudflareNative, CLOUDFLARE_NATIVE_MAX_OUTSTANDING as max } from ${moduleUrl("cloudflare-capacity")};
const finish=[], cleanup=[], outcomes=[];
let cleanups=0, starts=0;
for (let i=0; i<max; i++) {
  const native=new Promise(resolve=>finish.push(resolve));
  let began; const started=new Promise(resolve=>{began=resolve;});
  const deadline=createCloudflareDeadline();
  outcomes.push(deadline.run(() => {began();return native;}, (_value, release) =>
    cancelCloudflareNative(() => { cleanups++; return new Promise(resolve=>cleanup.push(resolve)); }, release)
  ).catch(()=>undefined));
  await started;
  deadline.close();
}
await Promise.all(outcomes);
for (const resolve of finish) resolve('late body');
await new Promise(resolve=>setImmediate(resolve));
const blocked=createCloudflareDeadline();
try { await blocked.run(()=>{ starts++; return Promise.resolve(); }); } catch {}
blocked.close();
for (const resolve of cleanup) resolve();
await new Promise(resolve=>setImmediate(resolve));
const next=createCloudflareDeadline();
const value=(await next.run(()=>{ starts++; return Promise.resolve('ok'); })).value;
next.close();
process.stdout.write(JSON.stringify({ max, cleanups, starts, value }));
`);
	expect(result).toEqual({ max: 128, cleanups: 128, starts: 1, value: "ok" });
});

it("rejects invalid byte limits before opening a stream", () => {
	const result = run(`
import { readCloudflareByteStream } from ${moduleUrl("cloudflare-byte-stream")};
let pulls=0, rejected=0;
for (const limit of [-1, 1.5, 1048577, NaN]) {
  const stream=new ReadableStream({ type:'bytes', pull() { pulls++; } });
  try { await readCloudflareByteStream(stream,limit,false,kind=>Error(kind)); }
  catch { rejected++; }
}
process.stdout.write(JSON.stringify({ pulls, rejected }));
`);
	expect(result).toEqual({ pulls: 0, rejected: 4 });
});

it("retains bound service lookup when application code replaces Array methods", () => {
	const result = run(`
import { bindleCloudflareWorker, cloudflareBindings } from ${moduleUrl("cloudflare-runtime")};
const originalFind=Array.prototype.find, originalIncludes=Array.prototype.includes;
let traps=0;
const response=new Response('ok');
const serviceRequest=new Request('https://service.test/');
const appRequest=new Request('https://app.test/');
const entrypoint=context=>()=>{
  Array.prototype.find=()=>{traps++; throw Error('find');};
  Array.prototype.includes=()=>{traps++; throw Error('includes');};
  try { return cloudflareBindings(context).service('catalog').fetch(serviceRequest); }
  finally { Array.prototype.find=originalFind; Array.prototype.includes=originalIncludes; }
};
const web={ kind:'web', name:'web', stableId:'web:web', declaredAllow:[], dependsOn:['service'], annotations:[] };
const service={ kind:'service', name:'catalog', stableId:'service:catalog', declaredAllow:[], dependsOn:[], annotations:[] };
const app={name:'shop',resources:{web,catalog:service},edges:[{from:'web',to:'catalog'}],requirements:{},entrypoint:()=>entrypoint};
const worker=bindleCloudflareWorker(app,'web');
const result=await worker.fetch(appRequest,{ HOBO_RESOURCE_0:{ fetch:()=>Promise.resolve(response) } });
process.stdout.write(JSON.stringify({ same:result===response, traps }));
`);
	expect(result).toEqual({ same: true, traps: 0 });
});

it("classifies adapter timeouts without consulting mutable instanceof hooks", () => {
	const result = run(`
const timer=globalThis.setTimeout;
globalThis.setTimeout=callback=>{ callback(); return 0; };
const { createCloudflareDeadline }=await import(${moduleUrl("cloudflare-native-await")});
const { readCloudflareByteStream }=await import(${moduleUrl("cloudflare-byte-stream")});
let first;
const deadline=createCloudflareDeadline();
try { await deadline.run(()=>Promise.resolve()); } catch (error) { first=error; }
deadline.close();
let traps=0;
Object.defineProperty(first.constructor,Symbol.hasInstance,{ configurable:true, value(){ traps++; throw Error('hasInstance'); } });
const stream=new ReadableStream({type:'bytes',pull(){}});
let message='';
try { await readCloudflareByteStream(stream,10,false,kind=>Error(kind)); }
catch(error) { message=error.message; }
globalThis.setTimeout=timer;
process.stdout.write(JSON.stringify({ message, traps }));
`);
	expect(result).toEqual({ message: "timeout", traps: 0 });
});

it("allows each lease to transfer to only one cancellation", () => {
	const result = run(`
import { reserveCloudflareNative, cancelCloudflareNative } from ${moduleUrl("cloudflare-capacity")};
const lease=reserveCloudflareNative();
let starts=0, finish;
const first=cancelCloudflareNative(()=>{ starts++; return new Promise(resolve=>{finish=resolve;}); },lease);
const second=cancelCloudflareNative(()=>{ starts++; return Promise.resolve(); },lease);
finish();
await new Promise(resolve=>setImmediate(resolve));
const third=cancelCloudflareNative(()=>{ starts++; return Promise.resolve(); },lease);
process.stdout.write(JSON.stringify({ first, second, third, starts }));
`);
	expect(result).toEqual({
		first: "pending",
		second: "unavailable",
		third: "unavailable",
		starts: 1,
	});
});

it("quarantines a transferred lease when late retirement throws", () => {
	const result = run(`
import { createCloudflareDeadline, isCloudflareNativeTimeout } from ${moduleUrl("cloudflare-native-await")};
import { cancelCloudflareNative, reserveCloudflareNative, CLOUDFLARE_NATIVE_MAX_OUTSTANDING as max } from ${moduleUrl("cloudflare-capacity")};
let finish, began, cleanup=0;
const native=new Promise(resolve=>{finish=resolve;});
const started=new Promise(resolve=>{began=resolve;});
const deadline=createCloudflareDeadline();
const outcome=deadline.run(()=>{began();return native;},(_value,lease)=>{
  cancelCloudflareNative(()=>{cleanup++;return Promise.resolve();},lease);
  throw Error('retirement failed');
}).catch(error=>isCloudflareNativeTimeout(error));
await started;
deadline.close();
const timedOut=await outcome;
finish('late');
await new Promise(resolve=>setImmediate(resolve));
let available=0;
for(let i=0;i<max;i++) if(reserveCloudflareNative()!==undefined) available++;
process.stdout.write(JSON.stringify({ timedOut, cleanup, available, max }));
`);
	expect(result).toEqual({
		timedOut: true,
		cleanup: 1,
		available: 127,
		max: 128,
	});
});

it("quarantines synchronous throws and unobservable native starts", () => {
	const result = run(`
import { createCloudflareDeadline } from ${moduleUrl("cloudflare-native-await")};
import { CLOUDFLARE_NATIVE_MAX_OUTSTANDING as max } from ${moduleUrl("cloudflare-capacity")};
let starts=0, traps=0;
for(let i=0;i<max;i++){
  const deadline=createCloudflareDeadline();
  try { await deadline.run(()=>{starts++; if(i%2===0) throw Error('start'); return {get then(){traps++;return undefined;}};}); } catch {}
  deadline.close();
}
const deadline=createCloudflareDeadline();
try { await deadline.run(()=>{starts++;return Promise.resolve();}); } catch {}
deadline.close();
process.stdout.write(JSON.stringify({starts,traps,max}));
`);
	expect(result).toEqual({ starts: 128, traps: 0, max: 128 });
});

it("classifies a fourth-microtask expiry before the exposed Promise settles", () => {
	const result = run(`
import { createHook } from 'node:async_hooks';
let time=0,ticks=0,aborts=0,retired=0;
Object.defineProperty(performance,'now',{configurable:true,value:()=>time});
const { awaitCloudflareNative, isCloudflareNativeTimeout }=await import(${moduleUrl("cloudflare-native-await")});
const ids=new WeakMap(); let target,settledAt=-1;
const hook=createHook({
  init(id,type,_trigger,resource){if(type==='PROMISE')ids.set(resource,id);},
  promiseResolve(id){if(id===target)settledAt=time;}
});
hook.enable();
const work=awaitCloudflareNative(()=>Promise.resolve('value'),()=>aborts++,()=>{retired++;return 'none';});
target=ids.get(work);
function tick(){ticks++;if(ticks===4)time=10001;else queueMicrotask(tick);}
queueMicrotask(tick);
let timedOut=false;
try { await work; } catch (error) { timedOut=isCloudflareNativeTimeout(error); }
const consumerTime=time;
hook.disable();
process.stdout.write(JSON.stringify({settledAt,consumerTime,timedOut,aborts,retired}));
`);
	expect(result).toEqual({
		settledAt: 10001,
		consumerTime: 10001,
		timedOut: true,
		aborts: 1,
		retired: 1,
	});
});

it("observes its result before a native start can replace Promise intrinsics", () => {
	const result = run(`
import { awaitCloudflareNative } from ${moduleUrl("cloudflare-native-await")};
const original=Object.getOwnPropertyDescriptor(Promise.prototype,'constructor');
let unhandled=0,traps=0,caught=false;
process.on('unhandledRejection',()=>{unhandled++;});
const pending=awaitCloudflareNative(()=>{
  Object.defineProperty(Promise.prototype,'constructor',{configurable:true,get(){traps++;throw Error('constructor');}});
  return Promise.resolve('ok');
});
setImmediate(()=>{
  Object.defineProperty(Promise.prototype,'constructor',original);
  pending.catch(()=>{caught=true;});
  setImmediate(()=>process.stdout.write(JSON.stringify({unhandled,traps,caught})));
});
`);
	expect(result).toEqual({ unhandled: 0, traps: 0, caught: true });
});

it("lets direct deadline callers attach observation before native work starts", () => {
	const result = run(`
import { createCloudflareDeadline } from ${moduleUrl("cloudflare-native-await")};
const original=Object.getOwnPropertyDescriptor(Promise.prototype,'constructor');
const nativeThen=Promise.prototype.then;
let unhandled=0,traps=0,caught=false;
process.on('unhandledRejection',()=>{unhandled++;});
const deadline=createCloudflareDeadline();
const pending=deadline.run(()=>{
  Object.defineProperty(Promise.prototype,'constructor',{configurable:true,get(){traps++;throw Error('constructor');}});
  return Promise.resolve('ok');
});
Reflect.apply(nativeThen,pending,[undefined,()=>{caught=true;}]);
setImmediate(()=>{
  Object.defineProperty(Promise.prototype,'constructor',original);
  deadline.close();
  setImmediate(()=>process.stdout.write(JSON.stringify({unhandled,traps,caught})));
});
`);
	expect(result).toEqual({ unhandled: 0, traps: 0, caught: true });
});
