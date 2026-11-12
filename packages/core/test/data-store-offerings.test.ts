// First non-routing vocabulary bound to the generic per-resource-class
// resolver: data-store offerings negotiate exactly like traffic routing.
import assert from "node:assert/strict";
import { test } from "vitest";

import {
	DATA_STORE_ENGINES,
	DATA_STORE_OFFERING_IDS,
	DATA_STORE_PROVIDER_FAMILIES,
	DATA_STORE_PROVIDERS,
	type DataStoreProviderProfile,
	dataStoreOffering,
	engineOfDataStoreProvider,
	matchDataStoreOfferings,
	parseDataStoreOfferingId,
	parseDataStoreProvider,
	parseDataStoreProviderProfile,
	resolveDataStore,
} from "../src/ports/data-store-offerings.js";

function sqliteProfile(): DataStoreProviderProfile {
	return parseDataStoreProviderProfile({
		provider: "sqlite-local",
		offerings: [
			{
				id: "sql.relational",
				stability: "stable",
				fidelity: "real",
				features: [],
			},
			{
				id: "sql.transactions",
				stability: "stable",
				fidelity: "real",
				features: [],
			},
			{
				id: "journal.event-stream",
				stability: "stable",
				fidelity: "real",
				features: [],
			},
		],
		fallbacks: ["cdc.stream", "migrate.dual-write"],
	});
}

test("parse rejects unknown offering ids at the boundary", () => {
	assert.throws(
		() =>
			parseDataStoreProviderProfile({
				provider: "sqlite-local",
				offerings: [{ id: "sql.mystery" }],
			}),
		/offerings\[0\]\.id/u,
	);
});

test("prefer negotiation covers a missing native offering from the fallback ladder", () => {
	const match = matchDataStoreOfferings(sqliteProfile(), {
		features: ["sql.relational", "cdc.stream"],
		negotiation: "prefer",
	});
	assert.equal(match.kind, "partial");
	if (match.kind !== "partial") return;
	assert.deepEqual(match.offerings, ["sql.relational", "cdc.stream"]);
	assert.deepEqual(match.fallbacks, ["cdc.stream"]);
});

test("require negotiation fails closed on an offering outside native + fallbacks", () => {
	const match = matchDataStoreOfferings(sqliteProfile(), {
		features: ["replica.read"],
		negotiation: "require",
	});
	assert.equal(match.kind, "none");
	if (match.kind !== "none") return;
	assert.match(match.remediation, /data-store offerings: replica\.read/u);
});

test("resolve picks the first profile that satisfies the request", () => {
	const supabase = parseDataStoreProviderProfile({
		provider: "supabase-postgres",
		offerings: [
			{ id: "sql.relational" },
			{ id: "sql.transactions" },
			{ id: "replica.read" },
			{ id: "backup.pitr" },
		],
	});
	const resolved = resolveDataStore([sqliteProfile(), supabase], {
		features: ["sql.relational", "replica.read"],
		negotiation: "require",
	});
	assert.equal(resolved.kind, "resolved");
	if (resolved.kind !== "resolved") return;
	assert.equal(resolved.provider, "supabase-postgres");
	assert.deepEqual(resolved.strategy, ["sql.relational", "replica.read"]);
});

test("resolve reports the default missing offering when nothing is registered", () => {
	const resolved = resolveDataStore([]);
	assert.equal(resolved.kind, "unresolved");
	if (resolved.kind !== "unresolved") return;
	assert.deepEqual(resolved.missing, ["sql.relational"]);
	assert.match(resolved.remediation, /no data-store provider profiles/u);
});

test("dataStoreOffering helper defaults to stable + real", () => {
	const entry = dataStoreOffering("kv.point");
	assert.equal(entry.stability, "stable");
	assert.equal(entry.fidelity, "real");
});

test("an engine is a different fact from a product (ADR-0177)", () => {
	assert.equal(engineOfDataStoreProvider("sqlite-local"), "sqlite");
	// D1 speaks SQLite: it must never be mistaken for a Postgres.
	assert.equal(engineOfDataStoreProvider("cloudflare-d1"), "sqlite");
	assert.equal(engineOfDataStoreProvider("supabase-postgres"), "postgres");
	assert.equal(engineOfDataStoreProvider("azure-sql"), "sqlserver");
});

test("a product that hosts several engines does not get one guessed for it", () => {
	assert.equal(engineOfDataStoreProvider("aws-rds"), "other");
	assert.equal(engineOfDataStoreProvider("gcp-cloudsql"), "other");
	assert.equal(engineOfDataStoreProvider("other"), "other");
});

test("every product-level PostgreSQL id is the postgres engine; a family id stays undetermined", () => {
	for (const provider of DATA_STORE_PROVIDERS) {
		const family = provider === "aws-rds" || provider === "gcp-cloudsql";
		const product =
			provider.includes("postgres") ||
			provider === "pgedge-cloud" ||
			provider === "azure-horizondb" ||
			provider === "gcp-alloydb";
		if (family) assert.equal(engineOfDataStoreProvider(provider), "other");
		if (product) assert.equal(engineOfDataStoreProvider(provider), "postgres");
	}
	// A product refines its family; the engine is known for the product only.
	assert.equal(engineOfDataStoreProvider("aws-rds-postgres"), "postgres");
	assert.equal(engineOfDataStoreProvider("aws-rds"), "other");
});

test("the engine vocabulary is closed", () => {
	assert.deepEqual(
		[...DATA_STORE_ENGINES],
		["sqlite", "postgres", "sqlserver", "mysql", "mongodb", "other"],
	);
});
// --- vocabulary extension: product-level PostgreSQL ids + connection facts ---

const ORIGINAL_PROVIDERS = [
	"sqlite-local",
	"cloudflare-d1",
	"supabase-postgres",
	"aws-rds",
	"gcp-cloudsql",
	"azure-sql",
	"other",
] as const;

const ORIGINAL_OFFERINGS = [
	"sql.relational",
	"sql.transactions",
	"kv.point",
	"blob.object",
	"journal.event-stream",
	"cdc.stream",
	"replica.read",
	"backup.pitr",
	"migrate.dual-write",
	"observe.lag",
] as const;

test("every original provider and offering id still parses unchanged", () => {
	for (const id of ORIGINAL_PROVIDERS) {
		assert.equal(parseDataStoreProvider(id), id);
	}
	for (const id of ORIGINAL_OFFERINGS) {
		assert.equal(parseDataStoreOfferingId(id), id);
	}
	// The original ids keep their position: a consumer that indexed the
	// vocabulary by order sees the same prefix it always did.
	assert.deepEqual(
		DATA_STORE_OFFERING_IDS.slice(0, ORIGINAL_OFFERINGS.length),
		ORIGINAL_OFFERINGS,
	);
	assert.deepEqual(
		DATA_STORE_PROVIDERS.slice(0, ORIGINAL_PROVIDERS.length - 1),
		ORIGINAL_PROVIDERS.slice(0, -1),
	);
});

test("every exported provider and offering id round-trips through its parser", () => {
	for (const id of DATA_STORE_PROVIDERS) {
		assert.equal(parseDataStoreProvider(JSON.parse(JSON.stringify(id))), id);
	}
	for (const id of DATA_STORE_OFFERING_IDS) {
		assert.equal(parseDataStoreOfferingId(JSON.parse(JSON.stringify(id))), id);
	}
	assert.equal(new Set(DATA_STORE_PROVIDERS).size, DATA_STORE_PROVIDERS.length);
	assert.equal(
		new Set(DATA_STORE_OFFERING_IDS).size,
		DATA_STORE_OFFERING_IDS.length,
	);
});

test("product ids are distinct from the family ids they refine", () => {
	assert.throws(() => parseDataStoreProvider("aws"), /provider/u);
	assert.throws(() => parseDataStoreProvider("aws-aurora-dsql"), /provider/u);
	for (const [product, family] of Object.entries(
		DATA_STORE_PROVIDER_FAMILIES,
	)) {
		assert.notEqual(product, family);
		assert.equal(parseDataStoreProvider(product), product);
		assert.equal(parseDataStoreProvider(family), family);
		assert.ok(product.startsWith(`${family}-`));
	}
});

test("a profile written with the new ids survives a JSON round trip", () => {
	const profile = parseDataStoreProviderProfile({
		provider: "aws-aurora-postgres",
		offerings: [
			{ id: "sql.relational" },
			{ id: "auth.identity-token", features: [" iam "] },
			{ id: "replica.multi-region", stability: "preview" },
		],
		fallbacks: ["write.multi-writer"],
	});
	assert.deepEqual(
		parseDataStoreProviderProfile(JSON.parse(JSON.stringify(profile))),
		profile,
	);
	assert.deepEqual(profile.offerings[1]?.features, ["iam"]);
});

test("a legacy family profile matches exactly as before the extension", () => {
	const legacy = parseDataStoreProviderProfile({
		provider: "aws-rds",
		offerings: [{ id: "sql.relational" }, { id: "replica.read" }],
	});
	assert.deepEqual(legacy.fallbacks, [
		"journal.event-stream",
		"cdc.stream",
		"migrate.dual-write",
	]);
	const match = matchDataStoreOfferings(legacy, {
		features: ["sql.relational", "auth.identity-token"],
		negotiation: "require",
	});
	assert.equal(match.kind, "none");
});
