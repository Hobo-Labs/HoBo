import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectStream } from "@hobo/cloud";
import { PRICING_EVENT_CONTRACTS, validateEventBody } from "@hobo/events";
import { catalogHashOf } from "@hobo/pricing";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { REGISTRY_STREAM } from "../src/add-command.js";
import {
	catalogRegisteredFact,
	createComposedHoboCli,
	createDefaultYardRuntime,
	readStoredCatalog,
	storedCatalogs,
} from "../src/index.js";

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

describe("hobo registry add: pricing catalog persistence", () => {
	async function stream(runtime: ReturnType<typeof cli>["runtime"]) {
		return collectStream(runtime.store, REGISTRY_STREAM);
	}

	it("appends the catalog beside the registration, in one append", async () => {
		const { run, runtime } = cli();
		const first = await run("registry", "add", MANIFEST);
		expect(first.data.pricingCatalog).toMatchObject({
			persisted: true,
			appended: true,
			status: "added",
		});

		const events = await stream(runtime);
		expect(events.map((event) => event.type)).toEqual([
			"provider.Registered",
			"pricing.CatalogRegistered",
		]);
		// Same append, so the registration never exists without its prices.
		expect(events[0]?.seq).toBe(
			events[1]?.seq === undefined ? -1 : events[1].seq - 1,
		);
	});

	it("rebuilds the exact catalog from the stream", async () => {
		const { run, runtime } = cli();
		const first = await run("registry", "add", MANIFEST);
		const read = readStoredCatalog(await stream(runtime), "acme-cloud");
		if (!read.ok) throw new Error(read.reason);
		expect(read.catalog.catalogHash).toBe(first.data.pricingCatalogHash);
		expect(catalogHashOf(read.catalog)).toBe(read.catalog.catalogHash);
		expect(read.catalog.products.map((product) => product.id)).toEqual([
			"acme-cloud/gpu-a1",
			"acme-cloud/pg-flex",
			"acme-cloud/llm-large",
			"acme-cloud/print-farm",
		]);
		// The unrated plan has no rate card, and that survives persistence.
		expect(
			read.catalog.rateCards.some((card) => card.id.includes("/spot@")),
		).toBe(false);
	});

	it("does not append again on approval or on a repeat run", async () => {
		const { run, runtime } = cli();
		await run("registry", "add", MANIFEST);
		await run("registry", "add", MANIFEST);
		await run("registry", "add", MANIFEST);
		const types = (await stream(runtime)).map((event) => event.type);
		expect(
			types.filter((type) => type === "pricing.CatalogRegistered"),
		).toHaveLength(1);
		expect(types).toContain("provider.Approved");
	});

	it("backfills a provider registered before catalogs were stored", async () => {
		const { run, runtime } = cli();
		await run("registry", "add", MANIFEST);
		await run("registry", "add", MANIFEST);
		// Simulate the older stream: registration + approval, no catalog fact.
		const full = await stream(runtime);
		expect(
			full.some((event) => event.type === "pricing.CatalogRegistered"),
		).toBe(true);

		const legacy = cli();
		const registered = full.find(
			(event) => event.type === "provider.Registered",
		);
		const approved = full.find((event) => event.type === "provider.Approved");
		if (!registered || !approved) throw new Error("missing facts");
		await legacy.runtime.store.append(
			REGISTRY_STREAM,
			[
				{ type: registered.type, data: registered.data },
				{ type: approved.type, data: approved.data },
			],
			{
				expectedSeq: 0,
				actor: { kind: "system", id: "yard/registry" },
				tenant: "default",
			},
		);
		expect(storedCatalogs(await stream(legacy.runtime)).size).toBe(0);

		const result = await legacy.run("registry", "add", MANIFEST);
		expect(result.status).toBe("updated");
		expect(result.data.pricingCatalog).toMatchObject({
			appended: true,
			status: "added",
		});
		// Same registration, so only the catalog was missing.
		expect(result.data.registration).toEqual({ refreshed: false });
		expect(storedCatalogs(await stream(legacy.runtime)).has("acme-cloud")).toBe(
			true,
		);
	});

	it("stores nothing for a manifest that declares no billing", async () => {
		const { run, runtime } = cli();
		const file = tempManifest(
			"no-billing.yaml",
			"schema: hobo.provider-manifest/v1\nprovider: { id: free-host, displayName: Free Host }\ncapabilities:\n  regions: [r]\n  mappings:\n    - { id: kv, port: kv, providerService: free.kv }\n",
		);
		const result = await run("registry", "add", file);
		expect(result.data.pricingCatalog).toMatchObject({
			persisted: false,
			appended: false,
			status: "none",
		});
		expect((await stream(runtime)).map((event) => event.type)).toEqual([
			"provider.Registered",
		]);
	});

	it("lists the stored catalog hash on installed providers", async () => {
		const { run } = cli();
		const added = await run("registry", "add", MANIFEST);
		const listed = await run("registry");
		expect(listed.data.providers).toContainEqual(
			expect.objectContaining({
				providerId: "acme-cloud",
				pricingCatalogHash: added.data.pricingCatalogHash,
			}),
		);
		expect(
			listed.data.providers.filter(
				(provider: { source: string; pricingCatalogHash?: string }) =>
					provider.source === "base" &&
					provider.pricingCatalogHash !== undefined,
			),
		).toEqual([]);
	});
});

describe("pricing catalog fact", () => {
	it("conforms to the pinned pricing.CatalogRegistered event contract", async () => {
		const { run, runtime } = cli();
		await run("registry", "add", MANIFEST);
		const fact = (await collectStream(runtime.store, REGISTRY_STREAM)).find(
			(event) => event.type === "pricing.CatalogRegistered",
		);
		const contract = PRICING_EVENT_CONTRACTS.find(
			(candidate) => candidate.type === "pricing.CatalogRegistered",
		);
		const schema = contract?.schemas.at(-1);
		if (!fact || !schema) throw new Error("fact or contract missing");
		// SAFETY: the fact body is the string-field record the contract describes.
		expect(
			validateEventBody(schema, fact.data as Record<string, string>),
		).toEqual({
			ok: true,
			errors: [],
		});
	});

	it("is deterministic for a fixed time", async () => {
		const { run, runtime } = cli();
		await run("registry", "add", MANIFEST);
		const stored = readStoredCatalog(
			await collectStream(runtime.store, REGISTRY_STREAM),
			"acme-cloud",
		);
		if (!stored.ok) throw new Error(stored.reason);
		const at = "2026-11-10T00:00:00Z";
		expect(catalogRegisteredFact("acme-cloud", stored.catalog, at)).toEqual(
			catalogRegisteredFact("acme-cloud", stored.catalog, at),
		);
	});

	it("fails closed on a tampered or undecodable body", async () => {
		const { run, runtime } = cli();
		await run("registry", "add", MANIFEST);
		const events = await collectStream(runtime.store, REGISTRY_STREAM);
		const fact = events.find(
			(event) => event.type === "pricing.CatalogRegistered",
		);
		if (!fact) throw new Error("no catalog fact");
		// SAFETY: the fact body is the string-field record the contract describes.
		const body = fact.data as Record<string, string>;

		const edited = body.catalogJson?.replace('"0.0005"', '"0.0001"') ?? "";
		expect(edited).not.toBe(body.catalogJson);
		const tampered = readStoredCatalog(
			[{ type: fact.type, data: { ...body, catalogJson: edited } }],
			"acme-cloud",
		);
		expect(tampered).toEqual({
			ok: false,
			reason: expect.stringContaining("does not match its recorded hash"),
		});

		const garbage = readStoredCatalog(
			[{ type: fact.type, data: { ...body, catalogJson: "{not json" } }],
			"acme-cloud",
		);
		expect(garbage).toEqual({
			ok: false,
			reason: expect.stringContaining("does not decode"),
		});
		expect(readStoredCatalog([], "acme-cloud")).toEqual({
			ok: false,
			reason: "no pricing catalog stored for acme-cloud",
		});
	});
});

describe("hobo registry add: refreshing when the manifest's prices change", () => {
	const MANIFEST_TEXT = readFileSync(MANIFEST, "utf8");
	const OLD_RATE = "package: { per: 3600, amount: 1.80 }";
	const NEW_RATE = "package: { per: 3600, amount: 2.16 }";

	// Copy the example (and the spec it references) beside an edited manifest.
	function edited(replace: (text: string) => string): string {
		const dir = mkdtempSync(join(tmpdir(), "hobo-registry-add-"));
		const file = join(dir, "acme.provider.yaml");
		writeFileSync(file, replace(MANIFEST_TEXT));
		writeFileSync(
			join(dir, "petstore.openapi.yaml"),
			readFileSync(join(dirname(MANIFEST), "petstore.openapi.yaml")),
		);
		return file;
	}

	async function catalogFacts(runtime: ReturnType<typeof cli>["runtime"]) {
		return (await collectStream(runtime.store, REGISTRY_STREAM)).filter(
			(event) => event.type === "pricing.CatalogRegistered",
		);
	}

	function gpuRate(runtime: ReturnType<typeof cli>["runtime"]) {
		return runtime.registry
			.definitions()
			.find(
				(definition) =>
					definition.providerId === "acme-cloud" &&
					definition.port === "compute",
			)?.cost.marginalPrice;
	}

	it("stores the new catalog and re-ranks, keeping approval", async () => {
		const { run, runtime } = cli();
		const original = await run("registry", "add", MANIFEST);
		await run("registry", "add", MANIFEST);
		expect(gpuRate(runtime)).toBe("0.0005");

		const updated = edited((text) => {
			expect(text).toContain(OLD_RATE);
			return text.replace(OLD_RATE, NEW_RATE);
		});
		const result = await run("registry", "add", updated);

		expect(result.ok).toBe(true);
		expect(result.status).toBe("updated");
		expect(result.data.approved).toBe(true);
		expect(result.data.pricingCatalog).toMatchObject({
			appended: true,
			status: "updated",
			previousHash: original.data.pricingCatalogHash,
		});
		expect(result.data.pricingCatalogHash).not.toBe(
			original.data.pricingCatalogHash,
		);
		// The ranking price rides the registration, so it moved with the catalog.
		expect(result.data.registration).toEqual({ refreshed: true });
		expect(gpuRate(runtime)).toBe("0.0006");
		expect(runtime.registry.providers()).toContain("acme-cloud");
	});

	it("appends rather than rewrites, and reads back the latest", async () => {
		const { run, runtime } = cli();
		const original = await run("registry", "add", MANIFEST);
		await run(
			"registry",
			"add",
			edited((text) => text.replace(OLD_RATE, NEW_RATE)),
		);

		const facts = await catalogFacts(runtime);
		expect(facts).toHaveLength(2);
		// SAFETY: catalog fact bodies are string-field records (see the contract).
		const hashes = facts.map(
			(fact) => (fact.data as Record<string, string>).catalogHash,
		);
		expect(hashes[0]).toBe(original.data.pricingCatalogHash);
		expect(hashes[1]).not.toBe(hashes[0]);

		const read = readStoredCatalog(
			await collectStream(runtime.store, REGISTRY_STREAM),
			"acme-cloud",
		);
		if (!read.ok) throw new Error(read.reason);
		expect(read.catalog.catalogHash).toBe(hashes[1]);
		const card = read.catalog.rateCards.find((c) =>
			c.id.includes("gpu-a1/on-demand"),
		);
		const charge = card?.charges[0]?.variant;
		expect(
			charge?.case === "usage" &&
				charge.value.price.case === "perUnit" &&
				charge.value.price.value.decimal,
		).toBe("0.0006");
	});

	it("does nothing when the manifest has not changed", async () => {
		const { run, runtime } = cli();
		await run("registry", "add", MANIFEST);
		await run("registry", "add", MANIFEST);
		const before = (await collectStream(runtime.store, REGISTRY_STREAM)).length;

		const again = await run("registry", "add", MANIFEST);
		expect(again.status).toBe("already_installed");
		expect(again.data.pricingCatalog).toMatchObject({
			appended: false,
			status: "unchanged",
		});
		expect(again.data.registration).toEqual({ refreshed: false });
		expect((await collectStream(runtime.store, REGISTRY_STREAM)).length).toBe(
			before,
		);
	});

	it("refreshes a held provider without approving it", async () => {
		const { run, runtime } = cli();
		await run("registry", "add", MANIFEST); // registered, held
		const result = await run(
			"registry",
			"add",
			edited((text) => text.replace(OLD_RATE, NEW_RATE)),
		);
		// A second run is the approval step; it also carries the new prices.
		expect(result.status).toBe("approved");
		expect(result.data.pricingCatalog).toMatchObject({ status: "updated" });
		expect(gpuRate(runtime)).toBe("0.0006");
	});

	it("re-registers without a new catalog when only capabilities change", async () => {
		const { run, runtime } = cli();
		await run("registry", "add", MANIFEST);
		await run("registry", "add", MANIFEST);
		const result = await run(
			"registry",
			"add",
			edited((text) =>
				text.replace(
					"features: [managed, ha]",
					"features: [managed, ha, vector]",
				),
			),
		);
		expect(result.status).toBe("updated");
		expect(result.data.pricingCatalog).toMatchObject({
			appended: false,
			status: "unchanged",
		});
		expect(result.data.registration).toEqual({ refreshed: true });
		expect(await catalogFacts(runtime)).toHaveLength(1);
		expect(
			runtime.registry
				.definitions()
				.find((d) => d.providerId === "acme-cloud" && d.port === "database")
				?.features,
		).toEqual(["managed", "ha", "vector"]);
	});

	it("keeps the stored catalog when a manifest drops its billing section", async () => {
		const { run, runtime } = cli();
		await run("registry", "add", MANIFEST);
		await run("registry", "add", MANIFEST);
		const noBilling = edited((text) =>
			text
				.slice(0, text.indexOf("\nbilling:"))
				// Mappings may only name products that billing declares.
				.replace(/^ +products: \[[^\]]*\]\n/gm, ""),
		);
		const result = await run("registry", "add", noBilling);
		expect(result.data.pricingCatalog).toMatchObject({
			persisted: false,
			status: "none",
		});
		// Append-only: there is no "cleared" fact yet, so the last catalog stays.
		expect(await catalogFacts(runtime)).toHaveLength(1);
	});
});

describe("hobo registry add: only manifest registrations are refreshable", () => {
	function manifestFor(id: string): string {
		return tempManifest(
			`${id}.yaml`,
			`schema: hobo.provider-manifest/v1\nprovider: { id: ${id}, displayName: X }\ncapabilities:\n  regions: [r]\n  mappings:\n    - { id: kv, port: kv, providerService: x.kv }\n`,
		);
	}

	it("refuses to replace a provider installed with `hobo add`", async () => {
		const { run, runtime } = cli();
		const added = await run("add", "local");
		expect(added.status).toBe("installed");
		const ports = (id: string) =>
			runtime.registry
				.definitions()
				.filter((definition) => definition.providerId === id)
				.map((definition) => definition.port)
				.sort();
		const before = ports("local");
		expect(before.length).toBeGreaterThan(1);

		const result = await run("registry", "add", manifestFor("local"));
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_REGISTRY_ADD_CONFLICT");
		expect(result.message).toContain("another route");
		// Untouched: same definitions, same stream.
		expect(ports("local")).toEqual(before);
		expect(
			(await collectStream(runtime.store, REGISTRY_STREAM)).filter(
				(event) => event.type === "provider.Registered",
			),
		).toHaveLength(1);
	});

	it("still refreshes its own registrations", async () => {
		const { run } = cli();
		const file = manifestFor("mine");
		await run("registry", "add", file);
		await run("registry", "add", file);
		const again = await run("registry", "add", file);
		expect(again.status).toBe("already_installed");
	});

	it("stamps the registration with its source", async () => {
		const { run, runtime } = cli();
		await run("registry", "add", manifestFor("stamped"));
		const registered = (
			await collectStream(runtime.store, REGISTRY_STREAM)
		).find((event) => event.type === "provider.Registered");
		if (registered === undefined) throw new Error("no registration fact");
		// SAFETY: registration bodies are JSON objects.
		const body = registered.data as { source?: string };
		expect(body.source).toBe("provider-manifest/v1");
	});
});
