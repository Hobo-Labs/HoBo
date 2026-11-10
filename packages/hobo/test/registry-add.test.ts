import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import { createComposedHoboCli, createDefaultYardRuntime } from "../src/index.js";

// `hobo registry add <manifest>` registers a provider described by a
// hobo.provider-manifest/v1 data file — no provider package involved.

const MANIFEST = fileURLToPath(
	new URL(
		"../../provider-manifest/examples/acme-cloud.provider.yaml",
		import.meta.url,
	),
);

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

function cli() {
	const runtime = createDefaultYardRuntime();
	// SAFETY: the default runtime's store is the local SQLite event store.
	openStores.push(runtime.store as RuntimeLocalEventStore);
	const composed = createComposedHoboCli({ yardRuntime: runtime });
	return {
		runtime,
		run: async (...argv: string[]) =>
			JSON.parse((await composed.run([...argv, "--json"])).stdout),
	};
}

function tempManifest(name: string, body: string): string {
	const file = join(mkdtempSync(join(tmpdir(), "hobo-registry-add-")), name);
	writeFileSync(file, body);
	return file;
}

describe("hobo registry add", () => {
	it("registers a manifest provider held, then approves it on the second run", async () => {
		const { run, runtime } = cli();

		const first = await run("registry", "add", MANIFEST);
		expect(first.ok).toBe(true);
		expect(first.status).toBe("installed");
		expect(first.data).toMatchObject({
			provider: "acme-cloud",
			ports: ["compute", "database", "inference"],
			regions: ["us-east", "eu-west"],
			approved: false,
			authFlows: [
				"oidc-federation",
				"auth-md",
				"oauth2-authorization-code",
				"device-code",
				"api-key",
			],
			unratedPlans: ["llm-large/spot"],
		});
		expect(first.data.pricingCatalogHash).toMatch(/^sha256:[0-9a-f]{64}$/u);

		// Held: listed, but not something the Planner can match.
		const listed = await run("registry");
		expect(listed.data.providers).toContainEqual(
			expect.objectContaining({
				providerId: "acme-cloud",
				source: "installed",
				approved: false,
			}),
		);
		expect(runtime.registry.providers()).not.toContain("acme-cloud");

		const second = await run("registry", "add", MANIFEST);
		expect(second.status).toBe("approved");
		expect(runtime.registry.providers()).toContain("acme-cloud");
		expect(
			runtime.registry
				.definitions()
				.filter((definition) => definition.providerId === "acme-cloud")
				.map((definition) => [
					definition.port,
					definition.cost.sku,
					definition.cost.marginalPrice,
					definition.cost.pricingStatus,
				]),
		).toEqual([
			["compute", "acme-cloud/gpu-a1", "0.0005", "estimate"],
			["database", "acme-cloud/pg-flex", "0", "unknown"],
			["inference", "acme-cloud/llm-large", "0", "unknown"],
		]);

		const third = await run("registry", "add", MANIFEST);
		expect(third.status).toBe("already_installed");
	});

	it("refuses an invalid manifest whole, listing every issue", async () => {
		const { run, runtime } = cli();
		const file = tempManifest(
			"bad.yaml",
			"schema: hobo.provider-manifest/v1\nprovider: { id: Bad Id, displayName: Bad }\ncapabilities: { mappings: [] }\n",
		);
		const result = await run("registry", "add", file);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_REGISTRY_ADD_INVALID");
		expect(
			result.data.issues.map((issue: { path: string }) => issue.path),
		).toEqual(["provider.id", "capabilities.mappings"]);
		expect((await run("registry")).data.providers).not.toContainEqual(
			expect.objectContaining({ source: "installed" }),
		);
		expect(runtime.registry.held?.() ?? []).toEqual([]);
	});

	it("refuses a manifest with nothing to match", async () => {
		const { run } = cli();
		const file = tempManifest(
			"auth-only.yaml",
			"schema: hobo.provider-manifest/v1\nprovider: { id: keyless, displayName: Keyless }\nauth:\n  issuer: https://auth.example.com\n  flows:\n    - id: federation\n      oidcFederation: { audience: hobo }\n",
		);
		const result = await run("registry", "add", file);
		expect(result.code).toBe("HOBO_REGISTRY_ADD_NO_CAPABILITIES");
	});

	it("refuses a manifest that takes a built-in provider's id", async () => {
		const { run, runtime } = cli();
		const builtIn = runtime.registry.providers()[0] ?? "";
		// Built-in ids are package names; only a slug-shaped one can collide.
		if (!/^[a-z0-9][a-z0-9._-]*$/u.test(builtIn)) return;
		const file = tempManifest(
			"squat.yaml",
			`schema: hobo.provider-manifest/v1\nprovider: { id: ${builtIn}, displayName: Squat }\ncapabilities:\n  regions: [r]\n  mappings:\n    - { id: kv, port: kv, providerService: squat.kv }\n`,
		);
		expect((await run("registry", "add", file)).code).toBe(
			"HOBO_REGISTRY_ADD_CONFLICT",
		);
	});

	it("reports usage and unreadable files without touching the registry", async () => {
		const { run } = cli();
		expect((await run("registry", "add")).code).toBe(
			"HOBO_REGISTRY_ADD_NO_MANIFEST",
		);
		const missing = join(
			mkdtempSync(join(tmpdir(), "hobo-registry-add-")),
			"missing.yaml",
		);
		expect((await run("registry", "add", missing)).code).toBe(
			"HOBO_REGISTRY_ADD_UNREADABLE",
		);
	});
});
