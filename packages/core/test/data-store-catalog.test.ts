// A catalog entry is a profile with its evidence attached: the parser refuses
// an unsourced assertion, and the profile is derived from the claims.
import assert from "node:assert/strict";
import { test } from "vitest";

import {
	dataStoreCatalogEvidence,
	dataStoreProfileOf,
	operatorOwnedOfferings,
	parseDataStoreCatalogClaim,
	parseDataStoreCatalogEntry,
	parseDataStoreClaimSource,
} from "../src/ports/data-store-catalog.js";
import { resolveDataStore } from "../src/ports/data-store-offerings.js";

const source = {
	url: "https://vendor.example/docs/backups",
	checkedAt: "2026-11-10",
	note: "restore to any point in time within the retention period",
};

function entry(overrides = {}) {
	return {
		provider: "self-hosted-postgres",
		vendor: "Example",
		product: "Example Postgres",
		management: "self-hosted",
		stability: "stable",
		stabilityBasis: "inferred",
		stabilitySources: [source],
		claims: [
			{ offering: "sql.relational", realization: "native", sources: [source] },
			{
				offering: "sql.transactions",
				realization: "native",
				sources: [source],
			},
			{
				offering: "backup.pitr",
				realization: "operator",
				detail: "operator runs WAL archiving",
				sources: [source],
			},
			{
				offering: "replica.read",
				realization: "unsupported",
				sources: [source],
			},
			{
				offering: "pool.transaction",
				realization: "unknown",
				detail: "no vendor page on pooling was found",
			},
		],
		...overrides,
	};
}

test("an entry round-trips through JSON to the same parsed value", () => {
	const parsed = parseDataStoreCatalogEntry(entry({ yardProductId: "x.y/v1" }));
	assert.deepEqual(
		parseDataStoreCatalogEntry(JSON.parse(JSON.stringify(parsed))),
		parsed,
	);
	assert.equal(parsed.yardProductId, "x.y/v1");
	assert.ok(Object.isFrozen(parsed.claims));
});

test("a claim that asserts a third-party fact must cite a dated source", () => {
	for (const realization of ["native", "operator", "fallback", "unsupported"]) {
		assert.throws(
			() =>
				parseDataStoreCatalogClaim({ offering: "backup.pitr", realization }),
			/claim\.sources/u,
		);
	}
});

test("an unknown claim may be unsourced but must say what is missing", () => {
	assert.throws(
		() =>
			parseDataStoreCatalogClaim({
				offering: "backup.pitr",
				realization: "unknown",
			}),
		/claim\.detail/u,
	);
	const claim = parseDataStoreCatalogClaim({
		offering: "backup.pitr",
		realization: "unknown",
		detail: "vendor docs do not mention restore",
	});
	assert.deepEqual(claim.sources, []);
});

test("a source needs an https URL and a real calendar date", () => {
	assert.throws(
		() => parseDataStoreClaimSource({ ...source, url: "http://x.example" }),
		/source\.url/u,
	);
	assert.throws(
		() => parseDataStoreClaimSource({ ...source, checkedAt: "Nov 2026" }),
		/source\.checkedAt/u,
	);
	assert.throws(
		() => parseDataStoreClaimSource({ ...source, checkedAt: "2026-13-40" }),
		/source\.checkedAt/u,
	);
	assert.throws(
		() => parseDataStoreClaimSource({ ...source, note: " " }),
		/source\.note/u,
	);
});

test("an entry refuses duplicate offerings, unknown ids, and unsourced stability", () => {
	const duplicate = entry();
	duplicate.claims.push(duplicate.claims[0]);
	assert.throws(() => parseDataStoreCatalogEntry(duplicate), /entry\.claims/u);
	assert.throws(
		() => parseDataStoreCatalogEntry(entry({ provider: "aurora" })),
		/entry\.provider/u,
	);
	assert.throws(
		() => parseDataStoreCatalogEntry(entry({ stabilitySources: [] })),
		/entry\.stabilitySources/u,
	);
	assert.throws(
		() => parseDataStoreCatalogEntry(entry({ management: "hybrid" })),
		/entry\.management/u,
	);
	assert.throws(
		() => parseDataStoreCatalogEntry(entry({ stabilityBasis: "assumed" })),
		/entry\.stabilityBasis/u,
	);
});

test("the derived profile is native claims plus an operator-first fallback ladder", () => {
	const parsed = parseDataStoreCatalogEntry(entry());
	const profile = dataStoreProfileOf(parsed);
	assert.deepEqual(
		profile.offerings.map((offering) => offering.id),
		["sql.relational", "sql.transactions"],
	);
	assert.deepEqual(profile.fallbacks, [
		"backup.pitr",
		"journal.event-stream",
		"cdc.stream",
		"migrate.dual-write",
	]);
	assert.deepEqual(operatorOwnedOfferings(parsed), ["backup.pitr"]);
	assert.deepEqual(dataStoreCatalogEvidence(parsed), {
		provider: "self-hosted-postgres",
		evidenced: 4,
		unknown: 1,
	});
});

test("unsupported and unknown claims fail closed under require", () => {
	const profile = dataStoreProfileOf(parseDataStoreCatalogEntry(entry()));
	for (const id of ["replica.read", "pool.transaction"] as const) {
		const resolved = resolveDataStore([profile], {
			features: ["sql.relational", id],
			negotiation: "require",
		});
		assert.equal(resolved.kind, "unresolved");
	}
	const pitr = resolveDataStore([profile], {
		features: ["sql.relational", "backup.pitr"],
		negotiation: "require",
	});
	assert.equal(pitr.kind, "resolved");
	if (pitr.kind !== "resolved" || pitr.match.kind !== "partial") {
		assert.fail("operator-owned PITR must resolve partial, never full");
	}
	assert.deepEqual(pitr.match.fallbacks, ["backup.pitr"]);
});

test("a native claim of a preview product is offered as preview", () => {
	const profile = dataStoreProfileOf(
		parseDataStoreCatalogEntry(entry({ stability: "preview" })),
	);
	assert.ok(profile.offerings.every((o) => o.stability === "preview"));
});
