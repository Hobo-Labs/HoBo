import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resetTrainables } from "@hobo/runtime";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { runCodegen } from "../src/codegen/run-codegen.js";
import {
	createTypeScriptProjectCodegenEngine,
	packageTypeScriptAppArtifacts,
	selectTypeScriptProjectCodegenEngine,
} from "../src/codegen/typescript-project-engine.js";
import { slow } from "./support/slow.js";
import { compile, write } from "./support/typescript-project.js";

// Generated code imported in-process registers trainables in the shared
// registry; with files sharing a worker (isolate: false), clear it after each test.
afterEach(() => {
	resetTrainables();
});

// One of four files split from typescript-project-codegen.test.ts so the
// files can spread across workers; helpers are in ./support/typescript-project.ts.
describe("TypeScript app codegen executes the compiler-inferred app contract: ambient trainables and module resolution", {
	timeout: slow(60_000),
}, () => {
	it("composes ambient trainable registrations and executes an applied artifact through the generated namespace", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-imprint-training-"));
		try {
			await write(root, "package.json", JSON.stringify({ type: "module" }));
			await mkdir(join(root, "node_modules/@hobo"), { recursive: true });
			await mkdir(join(root, "node_modules/@types"), { recursive: true });
			await symlink(
				fileURLToPath(
					new URL("../../../node_modules/@types/node", import.meta.url),
				),
				join(root, "node_modules/@types/node"),
				"dir",
			);
			for (const name of ["runtime", "core"])
				await symlink(
					fileURLToPath(new URL(`../../${name}`, import.meta.url)),
					join(root, `node_modules/@hobo/${name}`),
					"dir",
				);
			await write(
				root,
				"source/greeter.ts",
				`declare const trainable: ClassDecorator; @trainable export declare class Greeter { greet(name: string): string; }`,
			);
			await write(
				root,
				"source/runtime.ts",
				`export { applyTrainingArtifact, getTrainable } from "@hobo/runtime"; export { serializeTrainingArtifactProgram } from "@hobo/core";`,
			);
			const engine = createTypeScriptProjectCodegenEngine();
			await runCodegen({ projectRoot: root, check: false }, { engine });
			expect(await engine.describeTrainables?.(root)).toEqual([
				expect.objectContaining({
					methodRef: "Greeter.greet",
					exportName: "greeterGreet",
					origin: "declared",
				}),
			]);
			const generatedFile = join(root, "src/_generated/app-imprint/app.ts");
			const program = ts.createProgram([generatedFile], {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				strict: true,
				types: ["node"],
				rootDir: root,
				outDir: join(root, "out"),
			});
			expect(
				ts
					.getPreEmitDiagnostics(program)
					.map((diagnostic) =>
						ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
					),
			).toEqual([]);
			program.emit();
			await packageTypeScriptAppArtifacts(root, join(root, "out"));
			// SAFETY: local generated modules were compiled above; the runtime helpers are reexports of the production engines.
			const generated = (await import(
				pathToFileURL(join(root, "out/src/_generated/app-imprint/app.js")).href
			)) as {
				app: {
					trainables: {
						greeterGreet: {
							(input: string): Promise<string>;
							methodRef: string;
						};
					};
					"source/runtime.ts": Pick<
						typeof import("@hobo/runtime"),
						"applyTrainingArtifact" | "getTrainable"
					> &
						Pick<
							typeof import("@hobo/core"),
							"serializeTrainingArtifactProgram"
						>;
				};
			};
			const operation = generated.app.trainables.greeterGreet;
			const runtime = generated.app["source/runtime.ts"];
			runtime.applyTrainingArtifact(operation.methodRef, {
				engineId: "hobo.training-engine/built-in-opto@0.1.0",
				engineVersion: "22.0.9",
				methodRef: operation.methodRef,
				programJson: runtime.serializeTrainingArtifactProgram({
					instructions: "Greet warmly",
					demos: [{ input: "Ada", output: "Hello, Ada!" }],
				}),
			});
			expect(await operation("Ada")).toBe("Hello, Ada!");
			expect(runtime.getTrainable(operation.methodRef)?.calls).toContainEqual(
				expect.objectContaining({
					input: "Ada",
					output: "Hello, Ada!",
					served: "matched-demo",
				}),
			);
			const bindings = await readFile(
				join(root, "src/_generated/app-imprint/bindings.ts"),
				"utf8",
			);
			expect(bindings).toContain(
				'"methodRef":"Greeter.greet","exportName":"greeterGreet"',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects unimplemented ambient value exports rather than generating a success with missing APIs", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "hobo-ts-imprint-missing-runtime-"),
		);
		try {
			await write(
				root,
				"source/app.ts",
				"export declare function charge(amount: number): Promise<string>; export const unrelated = 1;",
			);
			await expect(
				runCodegen(
					{ projectRoot: root, check: false },
					{ engine: createTypeScriptProjectCodegenEngine() },
				),
			).rejects.toThrow("ambient value with no runtime implementation");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("executes tsconfig aliases, local package barrels, const enums and namespace exports", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-imprint-alias-"));
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
						paths: {
							"@domain/*": ["packages/domain/*"],
							"@app/*": ["source/*"],
						},
					},
					include: ["source/**/*.ts", "packages/**/*.ts"],
				}),
			);
			await write(
				root,
				"packages/domain/package.json",
				JSON.stringify({ name: "@local/domain", type: "module" }),
			);
			await write(
				root,
				"packages/domain/types.ts",
				`export const enum Status { Ready = 3, Done = Ready + 2 }; export namespace Prices { export function total(items: readonly {price: number; count: number}[]): number { return items.reduce((sum, item) => sum + item.price * item.count, 0); } }`,
			);
			await write(
				root,
				"packages/domain/index.ts",
				`export { Status, Prices } from "./types.js";`,
			);
			await write(
				root,
				"source/service.ts",
				`import {Status, Prices} from "@domain/index"; export function calculate(items: readonly {price: number; count: number}[]) { return {status: Status.Done, total: Prices.total(items)}; }`,
			);
			await write(
				root,
				"source/app.ts",
				`export {calculate as quote} from "@app/service"; export {Status, Prices} from "@domain/index";`,
			);
			const engine = await selectTypeScriptProjectCodegenEngine(root);
			await runCodegen({ projectRoot: root, check: false }, { engine });
			await compile(root);
			// SAFETY: generated client compiles from these actual project-local implementations above.
			const generated = (await import(
				pathToFileURL(join(root, "out/src/_generated/app-imprint/app.js")).href
			)) as {
				app: {
					"source/app.ts": {
						quote(items: readonly { price: number; count: number }[]): {
							status: number;
							total: number;
						};
						Status: { Ready: number; Done: number };
						Prices: {
							total(items: readonly { price: number; count: number }[]): number;
						};
					};
				};
			};
			const app = generated.app["source/app.ts"];
			expect(app.quote([{ price: 7, count: 3 }])).toEqual({
				status: 5,
				total: 21,
			});
			expect(app.Status.Ready).toBe(3);
			expect(app.Status.Done).toBe(5);
			expect(app.Prices.total([{ price: 4, count: 2 }])).toBe(8);
			await write(
				root,
				"out/verify.mjs",
				`import {app} from "./src/_generated/app-imprint/app.js"; const service = app["source/app.ts"]; process.stdout.write(JSON.stringify({quote: service.quote([{price: 6,count: 4}]), ready: service.Status.Ready, total: service.Prices.total([{price: 2,count: 3}])}));`,
			);
			await rm(join(root, "source"), { recursive: true, force: true });
			await rm(join(root, "packages"), { recursive: true, force: true });
			await rm(join(root, "src"), { recursive: true, force: true });
			const native = await promisify(execFile)(
				process.execPath,
				[join(root, "out/verify.mjs")],
				{ env: {} },
			);
			expect(JSON.parse(native.stdout)).toEqual({
				quote: { status: 5, total: 24 },
				ready: 3,
				total: 6,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("bundles compiler-resolved workspace sibling aliases outside the app directory", async () => {
		const workspace = await mkdtemp(
			join(tmpdir(), "hobo-ts-imprint-workspace-"),
		);
		const root = join(workspace, "apps/shop");
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
						paths: { "@pricing/*": ["../../packages/pricing/*"] },
					},
					include: ["source/**/*.ts"],
				}),
			);
			await write(
				workspace,
				"packages/pricing/index.ts",
				`export function calculate(unitPrice: number, count: number): number { return unitPrice * count; }`,
			);
			await write(
				root,
				"source/app.ts",
				`import {calculate} from "@pricing/index"; export const quote = (unitPrice: number, count: number) => calculate(unitPrice, count);`,
			);
			await runCodegen(
				{ projectRoot: root, check: false },
				{ engine: createTypeScriptProjectCodegenEngine() },
			);
			const config = ts.readConfigFile(
				join(root, "tsconfig.json"),
				ts.sys.readFile,
			);
			const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
			const program = ts.createProgram(
				[join(root, "src/_generated/app-imprint/app.ts")],
				{
					...parsed.options,
					rootDir: workspace,
					outDir: join(workspace, "out"),
				},
			);
			expect(
				ts
					.getPreEmitDiagnostics(program)
					.map((diagnostic) =>
						ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
					),
			).toEqual([]);
			program.emit();
			await packageTypeScriptAppArtifacts(
				root,
				join(workspace, "out/apps/shop"),
			);
			// SAFETY: this client was compiled from the fixture and its actual sibling dependency was bundled above.
			const generated = (await import(
				pathToFileURL(
					join(workspace, "out/apps/shop/src/_generated/app-imprint/app.js"),
				).href
			)) as {
				app: {
					"source/app.ts": { quote(unitPrice: number, count: number): number };
				};
			};
			expect(generated.app["source/app.ts"].quote(7, 4)).toBe(28);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
