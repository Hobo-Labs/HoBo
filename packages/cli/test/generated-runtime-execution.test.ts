import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromJson, toJson } from "@bufbuild/protobuf";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { GeneratedResourceSnapshotSchema } from "../src/_generated/project_codegen_pb.js";
import { writeFixtureProject } from "../src/codegen/fixture.js";
import { runCodegen } from "../src/codegen/run-codegen.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

describe("generated executable API on the existing durable runtime", () => {
	it("compiles, persists resources, delivers subscriptions, dispatches handlers and resumes workflows after reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-generated-execution-"));
		try {
			await writeFixtureProject(root);
			const resourceFile = join(root, ".hobo/sources/zod/resources.json");
			const resourceMetadata = JSON.parse(await readFile(resourceFile, "utf8"));
			resourceMetadata.resources.ticket.fields.details = {
				type: "object",
				fields: {
					tags: { type: "array", items: { type: "string" } },
					active: { type: "boolean" },
				},
			};
			await writeFile(resourceFile, JSON.stringify(resourceMetadata));
			const bindleFile = join(root, "hobo.bindle.json");
			const bindleMetadata = JSON.parse(await readFile(bindleFile, "utf8"));
			bindleMetadata.bindles[0].workflows.push("a/b", "a");
			bindleMetadata.bindles[0].steps = [
				"ticket.validate",
				"ticket.enrich",
				"ticket.invalid",
			];
			await writeFile(bindleFile, JSON.stringify(bindleMetadata));
			const written = await runCodegen({ projectRoot: root, check: false });
			await expect(
				runCodegen({ projectRoot: root, check: true }),
			).resolves.toMatchObject({ mode: "check" });
			await writeFile(join(root, "package.json"), '{"type":"module"}');
			await mkdir(join(root, "node_modules/@hobo"), { recursive: true });
			for (const [name, path] of [
				["core", "packages/core"],
				["runtime", "packages/runtime"],
				["runtime-local", "packages/runtimes/runtime-local"],
			]) {
				await symlink(
					join(repo, path),
					join(root, "node_modules/@hobo", name),
					"dir",
				);
			}
			await symlink(
				join(repo, "node_modules/@types"),
				join(root, "node_modules/@types"),
				"dir",
			);
			await writeFile(join(root, "exercise.ts"), harness);
			const files = written.written
				.filter((path) => path.endsWith(".ts"))
				.map((path) => join(root, path));
			files.push(join(root, "exercise.ts"));
			const program = ts.createProgram(files, {
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				target: ts.ScriptTarget.ES2022,
				strict: true,
				noEmit: true,
				types: ["node"],
				skipLibCheck: false,
			});
			expect(
				ts
					.getPreEmitDiagnostics(program)
					.map(
						(problem) =>
							`${problem.file?.fileName}: ${ts.flattenDiagnosticMessageText(problem.messageText, "\n")}`,
					),
			).toEqual([]);
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					join(repo, "node_modules/tsx/dist/loader.mjs"),
					join(root, "exercise.ts"),
				],
				{ cwd: root, encoding: "utf8", timeout: 30_000 },
			);
			expect(result.error?.message).toBeUndefined();
			expect(result.stderr).not.toContain("Error");
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("DURABLE_GENERATED_API_PASS");
			const snapshotLine = result.stdout
				.split("\n")
				.find((line) => line.startsWith("RESOURCE_SNAPSHOT:"));
			expect(snapshotLine).toBeDefined();
			if (!snapshotLine)
				throw new Error("Execution did not expose its persisted snapshot");
			const snapshot = JSON.parse(
				snapshotLine.slice("RESOURCE_SNAPSHOT:".length),
			);
			const wire = fromJson(GeneratedResourceSnapshotSchema, snapshot);
			expect(toJson(GeneratedResourceSnapshotSchema, wire)).toEqual(snapshot);
			expect(() =>
				fromJson(GeneratedResourceSnapshotSchema, { entries: [] }),
			).toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 45_000);
});

const harness = `import assert from "node:assert/strict";
import { join } from "node:path";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { api, configureGeneratedRuntime, createGeneratedRuntime } from "./src/_generated/api-tree.js";
import { useTicketQuery, useTicketSubscription } from "./src/_generated/hooks.js";
import { registerStep, invokeStep } from "./src/_generated/steps.js";
import { registerWorkflow, runWorkflow } from "./src/_generated/workflows.js";
const dataDir = join(process.cwd(), ".state");
let store = createRuntimeLocalEventStore({dataDir});
let runtime = createGeneratedRuntime({store,tenant:"tenant-a",project:"project-a"});
let unconfigure = configureGeneratedRuntime(runtime);
const ticket = {id:"t-1",title:"first",priority:"normal" as const, details:{tags:["new"],active:true}};
const observed: string[] = [];
const unsubscribe = useTicketSubscription(value => {observed.push(value.title);});
await api.resources.ticket.put(ticket.id,ticket);
for(let attempt=0;observed.length===0 && attempt<100;attempt++) await new Promise(resolve=>setTimeout(resolve,5));
assert.deepEqual(await useTicketQuery(),[ticket]);
assert.deepEqual(observed,["first"]);
assert.deepEqual(await api.resources.ticket.get("t-1"),ticket);
assert.equal((await useTicketQuery({limit:0})).length,0);
const sparseTags: string[] = [];
sparseTags.length = 1;
await assert.rejects(()=>api.resources.ticket.put("sparse",{...ticket,details:{...ticket.details,tags:sparseTags}}),/sparse arrays/);
assert.equal(store.getStreamHead?.("generated/tenant-a/project-a/support/resource/ticket")?.revision,1);
assert.deepEqual(await useTicketQuery(),[ticket]);
// @ts-expect-error Deliberately send a runtime-invalid enum across the generated parser boundary.
await assert.rejects(()=>api.resources.ticket.put("invalid",{...ticket,priority:"not-an-enum"}));
assert.equal((await useTicketQuery()).length,1);
unsubscribe();
await api.resources.ticket.put("t-2",{...ticket,id:"t-2",title:"second"});
await new Promise(resolve=>setTimeout(resolve,10));
assert.deepEqual(observed,["first"]);
const resourceStream = "generated/tenant-a/project-a/support/resource/ticket";
const snapshot = await store.loadSnapshot<unknown>(resourceStream);
assert.ok(snapshot);
assert.equal(snapshot.seq,2);
assert.deepEqual(snapshot.state,{values:{"t-1":ticket,"t-2":{...ticket,id:"t-2",title:"second"}}});
console.log("RESOURCE_SNAPSHOT:"+JSON.stringify(snapshot.state));
let effects = 0;
registerStep("ticket.validate", input => {effects++;return {...input,title:input.title+":validated"};});
registerStep("ticket.enrich", input => {effects++;return {...input,details:{...input.details,tags:[...input.details.tags,"enriched"]}};});
assert.equal((await invokeStep("ticket.validate",ticket)).title,"first:validated");
// @ts-expect-error Runtime test verifies an implementation that violates its output contract is rejected.
registerStep("ticket.invalid", input => ({...input,title:42}));
const beforeInvalid = (await useTicketQuery()).length;
await assert.rejects(()=>invokeStep("ticket.invalid",ticket));
assert.equal((await useTicketQuery()).length,beforeInvalid);
registerWorkflow("ticket.triage",["ticket.validate","ticket.enrich"]);
const first = await runWorkflow("ticket.triage",ticket,"stable-run");
assert.deepEqual(first.result,{...ticket,title:"first:validated",details:{tags:["new","enriched"],active:true}});
assert.equal(effects,3);
await assert.rejects(()=>invokeStep("unregistered" as "ticket.validate",ticket));
await assert.rejects(()=>runWorkflow("incident.restore","input"));
registerWorkflow("a/b", input => String(input)+":first");
registerWorkflow("a", input => String(input)+":second");
assert.equal((await runWorkflow("a/b","one","c")).result,"one:first");
assert.equal((await runWorkflow("a","two","b/c")).result,"two:second");
const third = {...ticket,id:"t-3",title:"third"};
const changed = {...ticket,id:"t-2",title:"updated from tail"};
await store.append(resourceStream,[
  {type:"generated.ResourcePut",v:1,data:{key:"t-3",value:third}},
  {type:"generated.ResourceRemoved",v:1,data:{key:"t-1"}},
  {type:"generated.ResourcePut",v:1,data:{key:"t-2",value:changed}},
],{expectedSeq:2,actor:{kind:"service",id:"tail-writer"},tenant:"tenant-a",project:"project-a"});
assert.equal((await store.loadSnapshot(resourceStream))?.seq,2);
runtime.close();unconfigure();store.close();
store = createRuntimeLocalEventStore({dataDir});
const reopenedStore = store;
const resourceReads: (number | undefined)[] = [];
let snapshotLoads = 0;
const observedStore = {...store,
  read(streamId: string, fromSeq?: number) { if(streamId === resourceStream) resourceReads.push(fromSeq); return reopenedStore.read(streamId,fromSeq); },
  async loadSnapshot<S>(streamId: string) { if(streamId === resourceStream) snapshotLoads++; return reopenedStore.loadSnapshot<S>(streamId); },
};
runtime = createGeneratedRuntime({store:observedStore,tenant:"tenant-a",project:"project-a"});
unconfigure = configureGeneratedRuntime(runtime);
assert.deepEqual(await useTicketQuery(),[changed,third]);
assert.ok(snapshotLoads > 0);
assert.deepEqual(resourceReads,[3]);
assert.equal(await api.resources.ticket.get("t-1"),undefined);
assert.deepEqual(await api.resources.ticket.get("t-2"),changed);
await store.snapshot(resourceStream,{values:{bad:{...ticket,title:42}}},5);
await assert.rejects(()=>useTicketQuery(),/title/);
assert.equal(store.getStreamHead?.(resourceStream)?.revision,5);
await store.snapshot(resourceStream,{values:{"t-2":changed,"t-3":third}},5);
assert.deepEqual(await useTicketQuery(),[changed,third]);
registerStep("ticket.validate",()=>{throw new Error("completed effect re-executed");});
registerStep("ticket.enrich",()=>{throw new Error("completed effect re-executed");});
registerWorkflow("ticket.triage",["ticket.validate","ticket.enrich"]);
const resumed = await runWorkflow("ticket.triage",ticket,"stable-run");
assert.deepEqual(resumed.result,first.result);
await assert.rejects(()=>runWorkflow("ticket.triage",{...ticket,title:"changed-input"},"stable-run"),/different input/);
assert.equal(await api.resources.ticket.remove("t-2"),true);
assert.equal(await api.resources.ticket.remove("t-2"),false);
assert.deepEqual(await useTicketQuery(),[third]);
assert.deepEqual((await store.loadSnapshot(resourceStream))?.state,{values:{"t-3":third}});
const anotherTenant = createGeneratedRuntime({store,tenant:"tenant-b",project:"project-a"});
assert.deepEqual(await anotherTenant.resource("ticket").query(),[]);
anotherTenant.close();runtime.close();unconfigure();store.close();
console.log("DURABLE_GENERATED_API_PASS");
`;
