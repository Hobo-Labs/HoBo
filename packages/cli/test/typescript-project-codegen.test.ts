import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resetTrainables } from "@hobo/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { runCodegen } from "../src/codegen/run-codegen.js";
import {
	createTypeScriptProjectCodegenEngine,
	selectTypeScriptProjectCodegenEngine,
} from "../src/codegen/typescript-project-engine.js";
import { slow } from "./support/slow.js";
import { compile, fixture, write } from "./support/typescript-project.js";

// Generated code imported in-process registers trainables in the shared
// registry; with files sharing a worker (isolate: false), clear it after each test.
afterEach(() => {
	resetTrainables();
});

// One of four files split from typescript-project-codegen.test.ts so the
// files can spread across workers; helpers are in ./support/typescript-project.ts.
describe("TypeScript app codegen executes the compiler-inferred app contract: sources, entrypoints and generated models", {
	timeout: slow(60_000),
}, () => {
	it("discovers arbitrary source layout, retains imported nested/generic types, compiles and executes classes and HTTP handlers", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-imprint-"));
		try {
			await fixture(root);
			const engine = await selectTypeScriptProjectCodegenEngine(root);
			expect(engine).toBeDefined();
			await runCodegen({ projectRoot: root, check: false }, { engine });
			await runCodegen({ projectRoot: root, check: true }, { engine });
			await write(
				root,
				"consumer.ts",
				`
import { app, createAppClient } from "./src/_generated/app-imprint/app.js";
import type { Order, Page } from "./source/contracts.js";
const order: Order = { id: "o1", items: [{ sku: "s1", price: { amount: 3, currency: "EUR" } }], delivery: { address: { city: "Chicago" }, tags: ["fragile"] } };
const result: Promise<Page<Order>> = app["source/entrypoint.ts"].service.submit(order);
const service = new (createAppClient()["source/entrypoint.ts"].OrderService)();
const echoed: Order = app["source/entrypoint.ts"].echo(order);
// @ts-expect-error generated app API retains the nested currency literal union.
app["source/entrypoint.ts"].service.submit({ id: "bad", items: [{ sku: "s1", price: { amount: 1, currency: "GBP" } }] });
void result; void service; void echoed;
`,
			);
			await compile(root);
			// SAFETY: the test compiled these local generated modules and knows their fixture exports.
			const generated = (await import(
				pathToFileURL(join(root, "out/src/_generated/app-imprint/app.js")).href
			)) as {
				createAppClient(): {
					"source/entrypoint.ts": {
						service: {
							submit(order: {
								id: string;
								items: never[];
							}): Promise<{ entries: { id: string }[]; next: string }>;
						};
						default: { fetch(request: Request): Promise<Response> };
						echo<T>(input: T): T;
						OrderService: new () => {
							submit(order: {
								id: string;
								items: never[];
							}): Promise<{ next: string }>;
						};
					};
				};
			};
			const app = generated.createAppClient();
			expect(
				await app["source/entrypoint.ts"].service.submit({
					id: "o1",
					items: [],
				}),
			).toEqual({ entries: [{ id: "o1", items: [] }], next: "1" });
			expect(
				await new app["source/entrypoint.ts"].OrderService().submit({
					id: "o2",
					items: [],
				}),
			).toMatchObject({ next: "1" });
			expect(
				app["source/entrypoint.ts"].echo({ nested: { values: [1, 2] } }),
			).toEqual({ nested: { values: [1, 2] } });
			expect(
				await (
					await app["source/entrypoint.ts"].default.fetch(
						new Request("https://app.example/orders"),
					)
				).text(),
			).toBe("/orders");
			const manifest = JSON.parse(
				await readFile(
					join(root, ".hobo/generated/app-imprint/codegen-manifest.json"),
					"utf8",
				),
			);
			expect(manifest.sourceDigests["source/contracts.ts"]).toMatch(/^sha256:/);
			await write(
				root,
				"source/contracts.ts",
				"export interface Order { changed: true }; export interface Page<T> { entries: T[] };\n",
			);
			await expect(
				runCodegen({ projectRoot: root, check: true }, { engine }),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_SOURCE_PARSE" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not evaluate app modules during imprinting and reports source type errors before writes", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-imprint-invalid-"));
		try {
			await write(
				root,
				"app.ts",
				`throw new Error("must not execute during generation"); export const value = 1;`,
			);
			const engine = createTypeScriptProjectCodegenEngine();
			await expect(
				runCodegen({ projectRoot: root, check: false }, { engine }),
			).resolves.toMatchObject({ mode: "write" });
			await write(root, "app.ts", `export const value: string = 1;`);
			await expect(
				runCodegen({ projectRoot: root, check: false }, { engine }),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_SOURCE_PARSE" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("handles module-flavored entrypoints and overloaded exports", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-imprint-flavors-"));
		try {
			await write(root, "package.json", JSON.stringify({ type: "module" }));
			await write(
				root,
				"api.mts",
				`export function describe(value: string): string; export function describe(value: number): number; export function describe(value: string | number): string | number { return value; }`,
			);
			await write(
				root,
				"legacy.cts",
				`export function run(value: number) { return value * 2; }`,
			);
			await runCodegen(
				{ projectRoot: root, check: false },
				{ engine: createTypeScriptProjectCodegenEngine() },
			);
			await compile(root);
			// SAFETY: fixture exports are compiled above and invoked via their generated module names.
			const generated = (await import(
				pathToFileURL(join(root, "out/src/_generated/app-imprint/app.js")).href
			)) as {
				app: {
					"api.mts": { describe(value: string | number): string | number };
					"legacy.cts": { run(value: number): number };
				};
			};
			expect(generated.app["api.mts"].describe("typed")).toBe("typed");
			expect(generated.app["api.mts"].describe(4)).toBe(4);
			expect(generated.app["legacy.cts"].run(4)).toBe(8);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("imprints and invokes a real exported Bindle app without a JSON source model", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-imprint-bindle-"));
		try {
			await write(root, "package.json", JSON.stringify({ type: "module" }));
			await mkdir(join(root, "node_modules/@hobo"), { recursive: true });
			await symlink(
				fileURLToPath(new URL("../../bindles", import.meta.url)),
				join(root, "node_modules/@hobo/bindles"),
				"dir",
			);
			await write(
				root,
				"source/bindle.ts",
				`import { bindle } from "@hobo/bindles"; export default bindle("compiler-app", b => ({ api: b.api(() => ({ fetch(request: Request) { return new Response("bindle:" + new URL(request.url).pathname); } })) }));`,
			);
			const engine = createTypeScriptProjectCodegenEngine();
			await runCodegen({ projectRoot: root, check: false }, { engine });
			await compile(root);
			// SAFETY: the fixture's default export is an actual Bindle with an api HTTP entrypoint.
			const generated = (await import(
				pathToFileURL(join(root, "out/src/_generated/app-imprint/app.js")).href
			)) as {
				app: {
					"source/bindle.ts": {
						default: {
							name: string;
							entrypoint(
								name: string,
							): () => { fetch(request: Request): Response };
						};
					};
				};
			};
			const definition = generated.app["source/bindle.ts"].default;
			expect(definition.name).toBe("compiler-app");
			expect(
				await definition
					.entrypoint("api")()
					.fetch(new Request("https://app.example/orders"))
					.text(),
			).toBe("bindle:/orders");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("preserves preexisting generated models consumed by the app across regeneration", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-imprint-owned-roots-"));
		try {
			await write(root, "package.json", JSON.stringify({ type: "module" }));
			const model = "export const settings = {nested: {enabled: true}};\n";
			await write(root, "src/_generated/model.ts", model);
			await write(
				root,
				"source/app.ts",
				`import {settings} from "../src/_generated/model.js"; export function run() {return settings.nested.enabled;}`,
			);
			await write(
				root,
				".hobo/generated/other-tool.json",
				'{"ownedBy":"other"}\n',
			);
			const engine = createTypeScriptProjectCodegenEngine();
			await runCodegen({ projectRoot: root, check: false }, { engine });
			await runCodegen({ projectRoot: root, check: false }, { engine });
			await runCodegen({ projectRoot: root, check: true }, { engine });
			expect(
				await readFile(join(root, "src/_generated/model.ts"), "utf8"),
			).toBe(model);
			expect(
				await readFile(join(root, ".hobo/generated/other-tool.json"), "utf8"),
			).toContain("other");
			await compile(root);
			// SAFETY: fixture handler returns the generated model's literal boolean.
			const generated = (await import(
				pathToFileURL(join(root, "out/src/_generated/app-imprint/app.js")).href
			)) as { app: { "source/app.ts": { run(): boolean } } };
			expect(generated.app["source/app.ts"].run()).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
