/**
 * The PostgreSQL backend catalog: evidence discipline first, then what a
 * realistic request resolves to against the profiles the claims amount to.
 *
 * Nothing here talks to a provider. These tests pin the *shape* of the
 * evidence (every asserted fact has a vendor URL and a date) and the
 * native-versus-fallback split a resolver reports; they cannot and do not
 * prove a vendor's documentation is still true.
 */
import {
	DATA_STORE_OFFERING_IDS,
	type DataStoreOfferingId,
	dataStoreProfileOf,
	matchDataStoreOfferings,
	operatorOwnedOfferings,
	parseDataStoreCatalogEntry,
	parseDataStoreProvider,
	resolveDataStore,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	PARITY_SOURCES,
	POSTGRES_BACKEND_CATALOG,
	POSTGRES_BACKEND_CATALOG_OBSERVED_ON,
	POSTGRES_BACKEND_EXCLUSIONS,
	postgresBackend,
	postgresBackendEvidence,
	postgresBackendProfiles,
} from "../src/index.js";

const REQUIRED_PROVIDERS = [
	"neon-postgres",
	"prisma-postgres",
	"supabase-postgres",
	"pgedge-cloud",
	"planetscale-postgres",
	"azure-postgres-flexible",
	"azure-horizondb",
	"aws-rds-postgres",
	"aws-aurora-postgres",
	"gcp-cloudsql-postgres",
	"gcp-alloydb",
	"self-hosted-postgres",
] as const;

/** Offerings a connection port and a standby policy need answered. */
const CATALOGUED_OFFERINGS: readonly DataStoreOfferingId[] = [
	"sql.relational",
	"sql.transactions",
	"backup.pitr",
	"replica.read",
	"replica.multi-region",
	"write.multi-writer",
	"ha.failover",
	"cdc.stream",
	"replicate.logical-publish",
	"replicate.logical-subscribe",
	"pool.transaction",
	"auth.password",
	"auth.identity-token",
	"tls.public-ca",
];

/** Relational + transactions + PITR + a standby that can be kept current. */
const RELAY_REQUEST = {
	features: [
		"sql.relational",
		"sql.transactions",
		"backup.pitr",
		"replicate.logical-subscribe",
	],
	negotiation: "require",
} as const;

function profile(provider: (typeof REQUIRED_PROVIDERS)[number]) {
	const entry = postgresBackend(provider);
	if (entry === undefined) throw new Error(`no catalog entry for ${provider}`);
	return dataStoreProfileOf(entry);
}

describe("catalog coverage", () => {
	it("names every requested PostgreSQL offering exactly once, with a parseable id", () => {
		const providers = POSTGRES_BACKEND_CATALOG.map((entry) => entry.provider);
		expect([...providers].sort()).toEqual([...REQUIRED_PROVIDERS].sort());
		for (const id of providers) expect(parseDataStoreProvider(id)).toBe(id);
	});

	it("answers the same offering questions for every entry", () => {
		for (const entry of POSTGRES_BACKEND_CATALOG) {
			expect(entry.claims.map((claim) => claim.offering).sort()).toEqual(
				[...CATALOGUED_OFFERINGS].sort(),
			);
		}
		for (const id of CATALOGUED_OFFERINGS) {
			expect(DATA_STORE_OFFERING_IDS).toContain(id);
		}
	});

	it("round-trips every entry through JSON and the core parser", () => {
		for (const entry of POSTGRES_BACKEND_CATALOG) {
			expect(
				parseDataStoreCatalogEntry(JSON.parse(JSON.stringify(entry))),
			).toEqual(entry);
		}
	});

	it("records Aurora DSQL as a sourced exclusion, not as a provider id", () => {
		expect(() => parseDataStoreProvider("aws-aurora-dsql")).toThrow();
		const [dsql] = POSTGRES_BACKEND_EXCLUSIONS;
		expect(dsql?.product).toBe("Amazon Aurora DSQL");
		expect(dsql?.sources.length).toBeGreaterThan(0);
	});
});

describe("evidence discipline", () => {
	const sources = POSTGRES_BACKEND_CATALOG.flatMap((entry) => [
		...entry.stabilitySources,
		...entry.claims.flatMap((claim) => claim.sources),
	]);

	it("gives every asserted claim a vendor URL and an observed-at date", () => {
		for (const entry of POSTGRES_BACKEND_CATALOG) {
			expect(entry.stabilitySources.length).toBeGreaterThan(0);
			for (const claim of entry.claims) {
				const where = `${entry.provider} ${claim.offering}`;
				if (claim.realization === "unknown") {
					expect(claim.detail, where).not.toBe("");
					continue;
				}
				expect(claim.sources.length, where).toBeGreaterThan(0);
			}
		}
		for (const source of sources) {
			expect(new URL(source.url).protocol).toBe("https:");
			expect(source.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
			expect(source.note.length).toBeGreaterThan(10);
		}
	});

	it("dates every source to the one sweep the catalog records", () => {
		expect(new Set(sources.map((source) => source.checkedAt))).toEqual(
			new Set([POSTGRES_BACKEND_CATALOG_OBSERVED_ON]),
		);
	});

	it("cites the vendor's own domain for every managed offering", () => {
		const domains = {
			"neon-postgres": ["neon.com"],
			"prisma-postgres": ["www.prisma.io"],
			"supabase-postgres": ["supabase.com"],
			"pgedge-cloud": ["docs.pgedge.com", "www.pgedge.com"],
			"planetscale-postgres": ["planetscale.com"],
			"azure-postgres-flexible": ["learn.microsoft.com"],
			"azure-horizondb": ["learn.microsoft.com"],
			"aws-rds-postgres": ["docs.aws.amazon.com"],
			"aws-aurora-postgres": ["docs.aws.amazon.com"],
			"gcp-cloudsql-postgres": ["cloud.google.com"],
			"gcp-alloydb": ["cloud.google.com"],
			"self-hosted-postgres": ["www.postgresql.org", "www.pgbouncer.org"],
		};
		for (const provider of REQUIRED_PROVIDERS) {
			const entry = postgresBackend(provider);
			const hosts = [
				...(entry?.stabilitySources ?? []),
				...(entry?.claims ?? []).flatMap((claim) => claim.sources),
			].map((source) => new URL(source.url).host);
			expect(hosts.length, provider).toBeGreaterThan(0);
			for (const host of hosts) expect(domains[provider]).toContain(host);
		}
	});

	it("records no price and no free-tier allowance", () => {
		const text = JSON.stringify(POSTGRES_BACKEND_CATALOG);
		expect(text).not.toMatch(/\$\s?\d|USD|free tier|per month/iu);
	});

	it("counts cited and unknown claims, and never hides an unknown", () => {
		const evidence = postgresBackendEvidence();
		for (const row of evidence) {
			expect(row.evidenced + row.unknown).toBe(CATALOGUED_OFFERINGS.length);
		}
		const unknown = evidence.reduce((sum, row) => sum + row.unknown, 0);
		expect(unknown).toBeGreaterThan(0);
		// A preview product states its status in the vendor's own words.
		const horizon = postgresBackend("azure-horizondb");
		expect(horizon?.stability).toBe("preview");
		expect(horizon?.stabilityBasis).toBe("vendor-stated");
	});

	it("points every Yard-backed entry at a real data.postgres/v1 row", () => {
		const rows = Object.values(PARITY_SOURCES).flatMap((source) =>
			source
				.catalog()
				.bindings.filter((binding) => binding.profile === "data.postgres/v1"),
		);
		const declared = new Set(rows.map((binding) => binding.productId));
		const linked = POSTGRES_BACKEND_CATALOG.filter(
			(entry) => entry.yardProductId !== undefined,
		);
		expect(linked.length).toBeGreaterThan(0);
		for (const entry of linked) {
			expect(declared, entry.provider).toContain(entry.yardProductId);
		}
	});
});

describe("resolving the relay's request", () => {
	it("is fully native where PITR and inbound logical replication are both cited", () => {
		for (const provider of [
			"neon-postgres",
			"planetscale-postgres",
			"azure-postgres-flexible",
			"aws-rds-postgres",
			"gcp-cloudsql-postgres",
		] as const) {
			const match = matchDataStoreOfferings(profile(provider), RELAY_REQUEST);
			expect(match, provider).toEqual({
				kind: "full",
				offerings: RELAY_REQUEST.features,
			});
		}
	});

	it("fails closed where a required offering is unsupported or unknown", () => {
		const expectations = {
			// PITR is announced, not available, at the observed date.
			"prisma-postgres": ["backup.pitr", "replicate.logical-subscribe"],
			// Publisher is cited; subscriber is not.
			"supabase-postgres": ["replicate.logical-subscribe"],
			"aws-aurora-postgres": ["replicate.logical-subscribe"],
			"azure-horizondb": ["replicate.logical-subscribe"],
			"gcp-alloydb": ["replicate.logical-subscribe"],
			"pgedge-cloud": ["backup.pitr", "replicate.logical-subscribe"],
		} as const;
		for (const [provider, missing] of Object.entries(expectations)) {
			const match = matchDataStoreOfferings(
				// SAFETY: keys of `expectations` are catalog provider ids by construction.
				profile(provider as keyof typeof expectations),
				RELAY_REQUEST,
			);
			expect(match.kind, provider).toBe("none");
			if (match.kind === "none") expect(match.missing).toEqual(missing);
		}
	});

	it("resolves self-hosted with PITR on the operator's side of the split", () => {
		const selfHosted = profile("self-hosted-postgres");
		const match = matchDataStoreOfferings(selfHosted, RELAY_REQUEST);
		expect(match).toEqual({
			kind: "partial",
			offerings: RELAY_REQUEST.features,
			missing: [],
			fallbacks: ["backup.pitr"],
		});
		const entry = postgresBackend("self-hosted-postgres");
		expect(entry?.management).toBe("self-hosted");
		// What a managed service would provide and the operator now owns.
		expect(entry === undefined ? [] : operatorOwnedOfferings(entry)).toEqual([
			"backup.pitr",
			"replica.read",
			"replica.multi-region",
			"ha.failover",
			"pool.transaction",
			"tls.public-ca",
		]);
		expect(selfHosted.offerings.map((offering) => offering.id)).toEqual([
			"sql.relational",
			"sql.transactions",
			"cdc.stream",
			"replicate.logical-publish",
			"replicate.logical-subscribe",
			"auth.password",
		]);
	});

	it("resolves the whole catalog to the first backend that satisfies the request", () => {
		const resolved = resolveDataStore(postgresBackendProfiles(), RELAY_REQUEST);
		expect(resolved.kind).toBe("resolved");
		if (resolved.kind !== "resolved") return;
		expect(resolved.provider).toBe("neon-postgres");
		expect(resolved.match.kind).toBe("full");
	});

	it("separates identity-token auth and multi-writer from the rest", () => {
		const offering = (id: DataStoreOfferingId) =>
			postgresBackendProfiles()
				.filter((entry) => entry.offerings.some((o) => o.id === id))
				.map((entry) => entry.provider);
		expect(offering("auth.identity-token")).toEqual([
			"azure-postgres-flexible",
			"aws-rds-postgres",
			"aws-aurora-postgres",
			"gcp-cloudsql-postgres",
			"gcp-alloydb",
		]);
		expect(offering("write.multi-writer")).toEqual(["pgedge-cloud"]);
		expect(offering("tls.public-ca")).toEqual([
			"neon-postgres",
			"planetscale-postgres",
			"azure-postgres-flexible",
		]);
	});

	it("offers a preview product's native claims as preview", () => {
		const horizon = profile("azure-horizondb");
		expect(horizon.offerings.length).toBeGreaterThan(0);
		for (const offering of horizon.offerings) {
			expect(offering.stability).toBe("preview");
		}
	});
});
