import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { serveProjectOnBareMetalYard } from "../src/bare-metal-host.js";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { serveBindleOnLocalYard } from "../src/local-yard-serve.js";
import { serveProjectOnHost } from "../src/multi-host-serve.js";
import { serveProjectOnLocalYard } from "../src/wasm-host.js";

const paths = [
	{ name: "bare-metal", serve: serveProjectOnBareMetalYard },
	{ name: "local component host", serve: serveBindleOnLocalYard },
	{
		name: "multi-host",
		serve: (options: { projectDir: string; hoboHome: string; port: number }) =>
			serveProjectOnHost({ ...options, componentHost: "cloud-native" }),
	},
	{
		name: "local yard dispatcher",
		serve: (options: { projectDir: string; hoboHome: string; port: number }) =>
			serveProjectOnLocalYard({ ...options, componentHost: "local" }),
	},
	{
		name: "multi-host dispatcher",
		serve: (options: { projectDir: string; hoboHome: string; port: number }) =>
			serveProjectOnLocalYard({ ...options, componentHost: "cloud-native" }),
	},
];

const cases = paths.flatMap((path) =>
	["environment", "endpoint"].map((kind) => ({ ...path, kind })),
);

it.each(cases)(
	"rejects unsafe $kind before $name startup mutates the process",
	async ({ serve, kind }) => {
		const root = await mkdtemp(join(tmpdir(), "hobo-binding-startup-"));
		const projectDir = join(root, "project");
		const hoboHome = join(root, "home");
		const key = "TEST_BINDING_API_KEY";
		const secret = "fixture-credential-value";
		const previousValue = process.env[key];
		const previousFetch = globalThis.fetch;
		try {
			await mkdir(join(projectDir, "src"), { recursive: true });
			const annotation =
				kind === "environment"
					? { provider: "hobo", option: "env", config: { [key]: secret } }
					: {
							provider: "hobo",
							option: "dependency",
							config: {
								runtime: "none",
								kind: "external",
								endpoints: { http: `https://user:${secret}@example.test/` },
							},
						};
			const definition = {
				name: "delivery-fixture",
				resources: {
					web: {
						kind: "web",
						name: "web",
						stableId: "web:web",
						declaredAllow: [],
						dependsOn: [],
						annotations: [annotation],
					},
				},
				edges: [],
				requirements: { require: [], prefer: [], runtimes: [], labels: {} },
			};
			await writeFile(
				join(projectDir, "src", "bindle.mjs"),
				`const definition = ${JSON.stringify(definition)}; definition.entrypoint = () => () => () => new Response("ok"); export default definition;\n`,
			);
			initBareMetalYard({ hoboHome });
			process.env[key] = "original-value";
			let error: unknown;
			try {
				const result = await serve({ projectDir, hoboHome, port: 0 });
				await result.close();
			} catch (caught) {
				error = caught;
			}
			expect(String(error)).toMatch(/binding.delivery/i);
			expect(String(error)).not.toContain(secret);
			expect(process.env[key]).toBe("original-value");
			expect(globalThis.fetch).toBe(previousFetch);
		} finally {
			if (previousValue === undefined) delete process.env[key];
			else process.env[key] = previousValue;
			await rm(root, { recursive: true, force: true });
		}
	},
);
