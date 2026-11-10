import {
	MANIFEST_PATHS,
	parsePublishedManifest,
	stableDigest,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	providerFromManifest,
	toCapabilitiesDocument,
	toCapabilityManifest,
	toCostDocument,
} from "../src/index.js";
import { example, mustParse } from "./support/example.js";

describe("toCapabilityManifest", () => {
	it("publishes a bundle @hobo/core accepts", () => {
		const manifest = toCapabilityManifest(example());
		const parsed = parsePublishedManifest(manifest.published);
		expect(parsed.errors).toEqual([]);
		expect(manifest.providerId).toBe("acme-cloud");
	});

	it("indexes each document by the digest of what it published", () => {
		const manifest = toCapabilityManifest(example());
		const index = JSON.parse(manifest.published[MANIFEST_PATHS.index] ?? "");
		expect(index.documents).toEqual([
			expect.objectContaining({
				path: MANIFEST_PATHS.capabilities,
				digest: stableDigest(manifest.capabilities),
			}),
			expect.objectContaining({
				path: MANIFEST_PATHS.auth,
				digest: stableDigest(manifest.auth),
			}),
			expect.objectContaining({
				path: MANIFEST_PATHS.cost,
				digest: stableDigest(manifest.cost),
			}),
		]);
	});
});

describe("toCapabilitiesDocument", () => {
	it("maps each port to its provider service with defaults applied", () => {
		const document = toCapabilitiesDocument(example());
		expect(document.capabilities).toEqual([
			{
				port: "compute",
				interface: "hobo:compute/gpu",
				version: "0.1.0",
				stability: "stable",
				features: ["container", "gpu"],
				regions: ["us-east", "eu-west"],
				resourceClass: "gpu",
				providerService: "acme.gpu.a1",
				profiles: [],
				productId: "acme-cloud/gpu-a1",
			},
			{
				port: "database",
				interface: "hobo:database/postgres",
				version: "0.1.0",
				stability: "preview",
				features: ["managed", "ha"],
				regions: ["us-east", "eu-west"],
				resourceClass: "postgres",
				providerService: "acme.pg.flex",
				profiles: ["data.postgres/v1"],
				productId: "acme-cloud/pg-flex",
			},
			{
				port: "inference",
				interface: "hobo:inference/chat",
				version: "0.1.0",
				stability: "preview",
				features: [],
				regions: ["us-east"],
				resourceClass: "chat",
				providerService: "acme.llm.large",
				profiles: [],
				productId: "acme-cloud/llm-large",
			},
		]);
		expect(document.equivalenceClasses).toContainEqual({
			class: "database/postgres",
			port: "database",
			resourceClass: "postgres",
			providerService: "acme.pg.flex",
			features: ["managed", "ha"],
		});
	});
});

describe("published API locations", () => {
	it("lists specs and MCP servers in capabilities.json", () => {
		expect(toCapabilitiesDocument(example()).apis).toEqual({
			specs: [
				{
					id: "pets",
					format: "openapi",
					auth: ["console-oauth", "agent-registration"],
					path: "petstore.openapi.yaml",
				},
				{
					id: "events",
					format: "asyncapi",
					auth: [],
					url: "https://acme-cloud.example.com/asyncapi.yaml",
				},
			],
			mcpServers: [],
		});
	});
});

describe("providerFromManifest", () => {
	it("registers one capability per port and reports shadowed mappings", () => {
		const manifest = mustParse(`
schema: hobo.provider-manifest/v1
provider: { id: twin, displayName: Twin }
capabilities:
  regions: [r1]
  mappings:
    - { id: db/pg, port: database, providerService: twin.pg, features: [ha] }
    - { id: db/mysql, port: database, providerService: twin.mysql, regions: [r2] }
`);
		const provider = providerFromManifest(manifest);
		expect(provider.id).toBe("twin");
		expect(provider.regions).toEqual(["r1", "r2"]);
		expect(provider.capabilities.map((c) => c.port)).toEqual(["database"]);
		expect(provider.shadowedMappings).toEqual(["db/mysql"]);
		const [database] = provider.capabilities;
		expect(database?.satisfies({ port: "database", features: ["ha"] })).toEqual(
			{ kind: "full" },
		);
		expect(
			database?.satisfies({ port: "database", features: ["ha", "vector"] }),
		).toEqual({ kind: "partial", missing: ["vector"] });
		expect(database?.satisfies({ port: "kv" })).toEqual({ kind: "none" });
		// No billing declared: unknown, which the matcher ranks last.
		expect(database?.estimateCost({ port: "database" })).toEqual({
			marginalPrice: "0",
			sku: "twin:database",
			unit: "",
			pricingStatus: "unknown",
		});
	});

	it("carries declared prices into cost estimates", () => {
		const [compute] = providerFromManifest(example()).capabilities;
		expect(compute?.estimateCost({ port: "compute" })).toEqual({
			marginalPrice: "0.0005",
			sku: "acme-cloud/gpu-a1",
			unit: "second",
			pricingStatus: "estimate",
		});
	});
});

describe("toCostDocument", () => {
	it("emits a ranking price only where one flat rate tells the truth", () => {
		const facts = toCostDocument(example()).facts;
		expect(facts).toEqual([
			expect.objectContaining({
				port: "compute",
				sku: "acme-cloud/gpu-a1",
				unit: "second",
				marginalPrice: "0.0005",
				pricingStatus: "estimate",
			}),
			// Fee + tiers, and a two-meter token plan: no single number is
			// honest, so the legacy ranking sees "unknown" (ranked last).
			expect.objectContaining({ port: "database", pricingStatus: "unknown" }),
			expect.objectContaining({ port: "inference", pricingStatus: "unknown" }),
		]);
	});

	it("carries the source and check date on every fact", () => {
		const facts = toCostDocument(example()).facts;
		expect(facts).toHaveLength(3);
		expect(facts).toEqual(
			[1, 2, 3].map(() =>
				expect.objectContaining({
					source: {
						type: "declared-provider",
						url: "https://acme-cloud.example.com/pricing",
						transcribedOn: "2026-11-10",
					},
				}),
			),
		);
	});
});
