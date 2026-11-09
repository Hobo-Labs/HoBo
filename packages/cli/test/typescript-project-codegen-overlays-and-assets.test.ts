import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCodegen } from "../src/codegen/run-codegen.js";
import {
	createTypeScriptProjectCodegenEngine,
	selectTypeScriptProjectCodegenEngine,
} from "../src/codegen/typescript-project-engine.js";
import { slow } from "./support/slow.js";
import {
	compile,
	compilePackagedConsumer,
	write,
} from "./support/typescript-project.js";

// One of four files split from typescript-project-codegen.test.ts so the
// files can spread across workers; helpers are in ./support/typescript-project.ts.
describe("TypeScript app codegen executes the compiler-inferred app contract: source overlays, assets and CommonJS", {
	timeout: slow(60_000),
}, () => {
	it.each([
		"missing",
		"invalid",
	])("uses canonical source overlays for a %s imported seed without mutating authored inputs during generation", async (state) => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-imprint-overlay-"));
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
						allowImportingTsExtensions: true,
						noEmit: true,
					},
					include: ["app.ts", "src/**/*.ts"],
				}),
			);
			const authored = `import {calculate} from "./src/_generated/index.ts"; export function run(items: readonly {price: number; count: number}[]) {return calculate(items);}`;
			const canonical =
				"export function calculate(items: readonly {price: number; count: number}[]): number {return items.reduce((sum,item) => sum + item.price * item.count, 0);}";
			await write(root, "app.ts", authored);
			if (state === "invalid")
				await write(root, "src/_generated/index.ts", "const [broken seed");
			const engine = createTypeScriptProjectCodegenEngine({
				sourceOverrides: { "src/_generated/index.ts": canonical },
			});
			await runCodegen({ projectRoot: root, check: false }, { engine });
			await runCodegen({ projectRoot: root, check: true }, { engine });
			expect(await readFile(join(root, "app.ts"), "utf8")).toBe(authored);
			if (state === "invalid")
				expect(
					await readFile(join(root, "src/_generated/index.ts"), "utf8"),
				).toBe("const [broken seed");
			else
				await expect(
					readFile(join(root, "src/_generated/index.ts"), "utf8"),
				).rejects.toMatchObject({ code: "ENOENT" });
			// SAFETY: executable generated bundle is built from the trusted canonical seed plus this fixture's app.
			const generated = (await import(
				pathToFileURL(
					join(root, "src/_generated/app-imprint/runtime/appModule0.mjs"),
				).href
			)) as { run(items: readonly { price: number; count: number }[]): number };
			expect(
				generated.run([
					{ price: 7, count: 3 },
					{ price: 2, count: 4 },
				]),
			).toBe(29);
			const manifest = JSON.parse(
				await readFile(
					join(root, ".hobo/generated/app-imprint/codegen-manifest.json"),
					"utf8",
				),
			);
			expect(manifest.sourceDigests["src/_generated/index.ts"]).toBeDefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("preserves binary file-loader assets through codegen drift checks and native artifact packaging with CSS and JSON imports", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-ts-imprint-assets-"));
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
						resolveJsonModule: true,
					},
					include: ["source/**/*.ts"],
				}),
			);
			await write(
				root,
				"source/assets.d.ts",
				'declare module "*.png" { const url: string; export default url; } declare module "*.wasm" { const url: string; export default url; } declare module "*.css";',
			);
			await write(
				root,
				"source/config.json",
				JSON.stringify({ theme: { title: "imported config" } }),
			);
			await write(
				root,
				"source/styles.css",
				'.logo { background-image: url("./logo.png"); color: red; }',
			);
			const image = new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80,
				0x42,
			]);
			const wasm = new Uint8Array([
				0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
			]);
			await writeFile(join(root, "source/logo.png"), image);
			await writeFile(join(root, "source/module.wasm"), wasm);
			await write(
				root,
				"source/app.ts",
				'import image from "./logo.png"; import wasm from "./module.wasm"; import config from "./config.json"; import "./styles.css"; export function assets() { return {image, wasm, title: config.theme.title}; }',
			);
			const engine = createTypeScriptProjectCodegenEngine({
				entrypoints: ["source/app.ts"],
			});
			const artifacts = await engine.generate(root);
			expect(
				artifacts.find((artifact) => artifact.path.endsWith(".png"))
					?.binaryContent,
			).toEqual(image);
			expect(
				artifacts.find((artifact) => artifact.path.endsWith(".wasm"))
					?.binaryContent,
			).toEqual(wasm);
			const generated = await runCodegen(
				{ projectRoot: root, check: false },
				{ engine },
			);
			await runCodegen({ projectRoot: root, check: true }, { engine });
			const asset = generated.written.find((path) => path.endsWith(".png"));
			expect(asset).toBeDefined();
			if (!asset) throw new Error("Expected emitted PNG asset");
			expect(new Uint8Array(await readFile(join(root, asset)))).toEqual(image);
			await writeFile(join(root, asset), new Uint8Array([...image, 0x00]));
			await expect(
				runCodegen({ projectRoot: root, check: true }, { engine }),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_DRIFT" });
			await runCodegen({ projectRoot: root, check: false }, { engine });
			await compile(root);
			// SAFETY: real TS/asset imports above were bundled and the executable client was compiled and packaged.
			const client = (await import(
				pathToFileURL(join(root, "out/src/_generated/app-imprint/app.js")).href
			)) as {
				app: {
					"source/app.ts": {
						assets(): { image: string; wasm: string; title: string };
					};
				};
				resolveAppAsset(path: string): URL;
			};
			const values = client.app["source/app.ts"].assets();
			expect(values.title).toBe("imported config");
			expect(
				new Uint8Array(await readFile(client.resolveAppAsset(values.image))),
			).toEqual(image);
			expect(
				new Uint8Array(await readFile(client.resolveAppAsset(values.wasm))),
			).toEqual(wasm);
			expect(generated.written.some((path) => path.endsWith(".css"))).toBe(
				true,
			);
			await rm(join(root, "source"), { recursive: true, force: true });
			await rm(join(root, "src"), { recursive: true, force: true });
			await compilePackagedConsumer(
				root,
				`import {app} from "./src/_generated/app-imprint/app.js"; const assets: {image:string;wasm:string;title:string} = app["source/app.ts"].assets(); void assets;`,
			);
			const packagedValues = client.app["source/app.ts"].assets();
			expect(
				new Uint8Array(
					await readFile(client.resolveAppAsset(packagedValues.image)),
				),
			).toEqual(image);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
	it("preserves true CommonJS export-assignment callables, constructors and namespace properties", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "hobo-ts-imprint-export-equals-"),
		);
		try {
			await write(root, "package.json", JSON.stringify({ type: "module" }));
			await write(
				root,
				"legacy.cts",
				`function calculate(value: number): number {return value * 3;} namespace calculate {export const version = "v1";} export = calculate;`,
			);
			await write(
				root,
				"counter.cts",
				`class Counter { private count = 0; add(value: number) { this.count += value; return this.count; } } export = Counter;`,
			);
			await write(
				root,
				"object.cts",
				`const api = {quote: (price: number, count: number) => price * count}; export = api;`,
			);
			const engine = await selectTypeScriptProjectCodegenEngine(root);
			await runCodegen({ projectRoot: root, check: false }, { engine });
			await compile(root);
			await write(
				root,
				"out/verify.mjs",
				`import {app} from "./src/_generated/app-imprint/app.js"; const counter = new app["counter.cts"](); process.stdout.write(JSON.stringify({value: app["legacy.cts"](4), version: app["legacy.cts"].version, first: counter.add(2), next: counter.add(5), quote: app["object.cts"].quote(7,3)}));`,
			);
			await rm(join(root, "legacy.cts"));
			await rm(join(root, "counter.cts"));
			await rm(join(root, "object.cts"));
			await rm(join(root, "src"), { recursive: true, force: true });
			await compilePackagedConsumer(
				root,
				`import {app} from "./src/_generated/app-imprint/app.js"; const count: number = new app["counter.cts"]().add(3); const value: number = app["legacy.cts"](4); const version: "v1" = app["legacy.cts"].version; const quote: number = app["object.cts"].quote(2,5); void count; void value; void version; void quote; // @ts-expect-error preserved parameter type
app["legacy.cts"]("wrong");`,
			);

			const native = await promisify(execFile)(
				process.execPath,
				[join(root, "out/verify.mjs")],
				{ env: {} },
			);
			expect(JSON.parse(native.stdout)).toEqual({
				value: 12,
				version: "v1",
				first: 2,
				next: 7,
				quote: 21,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
