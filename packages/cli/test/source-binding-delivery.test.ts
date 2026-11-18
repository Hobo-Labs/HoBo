import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindle, collectBindleManifest } from "@hobo/bindles";
import { expect, it } from "vitest";
import {
	loadProjectCollectionTarget,
	targetFromBindleDefinition,
} from "../src/cloud/loader.js";
import { createCollectCommand } from "../src/commands/collect.js";
import { createHoboCli } from "../src/shell/dispatch.js";

it("refuses credentials in authored annotations before collection", () => {
	const secret = "fixture-source-secret";
	const definition = bindle("source", (builder) => ({
		web: builder.web().with({
			provider: "hobo",
			option: "env",
			config: { API_KEY: secret },
		}),
	}));
	expect(() => targetFromBindleDefinition(definition)).toThrow(
		/binding.delivery/i,
	);
	try {
		targetFromBindleDefinition(definition);
	} catch (error) {
		expect(String(error)).not.toContain(secret);
	}
});

it("keeps safe resource environment values in the collected manifest", () => {
	const definition = bindle("source", (builder) => ({
		web: builder.web().with({
			provider: "hobo",
			option: "env",
			config: { LOG_LEVEL: "debug", PORT: 3000 },
		}),
	}));
	const { manifest } = collectBindleManifest(
		targetFromBindleDefinition(definition),
	);
	expect(manifest.value.resources.web?.env).toEqual({
		LOG_LEVEL: "debug",
		PORT: "3000",
	});
});

it("keeps safe backing-resource settings and public discovery in the manifest", () => {
	const definition = bindle("source", (builder) => ({
		web: builder.web(),
		cache: builder.kv().with({
			provider: "hobo",
			option: "env",
			config: { CACHE_MODE: "shared" },
		}),
		external: builder.external({
			connectionString: "postgres://db.example.test/app",
			endpoints: { http: "https://service.example.test/" },
		}),
	}));
	const { manifest } = collectBindleManifest(
		targetFromBindleDefinition(definition),
	);
	expect(manifest.value.resources.cache?.env).toEqual({ CACHE_MODE: "shared" });
	expect(manifest.value.resources.external?.connectionString).toBe(
		"postgres://db.example.test/app",
	);
	expect(manifest.value.resources.external?.endpoints).toEqual({
		http: "https://service.example.test/",
	});
});

it("rejects nested endpoint credentials and retains safe structured endpoints", () => {
	const credential = "fixture-nested-credential";
	const unsafeOptions = JSON.parse(
		JSON.stringify({
			image: "example.test/worker:1",
			endpoints: {
				http: { port: 8080, url: `https://user:${credential}@example.test/` },
			},
		}),
	);
	const unsafe = bindle("source", (builder) => ({
		worker: builder.container(unsafeOptions),
	}));
	expect(() => targetFromBindleDefinition(unsafe)).toThrow(/binding.delivery/i);
	try {
		targetFromBindleDefinition(unsafe);
	} catch (error) {
		expect(String(error)).not.toContain(credential);
	}
	const safe = bindle("source", (builder) => ({
		worker: builder.container({
			image: "example.test/worker:1",
			endpoints: { http: { port: 8080, external: true } },
		}),
	}));
	const { manifest } = collectBindleManifest(targetFromBindleDefinition(safe));
	expect(manifest.value.resources.worker?.endpoints).toEqual({
		http: { port: 8080, external: true },
	});
});

it("refuses an unsafe source project through the collect command without leaking its value", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-source-delivery-"));
	try {
		await mkdir(join(root, "src"));
		const definition = {
			name: "fixture",
			resources: {
				web: {
					kind: "web",
					name: "web",
					stableId: "web:web",
					declaredAllow: [],
					dependsOn: [],
					annotations: [
						{
							provider: "hobo",
							option: "env",
							config: { API_KEY: "fixture-collect-secret" },
						},
					],
				},
			},
			edges: [],
			requirements: { require: [], prefer: [], runtimes: [], labels: {} },
		};
		await writeFile(
			join(root, "src", "bindle.mjs"),
			`const definition = ${JSON.stringify(definition)}; definition.entrypoint = () => undefined; export default definition;\n`,
		);
		const cli = createHoboCli({
			commands: {
				collect: createCollectCommand({
					resolveTarget: loadProjectCollectionTarget,
				}),
			},
		});
		const result = await cli.run(["collect", "--json", "--cwd", root], {
			cwd: root,
		});
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_BINDING_DELIVERY",
		});
		expect(result.stdout + result.stderr).not.toContain(
			"fixture-collect-secret",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
