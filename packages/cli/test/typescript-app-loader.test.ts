import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBindleDefinition } from "../src/cloud/loader.js";
import { httpDefinitionFromModule } from "../src/cloud/typescript-app-loader.js";
import { createHoboCli } from "../src/index.js";
import { copyBuiltStarter } from "./support/built-starter.js";

function handler(
	definition: NonNullable<ReturnType<typeof httpDefinitionFromModule>>,
) {
	const factory = definition.entrypoint("api");
	if (!factory) throw new Error("Missing real API entrypoint");
	const fetch = factory();
	if (!(fetch instanceof Function))
		throw new Error("Missing HTTP fetch function");
	// SAFETY: the adapter stores a platform fetch function as the actual Bindle API entrypoint.
	return fetch as (request: Request) => Response | Promise<Response>;
}

describe("TypeScript HTTP application deployment loader", () => {
	it("invokes the async run port with real method, headers and parsed JSON, preserving status, headers and object binding", async () => {
		const definition = httpDefinitionFromModule("actual", {
			api: {
				async run(request) {
					return {
						status: 207,
						headers: { "x-app-method": request.method },
						body: {
							path: request.path,
							body: request.body,
							header: request.headers["x-proof"],
						},
					};
				},
			},
		});
		if (!definition) throw new Error("Application should be deployable");
		expect(definition.resources.api?.annotations).toContainEqual({
			provider: "hobo",
			option: "endpoint",
			config: { external: true },
		});
		const response = await handler(definition)(
			new Request("http://app.test/proof?q=1", {
				method: "POST",
				headers: { "content-type": "application/json", "x-proof": "actual" },
				body: JSON.stringify({ nested: { count: 3 } }),
			}),
		);
		expect(response.status).toBe(207);
		expect(response.headers.get("x-app-method")).toBe("POST");
		expect(await response.json()).toEqual({
			path: "/proof?q=1",
			body: { nested: { count: 3 } },
			header: "actual",
		});
	});

	it("keeps native Responses and handler exceptions intact", async () => {
		const response = new Response("created", {
			status: 201,
			headers: { "x-proof": "native" },
		});
		const direct = httpDefinitionFromModule("direct", {
			api: { run: () => response },
		});
		const failed = httpDefinitionFromModule("failed", {
			api: {
				async run() {
					throw new Error("application failed");
				},
			},
		});
		if (!direct || !failed)
			throw new Error("Applications should be deployable");
		expect(await handler(direct)(new Request("http://app.test/"))).toBe(
			response,
		);
		await expect(
			handler(failed)(new Request("http://app.test/")),
		).rejects.toThrow("application failed");
	});

	it.each([
		"fetch",
		"default-function",
		"default-object",
	] as const)("serves explicit %s HTTP application exports", async (kind) => {
		const fetch = async (request: Request) =>
			new Response(new URL(request.url).pathname, { status: 202 });
		const surface =
			kind === "fetch"
				? { fetch }
				: kind === "default-function"
					? { default: fetch }
					: { default: { fetch } };
		const definition = httpDefinitionFromModule("fetch-app", surface);
		if (!definition) throw new Error("Application should be deployable");
		const response = await handler(definition)(
			new Request("http://app.test/executed"),
		);
		expect(response.status).toBe(202);
		expect(await response.text()).toBe("/executed");
	});

	it("refuses tampered packaged code and stale available sources before loading a real built starter", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-loader-build-"));
		try {
			// `hobo new` without -t scaffolds the api starter; starter-end-to-end builds the same one.
			const project = await copyBuiltStarter("api", root);
			await rm(join(project, "src"), { recursive: true, force: true });
			const bundle = join(project, ".hobo/build/node-app/app.mjs");
			const original = await readFile(bundle, "utf8");
			await writeFile(
				bundle,
				`${original}\nthrow new Error("tampered package executed");\n`,
			);
			await expect(loadBindleDefinition(project)).rejects.toThrow(
				"artifact digest mismatch",
			);
			await writeFile(bundle, original);
			const source = join(project, "app.ts");
			await writeFile(
				source,
				`${await readFile(source, "utf8")}\n// newer authored source\n`,
			);
			await expect(loadBindleDefinition(project)).rejects.toThrow(
				"stale for authored source",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	it("checks raw binary, JSON, declarations and configuration inputs, including workspace sources, before serving a source-free build", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-loader-inputs-"));
		try {
			const project = join(root, "app");
			await mkdir(join(project, "src"), { recursive: true });
			await writeFile(
				join(root, "package.json"),
				'{"private":true,"workspaces":["app"]}',
			);
			const files = new Map<string, string | Uint8Array>([
				["../shared.ts", 'export const shared = "workspace";'],
				[
					"../base.json",
					JSON.stringify({
						compilerOptions: {
							strict: true,
							target: "ES2022",
							module: "ESNext",
							moduleResolution: "Bundler",
							resolveJsonModule: true,
							types: [],
						},
					}),
				],
				["package.json", '{"type":"module"}'],
				[
					"tsconfig.json",
					'{"extends":"../base.json","include":["src/**/*.ts"]}',
				],
				[
					"hobo.bindle.json",
					'{"schemaVersion":"hobo.bindle/v1","name":"inputs","entrypoint":"src/app.ts"}',
				],
				["src/config.json", '{"message":"compiled JSON"}'],
				["src/logo.png", new Uint8Array([137, 80, 78, 71, 255])],
				[
					"src/assets.d.ts",
					'declare module "*.png" { const path: string; export default path; } declare module "data:*" { const value: number; export default value; }',
				],
				[
					"src/app.ts",
					'import config from "./config.json"; import icon from "./logo.png"; import embedded from "data:text/javascript,export default 4"; import {shared} from "../../shared.js"; export function fetch() { return new Response(JSON.stringify({message:config.message,icon,shared,embedded})); }',
				],
			]);
			for (const [path, content] of files)
				await writeFile(join(project, path), content);
			const cli = createHoboCli();
			for (const command of ["codegen", "build"]) {
				const result = await cli.run([command, "--json"], { cwd: project });
				expect(result.stderr).toBe("");
				expect(result.exitCode, result.stdout).toBe(0);
			}
			const manifest = JSON.parse(
				await readFile(
					join(project, ".hobo/generated/app-imprint/codegen-manifest.json"),
					"utf8",
				),
			);
			expect(manifest.sourceDigestEncoding).toBe("raw");
			for (const path of [
				"src/logo.png",
				"src/config.json",
				"src/assets.d.ts",
				"tsconfig.json",
				"package.json",
			])
				expect(manifest.sourceDigests[path]).toMatch(/^sha256:/u);
			for (const path of ["../shared.ts", "../base.json"])
				expect(manifest.externalSourceDigests[path]).toMatch(/^sha256:/u);
			// Removing the application entry forces the deployment adapter through its packaged runtime.
			await rm(join(project, "src/app.ts"));
			for (const [path, original] of files) {
				if (path === "src/app.ts") continue;
				const changed =
					original instanceof Uint8Array
						? new Uint8Array([137, 80, 78, 71, 254])
						: `${original}\n `;
				await writeFile(join(project, path), changed);
				await expect(loadBindleDefinition(project), path).rejects.toThrow(
					"stale for authored source",
				);
				await writeFile(join(project, path), original);
			}
			const outside = await mkdtemp(join(tmpdir(), "hobo-loader-outside-"));
			try {
				const outsideFile = join(outside, "private.txt");
				await writeFile(outsideFile, "outside workspace");
				await symlink(outsideFile, join(root, "escape.txt"));
				const manifestPath = join(
					project,
					".hobo/generated/app-imprint/codegen-manifest.json",
				);
				const original = await readFile(manifestPath, "utf8");
				for (const path of [relative(project, outsideFile), "../escape.txt"]) {
					await writeFile(
						manifestPath,
						JSON.stringify({
							...manifest,
							externalSourceDigests: {
								...manifest.externalSourceDigests,
								[path]: `sha256:${"0".repeat(64)}`,
							},
						}),
					);
					await expect(loadBindleDefinition(project)).rejects.toThrow(
						"escapes the configured workspace",
					);
				}
				await writeFile(manifestPath, original);
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
			await rm(join(project, "src"), { recursive: true });
			await rm(join(root, "shared.ts"));
			await rm(join(root, "base.json"));
			const definition = await loadBindleDefinition(project);
			expect(definition).not.toBeNull();
			if (!definition) throw new Error("Expected packaged application");
			const response = await handler(definition)(
				new Request("http://app.test/"),
			);
			expect(await response.json()).toMatchObject({
				message: "compiled JSON",
				shared: "workspace",
				embedded: 4,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});
