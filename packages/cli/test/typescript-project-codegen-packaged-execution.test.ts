import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resetTrainables } from "@hobo/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { runCodegen } from "../src/codegen/run-codegen.js";
import { createTypeScriptProjectCodegenEngine } from "../src/codegen/typescript-project-engine.js";
import { slow } from "./support/slow.js";
import {
	compile,
	compilePackagedConsumer,
	write,
} from "./support/typescript-project.js";

// Generated code imported in-process registers trainables in the shared
// registry; with files sharing a worker (isolate: false), clear it after each test.
afterEach(() => {
	resetTrainables();
});

// One of four files split from typescript-project-codegen.test.ts so the
// files can spread across workers; helpers are in ./support/typescript-project.ts.
describe("TypeScript app codegen executes the compiler-inferred app contract: packaged execution", {
	timeout: slow(60_000),
}, () => {
	it("executes a packaged complex generic/class/overloaded/namespace app with aliases, top-level await and dynamic imports in plain Node", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "hobo-ts-imprint-complex-native-"),
		);
		try {
			await write(root, "package.json", JSON.stringify({ type: "module" }));
			await write(
				root,
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: {
						target: "ES2022",
						module: "ESNext",
						moduleResolution: "Bundler",
						strict: true,
						types: [],
						baseUrl: ".",
						paths: { "@domain/*": ["source/domain/*"] },
					},
					include: ["source/**/*.ts"],
				}),
			);
			await write(
				root,
				"source/domain/prices.ts",
				`(globalThis as typeof globalThis & {priceLoads?: number}).priceLoads = ((globalThis as typeof globalThis & {priceLoads?: number}).priceLoads ?? 0) + 1; export function price(items: readonly {unit: number; count: number}[]) {return items.reduce((total,item)=>total+item.unit*item.count,0);}`,
			);
			await write(
				root,
				"source/operations.ts",
				`
export function mapBox<T,U>(box: {value: T}, convert: (value: T) => U): {value: U} {return {value: convert(box.value)};}
export function describe(value: string): {kind: "text"; value: string};
export function describe(value: number): {kind: "number"; value: number};
export function describe(value: string | number) {return typeof value === "string" ? {kind: "text", value} : {kind: "number", value};}
export class Ledger { #total = 0; record(value: number) {this.#total += value; return this.#total;} }
export namespace Checks {export function positive(value: number) {return value > 0;}}
export const initialized = await Promise.resolve({version: 2});
export async function lazyTotal(items: readonly {unit: number; count: number}[]) {const prices = await import("@domain/prices"); return prices.price(items);}
`,
			);
			await write(
				root,
				"source/app.ts",
				`import {Ledger} from "./operations.js"; export {mapBox, describe, Ledger, Checks, initialized, lazyTotal} from "./operations.js"; export const ledger = new Ledger();`,
			);
			await runCodegen(
				{ projectRoot: root, check: false },
				{ engine: createTypeScriptProjectCodegenEngine() },
			);
			await write(
				root,
				"consumer.ts",
				`import {app} from "./src/_generated/app-imprint/app.js"; const client = app["source/app.ts"]; const mapped: {value: string} = client.mapBox({value: {nested: {amount: 3}}}, value => String(value.nested.amount)); const text: {kind: "text"; value: string} = client.describe("typed"); const numeric: {kind: "number"; value: number} = client.describe(4); void mapped; void text; void numeric;`,
			);
			await compile(root);
			await write(
				root,
				"out/verify.mjs",
				`import {app} from "./src/_generated/app-imprint/app.js"; const client=app["source/app.ts"]; const beforeLazy=globalThis.priceLoads ?? 0; const lazy=await client.lazyTotal([{unit:6,count:4},{unit:2,count:3}]); const again=await client.lazyTotal([]); const first=client.ledger.record(4), next=client.ledger.record(7); process.stdout.write(JSON.stringify({mapped: client.mapBox({value:{nested:{amount:3}}}, value=>value.nested.amount*5), text: client.describe("native"), number: client.describe(9), first, next, classIdentity: client.ledger instanceof client.Ledger, valid: client.Checks.positive(next), initialized: client.initialized, lazy, again, beforeLazy, priceLoads: globalThis.priceLoads, modulePaths: Object.keys(app)}));`,
			);
			await rm(join(root, "source"), { recursive: true, force: true });
			await rm(join(root, "src"), { recursive: true, force: true });
			await compilePackagedConsumer(
				root,
				`import {app} from "./src/_generated/app-imprint/app.js"; const api = app["source/app.ts"]; const box: {value: number} = api.mapBox({value: {nested: {value: 3}}}, value => value.nested.value); const text: {kind:"text";value:string} = api.describe("typed"); const ledger = new api.Ledger(); const total: number = ledger.record(2); void box; void text; void total; // @ts-expect-error private state stays private
ledger.total; // @ts-expect-error overload remains exact
api.describe(false);`,
			);
			const native = await promisify(execFile)(
				process.execPath,
				[join(root, "out/verify.mjs")],
				{ env: {} },
			);
			expect(JSON.parse(native.stdout)).toEqual({
				mapped: { value: 15 },
				text: { kind: "text", value: "native" },
				number: { kind: "number", value: 9 },
				first: 4,
				next: 11,
				classIdentity: true,
				valid: true,
				initialized: { version: 2 },
				lazy: 30,
				again: 0,
				beforeLazy: 0,
				priceLoads: 1,
				modulePaths: ["source/app.ts"],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		"graph",
		"package",
		"explicit",
	] as const)("executes %s application roots without exposing dependency modules or losing cyclic components", async (selection) => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-imprint-roots-"));
		try {
			await write(
				root,
				"package.json",
				JSON.stringify(
					selection === "package"
						? {
								type: "module",
								exports: {
									".": {
										types: "./dist/public.d.ts",
										import: "./dist/public.js",
										require: "./dist/cycle-b.js",
									},
								},
							}
						: { type: "module" },
				),
			);
			await write(
				root,
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: {
						target: "ES2022",
						module: "NodeNext",
						moduleResolution: "NodeNext",
						strict: true,
						types: [],
						rootDir: "source",
						outDir: "dist",
					},
					include: ["source/**/*.ts"],
				}),
			);
			await write(
				root,
				"source/cycle-a.ts",
				`import {suffix} from "./cycle-b.js"; export function prefix() {return "cyclic";} export function runCycle() {return prefix()+suffix();}`,
			);
			await write(
				root,
				"source/cycle-b.ts",
				`import {prefix} from "./cycle-a.js"; export function suffix() {return ":"+prefix();}`,
			);
			await write(
				root,
				"source/dependency.ts",
				`export function answer() {return 42;}`,
			);
			await write(
				root,
				"source/public.ts",
				`export {answer} from "./dependency.js";`,
			);
			await write(
				root,
				"source/types.ts",
				`import type {answer} from "./public.js"; import type {runCycle} from "./cycle-a.js"; export interface Contracts {answer: typeof answer; cycle: typeof runCycle;}`,
			);
			await runCodegen(
				{ projectRoot: root, check: false },
				{
					engine: createTypeScriptProjectCodegenEngine(
						selection === "explicit"
							? { entrypoints: ["source/public.ts", "source/cycle-b.ts"] }
							: {},
					),
				},
			);
			await compile(root);
			await write(
				root,
				"out/verify.mjs",
				`import {app} from "./src/_generated/app-imprint/app.js"; process.stdout.write(JSON.stringify({paths: Object.keys(app), answer: app["source/public.ts"].answer(), cyclic: app["source/cycle-a.ts"]?.runCycle() ?? app["source/cycle-b.ts"]?.suffix() ?? null}));`,
			);
			await rm(join(root, "source"), { recursive: true, force: true });
			await rm(join(root, "src"), { recursive: true, force: true });
			const native = await promisify(execFile)(
				process.execPath,
				[join(root, "out/verify.mjs")],
				{ env: {} },
			);
			expect(JSON.parse(native.stdout)).toEqual({
				paths:
					selection === "graph"
						? ["source/cycle-a.ts", "source/public.ts"]
						: selection === "package"
							? ["source/public.ts"]
							: ["source/public.ts", "source/cycle-b.ts"],
				answer: 42,
				cyclic:
					selection === "graph"
						? "cyclic:cyclic"
						: selection === "package"
							? null
							: ":cyclic",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("preserves checker-derived decorator metadata for imported classes in native packaged execution without evaluating during codegen", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-metadata-"));
		try {
			await write(root, "package.json", JSON.stringify({ type: "module" }));
			await write(
				root,
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: {
						target: "ES2022",
						module: "NodeNext",
						moduleResolution: "NodeNext",
						strict: true,
						types: [],
						experimentalDecorators: true,
						emitDecoratorMetadata: true,
					},
					include: ["source/**/*.ts"],
				}),
			);
			await write(
				root,
				"source/dependency.ts",
				`export class Dependency {constructor(readonly name: string) {}}`,
			);
			await write(
				root,
				"source/reflection.ts",
				`const values = new WeakMap<object, Map<string, unknown>>(); Object.defineProperty(Reflect, "metadata", {value(key:string, value:unknown) {return (target:object, property?:string) => {const entries = values.get(target) ?? new Map<string,unknown>(); entries.set(String(property)+":"+key,value); values.set(target,entries);};}}); Reflect.set(globalThis,"__hoboMetadataLoaded",true); export function metadata(target:object, key:string, property?:string):unknown {return values.get(target)?.get(String(property)+":"+key);}`,
			);
			await write(
				root,
				"source/controller.ts",
				`import "./reflection.js"; import {Dependency} from "./dependency.js"; function classMark(value:Function):void {void value;} function memberMark(target:object,key:string):void {void target;void key;} @classMark export class Controller {@memberMark field!: Dependency; constructor(readonly dependency: Dependency) {} @memberMark invoke(value:Dependency): Dependency {return value;}}`,
			);
			await write(
				root,
				"source/app.ts",
				`export {Controller} from "./controller.js"; export {Dependency} from "./dependency.js"; export {metadata} from "./reflection.js";`,
			);
			expect(Reflect.has(globalThis, "__hoboMetadataLoaded")).toBe(false);
			await runCodegen(
				{ projectRoot: root, check: false },
				{ engine: createTypeScriptProjectCodegenEngine() },
			);
			expect(Reflect.has(globalThis, "__hoboMetadataLoaded")).toBe(false);
			await compile(root);
			await write(
				root,
				"out/verify.mjs",
				`import {app} from "./src/_generated/app-imprint/app.js"; const {Controller,Dependency,metadata}=app["source/app.ts"]; const dependency=new Dependency("actual"); const controller=new Controller(dependency); process.stdout.write(JSON.stringify({constructor:metadata(Controller,"design:paramtypes")[0]===Dependency, property:metadata(Controller.prototype,"design:type","field")===Dependency, method:metadata(Controller.prototype,"design:paramtypes","invoke")[0]===Dependency, returns:metadata(Controller.prototype,"design:returntype","invoke")===Dependency, result:controller.invoke(dependency).name}));`,
			);
			await rm(join(root, "source"), { recursive: true, force: true });
			await rm(join(root, "src"), { recursive: true, force: true });
			await compilePackagedConsumer(
				root,
				`import {app} from "./src/_generated/app-imprint/app.js"; const {Controller,Dependency}=app["source/app.ts"]; const controller = new Controller(new Dependency("typed")); const name: string = controller.invoke(new Dependency("typed")).name; void name;`,
			);
			const native = await promisify(execFile)(
				process.execPath,
				[join(root, "out/verify.mjs")],
				{ env: {} },
			);
			expect(JSON.parse(native.stdout)).toEqual({
				constructor: true,
				property: true,
				method: true,
				returns: true,
				result: "actual",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
