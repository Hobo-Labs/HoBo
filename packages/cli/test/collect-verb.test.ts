import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type CollectionContext,
	type CollectionTarget,
	collectBindleManifest,
	serializeManifest,
} from "@hobo/bindles";
import { describe, expect, it } from "vitest";

import {
	COLLECT_GOLDEN_FILE,
	createCollectCommand,
	createHoboCli,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

// S1-20: `hobo collect` runs run-to-collect on the project Bindle and prints /
// emits the manifest IR, with --check failing on drift against the committed
// golden.

const COMPONENT_HOST = { kind: "wasmtime", version: "46.0.1" } as const;

function helloTarget(): CollectionTarget {
	return {
		bindleId: "hello-bindle",
		componentHost: COMPONENT_HOST,
		define(collect: CollectionContext) {
			const db = collect.data("db", { paradigm: "relational" });
			collect.service("api", {
				image: "oci://registry.example.com/api@sha256:abc123",
				bind: { db },
			});
		},
	};
}

async function withProject(
	callback: (cwd: string) => Promise<void>,
	golden?: JsonValue,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-collect-"));
	// A minimal project marker so the project-scoped verb resolves a projectDir.
	await writeFile(path.join(dir, "hobo.bindle.json"), "{}\n");
	if (golden !== undefined) {
		await writeFile(
			path.join(dir, COLLECT_GOLDEN_FILE),
			`${JSON.stringify(golden, null, 2)}\n`,
		);
	}
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("hobo collect prints the manifest IR", () => {
	it("emits the manifest IR JSON envelope with the collected hash", async () => {
		await withProject(async (cwd) => {
			const cli = createHoboCli({
				commands: { collect: createCollectCommand({ target: helloTarget() }) },
			});
			const result = await cli.run(["collect", "--json"], { cwd });

			expect(result.exitCode).toBe(0);
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				verb: string;
				status: string;
				data: {
					manifestHash: string;
					resources: string[];
					binds: string[];
					manifest: { schema: string; resources: JsonObject };
					events: Array<{ type: string }>;
				};
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.verb).toBe("collect");
			expect(envelope.data.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(envelope.data.resources).toEqual(["api", "db"]);
			expect(envelope.data.binds).toEqual(["api.db"]);
			expect(envelope.data.manifest.schema).toBe("hobo.manifest/v1");
			expect(envelope.data.events.map((e) => e.type)).toEqual([
				"bindle.ResourcesCollected",
				"bindle.ManifestProduced",
			]);
		});
	});

	it("renders the manifest IR in human output", async () => {
		await withProject(async (cwd) => {
			const cli = createHoboCli({
				commands: { collect: createCollectCommand({ target: helloTarget() }) },
			});
			const result = await cli.run(["collect"], { cwd });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("hash: sha256:");
			expect(result.stdout).toContain('"type": "component.v1"');
		});
	});

	it("falls back to the shell stub when no target is injected", async () => {
		await withProject(async (cwd) => {
			const result = await createHoboCli().run(["collect", "--json"], { cwd });
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				status: string;
				code: string;
			};
			expect(envelope.status).toBe("not_implemented");
			expect(envelope.code).toBe("HOBO_CLI_STUB");
		});
	});
});

describe("hobo collect --check enforces the golden manifest", () => {
	it("passes when the collected IR matches the golden", async () => {
		const golden = JSON.parse(
			serializeManifest(collectBindleManifest(helloTarget()).manifest),
		);
		await withProject(async (cwd) => {
			const cli = createHoboCli({
				commands: { collect: createCollectCommand({ target: helloTarget() }) },
			});
			const result = await cli.run(["collect", "--check", "--json"], { cwd });

			expect(result.exitCode).toBe(0);
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				data: { checked: boolean };
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.data.checked).toBe(true);
		}, golden);
	});

	it("fails with HOBO_COLLECT_DRIFT when the golden diverges", async () => {
		const drifted = {
			schema: "hobo.manifest/v1",
			componentHost: COMPONENT_HOST,
			resources: {
				db: { type: "data.v1", port: "hobo:data", paradigm: "document" },
			},
		};
		await withProject(async (cwd) => {
			const cli = createHoboCli({
				commands: { collect: createCollectCommand({ target: helloTarget() }) },
			});
			const result = await cli.run(["collect", "--check", "--json"], { cwd });

			expect(result.exitCode).toBe(1);
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				code: string;
				data: { goldenHash: string; manifestHash: string };
			};
			expect(envelope.ok).toBe(false);
			expect(envelope.code).toBe("HOBO_COLLECT_DRIFT");
			expect(envelope.data.goldenHash).not.toBe(envelope.data.manifestHash);
		}, drifted);
	});

	it("fails with HOBO_COLLECT_NO_GOLDEN when no golden is committed", async () => {
		await withProject(async (cwd) => {
			const cli = createHoboCli({
				commands: { collect: createCollectCommand({ target: helloTarget() }) },
			});
			const result = await cli.run(["collect", "--check", "--json"], { cwd });

			expect(result.exitCode).toBe(1);
			// SAFETY: `const envelope = JSON.parse(result.stdout) as { code: string };` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as { code: string };
			expect(envelope.code).toBe("HOBO_COLLECT_NO_GOLDEN");
		});
	});
});
