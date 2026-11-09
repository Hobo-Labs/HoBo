import { spawnSync } from "node:child_process";
import {
	cp,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactKind } from "../src/_generated/build_manifest_pb.js";
import { sha256Bytes } from "../src/build/events.js";
import { parseBuildManifest } from "../src/build/parse.js";
import { createHoboCli } from "../src/index.js";
import { slow } from "./support/slow.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The app reads `process.env`. `nodeTypes` gives it the repository's real
 * `@types/node` (about 140 declaration files, 15-25 CPU s per codegen pass);
 * otherwise one ambient declaration types it, which is all the refusal cases
 * need: they assert on what `build` refuses, not on Node's types.
 */
async function project(nodeTypes = false): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hobo-node-app-build-"));
	await mkdir(join(root, "src/lib"), { recursive: true });
	if (nodeTypes) {
		await mkdir(join(root, "node_modules"), { recursive: true });
		await symlink(
			join(repo, "node_modules/@types"),
			join(root, "node_modules/@types"),
			"dir",
		);
	}
	await writeFile(join(root, "package.json"), '{"type":"module"}');
	await writeFile(
		join(root, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				baseUrl: ".",
				paths: { "~/*": ["src/*"] },
				types: nodeTypes ? ["node"] : [],
				// The app's own files are still checked; Node's declarations are not ours to check.
				...(nodeTypes ? { skipLibCheck: true } : {}),
			},
			include: ["src"],
		}),
	);
	await writeFile(
		join(root, "src/lib/shared.ts"),
		"export const multiplier = 6;\n",
	);
	await writeFile(
		join(root, "src/lib/math.ts"),
		'import { multiplier } from "./shared.js"; export function calculate(input: {units: number}) { return input.units * multiplier; }\n',
	);
	await writeFile(
		join(root, "src/lib/lazy.ts"),
		'import { multiplier } from "./shared.js"; export const label = () => "total-" + multiplier;\n',
	);
	await writeFile(
		join(root, "src/lib/icon.png"),
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]),
	);
	await writeFile(
		join(root, "src/assets.d.ts"),
		`declare module "*.png" { const path: string; export default path; }\n${
			nodeTypes
				? ""
				: "declare const process: { env: Record<string, string | undefined> };\n"
		}`,
	);
	await writeFile(
		join(root, "src/lib/contracts.ts"),
		"export interface OrderInput { units: number; }\nexport interface OrderResult { total: number; label: string; }\n",
	);
	await writeFile(
		join(root, "src/app.ts"),
		`import { calculate } from "~/lib/math.js";
import type { OrderInput, OrderResult } from "~/lib/contracts.js";
import icon from "./lib/icon.png";
export const iconPath = icon;
if (process.env.ALLOW_APP_EXECUTION !== "1") throw new Error("Application code was evaluated during build");
export async function processOrder(input: OrderInput): Promise<OrderResult> { const lazy = await import("./lib/lazy.js"); return {total:calculate(input),label:lazy.label()}; }
export class OrderBook { constructor(readonly label: string) {} async process(input: OrderInput): Promise<OrderResult> { const order = await processOrder(input); return {...order,label:this.label}; } }
`,
	);
	return root;
}

describe("plain TypeScript Node app build", () => {
	it(
		"codegens, builds deterministically and executes the packaged app with normal Node",
		async () => {
			const root = await project(true);
			try {
				const cli = createHoboCli();
				const generated = await cli.run(["codegen", "--json"], { cwd: root });
				expect(generated.exitCode, generated.stdout).toBe(0);
				const first = await cli.run(["build", "--json"], { cwd: root });
				expect(first.exitCode, first.stdout).toBe(0);
				const manifest = parseBuildManifest(
					JSON.parse(
						await readFile(
							join(root, ".hobo/build/build-manifest.json"),
							"utf8",
						),
					),
				);
				expect(manifest.runtimeTarget).toBe("auto");
				expect(() =>
					parseBuildManifest({
						...manifest,
						artifacts: manifest.artifacts.map((artifact) => ({
							...artifact,
							runtime: "wasm",
						})),
					}),
				).toThrow("Node app artifacts require runtime node");
				expect(
					manifest.artifacts.some(
						(artifact) => artifact.path === ".hobo/build/node-app/app.d.mts",
					),
				).toBe(true);
				expect(
					manifest.artifacts.some(
						(artifact) =>
							artifact.path === ".hobo/build/node-app/bindings.d.mts",
					),
				).toBe(true);
				expect(
					manifest.artifacts.some(
						(artifact) => artifact.path === ".hobo/build/node-app/bindings.mjs",
					),
				).toBe(true);
				expect(
					manifest.artifacts.some(
						(artifact) =>
							artifact.path.includes("/runtime/types/") &&
							/\.d\.[cm]?ts$/u.test(artifact.path),
					),
				).toBe(true);
				expect(
					manifest.artifacts.some(
						(artifact) => artifact.path === ".hobo/build/node-app/app.mjs",
					),
				).toBe(true);
				expect(
					manifest.artifacts.some(
						(artifact) =>
							artifact.path.includes("/runtime/") &&
							artifact.path.endsWith(".mjs"),
					),
				).toBe(true);
				expect(
					manifest.artifacts.every(
						(artifact) =>
							artifact.kind === "node-app" && artifact.runtime === "node",
					),
				).toBe(true);
				for (const artifact of manifest.artifacts)
					expect(artifact.digest).toBe(
						sha256Bytes(await readFile(join(root, artifact.path))),
					);
				expect(
					manifest.artifacts.some(
						(artifact) =>
							artifact.path.includes("/runtime/assets/") &&
							artifact.path.endsWith(".png"),
					),
				).toBe(true);
				const before = await readFile(
					join(root, ".hobo/build/build-manifest.json"),
					"utf8",
				);
				const again = await cli.run(["build", "--json"], { cwd: root });
				expect(again.exitCode, again.stdout).toBe(0);
				expect(
					await readFile(join(root, ".hobo/build/build-manifest.json"), "utf8"),
				).toBe(before);

				await writeFile(
					join(root, "src/app.ts"),
					(await readFile(join(root, "src/app.ts"), "utf8")) +
						"\nexport const newExport = 1;\n",
				);
				const stale = await cli.run(["build", "--json"], { cwd: root });
				expect(JSON.parse(stale.stdout)).toMatchObject({
					ok: false,
					code: "HOBO_BUILD_CODEGEN_DRIFT",
				});
				expect(
					await readFile(join(root, ".hobo/build/build-manifest.json"), "utf8"),
				).toBe(before);
				// The deployment artifact must run after all authored/generated TS sources are gone.
				await rm(join(root, "src"), { recursive: true, force: true });
				const consumer = join(root, "isolated-consumer");
				await mkdir(consumer);
				await cp(
					join(root, ".hobo/build/node-app"),
					join(consumer, "node-app"),
					{
						recursive: true,
					},
				);
				await writeFile(join(consumer, "package.json"), '{"type":"module"}');
				await writeFile(
					join(consumer, "tsconfig.json"),
					JSON.stringify({
						compilerOptions: {
							target: "ES2022",
							module: "NodeNext",
							moduleResolution: "NodeNext",
							strict: true,
							noEmit: true,
							skipLibCheck: false,
							types: [],
						},
						include: ["consumer.mts"],
					}),
				);
				await writeFile(
					join(consumer, "consumer.mts"),
					`import { createAppClient, getAppModule } from "./node-app/app.mjs";
import { modulePaths, trainableMappings } from "./node-app/bindings.mjs";
const path: "src/app.ts" = modulePaths[0];
const mappings: readonly unknown[] = trainableMappings;
const module = getAppModule("src/app.ts");
const result: Promise<{total:number;label:string}> = module.processOrder({units:7});
const book = new module.OrderBook("isolated");
const bookResult: Promise<{total:number;label:string}> = book.process({units:2});
const label: string = book.label;
const clientResult: Promise<{total:number;label:string}> = createAppClient()["src/app.ts"].processOrder({units:1});
// @ts-expect-error generated function retains its numeric input
module.processOrder({units:"seven"});
// @ts-expect-error generated class retains its constructor signature
new module.OrderBook(42);
// @ts-expect-error generated class retains its method signature
book.process({units:false});
// @ts-expect-error generated result retains its numeric total
const wrongResult: Promise<{total:string;label:string}> = module.processOrder({units:1});
// @ts-expect-error module names remain a closed compiler-derived mapping
getAppModule("missing.ts");
`,
				);
				const typecheck = spawnSync(
					process.execPath,
					[
						join(repo, "node_modules/typescript/bin/tsc"),
						"-p",
						"tsconfig.json",
					],
					{ cwd: consumer, encoding: "utf8", timeout: 20_000 },
				);
				expect(typecheck.error?.message).toBeUndefined();
				expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0);
				const run = spawnSync(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						'const {readFile}=await import("node:fs/promises"); const {getAppModule,resolveAppAsset}=await import("./node-app/app.mjs"); const {modulePaths,trainableMappings}=await import("./node-app/bindings.mjs"); const module=getAppModule("src/app.ts"); const result=await module.processOrder({units:7}); const book=new module.OrderBook("native"); console.log(JSON.stringify({...result,modulePaths,trainableMappings,book:await book.process({units:3}),asset:Array.from(await readFile(resolveAppAsset(module.iconPath)))}));',
					],
					{
						cwd: consumer,
						encoding: "utf8",
						env: { ...process.env, ALLOW_APP_EXECUTION: "1" },
						timeout: 20_000,
					},
				);
				expect(run.error?.message).toBeUndefined();
				expect(run.status, run.stderr).toBe(0);
				expect(JSON.parse(run.stdout)).toEqual({
					total: 42,
					label: "total-6",
					book: { total: 18, label: "native" },
					modulePaths: ["src/app.ts"],
					trainableMappings: [],
					asset: [137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128],
				});
				expect(ArtifactKind.NODE_APP).toBe(3);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		slow(90_000),
	);

	describe("on one generated project", () => {
		let root: string;
		beforeAll(async () => {
			root = await project();
			const generated = await createHoboCli().run(["codegen", "--json"], {
				cwd: root,
			});
			expect(generated.exitCode, generated.stdout).toBe(0);
		}, slow(60_000));
		afterAll(async () => {
			await rm(root, { recursive: true, force: true });
		});

		it.each(["wasm", "container"])(
			"refuses explicit %s instead of silently packaging Node",
			async (runtime) => {
				const result = await createHoboCli().run(
					["build", "--runtime", runtime, "--json"],
					{ cwd: root },
				);
				expect(JSON.parse(result.stdout)).toMatchObject({
					ok: false,
					code: "HOBO_BUILD_RUNTIME_INVALID",
				});
				// The cases share the project, so a refusal must leave it as it found it.
				await expect(
					readFile(join(root, ".hobo/build/build-manifest.json")),
				).rejects.toMatchObject({ code: "ENOENT" });
			},
			slow(60_000),
		);

		it("refuses an explicit runtime before checking the generated tree", async () => {
			const app = join(root, "src/app.ts");
			const authored = await readFile(app, "utf8");
			await writeFile(app, `${authored}\nexport const drifted = 1;\n`);
			try {
				const result = await createHoboCli().run(
					["build", "--runtime", "wasm", "--json"],
					{ cwd: root },
				);
				// The request can never build, so it is refused as such, not as drift.
				expect(JSON.parse(result.stdout)).toMatchObject({
					ok: false,
					code: "HOBO_BUILD_RUNTIME_INVALID",
				});
			} finally {
				await writeFile(app, authored);
			}
		});
	});
	it(
		"does not bypass an explicit empty service declaration into Node packaging",
		async () => {
			const root = await project();
			try {
				const cli = createHoboCli();
				await writeFile(
					join(root, "hobo.bindle.json"),
					JSON.stringify({ services: [] }),
				);
				expect(
					(await cli.run(["codegen", "--json"], { cwd: root })).exitCode,
				).toBe(0);
				const result = await cli.run(["build", "--json"], { cwd: root });
				expect(JSON.parse(result.stdout)).toMatchObject({
					ok: false,
					code: "HOBO_BUILD_NO_SERVICES",
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		slow(60_000),
	);
});
