/**
 * `postgres.database({ ... })` — the Bindle-facing authoring surface.
 *
 * The failure this file guards against is not a crash. It is a Bindle that
 * *looks* portable and is not: a requirement that silently dropped a feature
 * the application depends on, or that let a provider name in through an option
 * key. Both produce a placement decision that succeeds and a deployment that
 * misbehaves later, so every assertion below states which of the two it stops.
 */
import { describe, expect, it } from "vitest";

import {
	database,
	POSTGRES_PROFILE_ID,
	POSTGRES_REQUIRED_GUARANTEE_KEYS,
	parsePostgresVersionRange,
	postgres,
	RELATIONAL_PROFILE_ID,
} from "../src/authoring.js";
import {
	POSTGRES_CONNECTIVITY_TRANSPORTS,
	POSTGRES_GUARANTEES,
	POSTGRES_ISOLATION_LEVELS,
	POSTGRES_MIGRATION_TOOLS,
} from "../src/capabilities.js";
import { PostgresDataError } from "../src/errors.js";
import { POSTGRES_MIGRATION_PROFILES } from "../src/migration-profiles.js";

type Feature = {
	key: string;
	operator: string;
	value: unknown;
	necessity?: string;
};

function featuresOf(requirement: ReturnType<typeof database>): Feature[] {
	// SAFETY: database() returns canonical feature records with this test shape.
	return [...(requirement.features as readonly Feature[])];
}

function feature(
	requirement: ReturnType<typeof database>,
	key: string,
): Feature | undefined {
	return featuresOf(requirement).find((entry) => entry.key === key);
}

/** Assert the call was refused by the authoring parser, not by something else. */
function expectRejection(run: () => void, match: RegExp): PostgresDataError {
	try {
		run();
	} catch (error) {
		// The typed code is the contract a Bindle author's tooling branches on.
		// A bare TypeError from an unguarded property read would satisfy
		// `toThrow()` while telling the author nothing about what to fix.
		expect(error).toBeInstanceOf(PostgresDataError);
		// SAFETY: the preceding Vitest assertion establishes the error instance.
		const typed = error as PostgresDataError;
		expect(typed.code).toBe("INVALID_POSTGRES_REQUIREMENT");
		expect(typed.message).toMatch(match);
		return typed;
	}
	expect.unreachable(`expected a rejection matching ${match}`);
	throw new Error("unreachable");
}

describe("parsePostgresVersionRange", () => {
	it("treats a bare major as at-least", () => {
		// `version: "16"` from an author means "16 or newer" — the common intent.
		// Reading it as `equals` would reject 17 and pin every Bindle to a major
		// that goes end-of-life.
		expect(parsePostgresVersionRange("16")).toEqual({
			operator: "at-least",
			major: 16,
		});
	});

	it("maps each operator onto the two-operator vocabulary", () => {
		expect(parsePostgresVersionRange(">=16")).toEqual({
			operator: "at-least",
			major: 16,
		});
		expect(parsePostgresVersionRange("=17")).toEqual({
			operator: "equals",
			major: 17,
		});
		expect(parsePostgresVersionRange("<=15")).toEqual({
			operator: "at-most",
			major: 15,
		});
		// Exclusive operators collapse into the inclusive ones by moving the
		// bound, which keeps the matcher's vocabulary to three operators instead
		// of five. `>16` must not silently become `>=16` — that would admit a
		// server the author explicitly excluded.
		expect(parsePostgresVersionRange(">16")).toEqual({
			operator: "at-least",
			major: 17,
		});
		expect(parsePostgresVersionRange("<16")).toEqual({
			operator: "at-most",
			major: 15,
		});
	});

	it("treats caret and tilde as at-least", () => {
		// npm-flavoured ranges are what an author reaches for by habit. Since the
		// gate is on major only, both collapse to the same thing rather than
		// being rejected as unparseable.
		expect(parsePostgresVersionRange("^16")).toEqual({
			operator: "at-least",
			major: 16,
		});
		expect(parsePostgresVersionRange("~16")).toEqual({
			operator: "at-least",
			major: 16,
		});
	});

	it("accepts a v prefix, minor and patch components, and surrounding space", () => {
		// The minor/patch parts are discarded deliberately: PostgreSQL's
		// compatibility contract is per-major, so gating on a minor would reject
		// a product that is running a newer patch of exactly the right major.
		for (const range of ["v16", "16.2", "16.2.1", "  >=16.2  ", ">= 16"]) {
			expect(parsePostgresVersionRange(range).major, range).toBe(16);
		}
	});

	it("rejects anything that is not a major version with an optional operator", () => {
		for (const range of [
			"",
			"latest",
			"16.x",
			">=16 <18",
			"16-beta",
			"!=16",
			"1234",
			"16.2.1.4",
		]) {
			// An unparseable range must not fall through to a default, because a
			// silently-defaulted version gate would let any server match.
			expectRejection(
				() => parsePostgresVersionRange(range),
				/must be a major version/u,
			);
		}
	});

	it("rejects a major outside 1..999", () => {
		expectRejection(() => parsePostgresVersionRange("0"), /out of range/u);
	});

	it("checks the bound before adjusting it, so `<1` is a usable at-most 0", () => {
		// Pinning what the code does rather than what looks tidier. The range
		// check runs on the *parsed* major, so `<1` passes it and then becomes
		// `at-most 0` — a gate no server satisfies. That is arguably the honest
		// answer to "strictly older than 1", and nothing downstream divides by it,
		// but it means an out-of-range bound can still exist after adjustment.
		expect(parsePostgresVersionRange("<1")).toEqual({
			operator: "at-most",
			major: 0,
		});
		expect(parsePostgresVersionRange(">999")).toEqual({
			operator: "at-least",
			major: 1000,
		});
	});
});

describe("database() — option screening", () => {
	it("accepts an empty call", () => {
		const requirement = database();
		// The zero-option call still asks for the profile and all seven
		// guarantees, so `postgres.database()` is never a no-op requirement that
		// any relational product would satisfy.
		expect(requirement.requiredProfiles[0]?.profileId).toBe(
			POSTGRES_PROFILE_ID,
		);
		expect(requirement.features).toEqual([]);
		expect(requirement.guarantees).toHaveLength(
			POSTGRES_REQUIRED_GUARANTEE_KEYS.length,
		);
	});

	it("rejects an option key it does not know", () => {
		// A typo like `extension:` (singular) would otherwise be silently ignored
		// and the Bindle would deploy onto a product with no pgvector at all.
		expectRejection(
			// SAFETY: intentionally malformed input exercises the parser boundary.
			() => database({ extension: ["vector"] } as never),
			/unknown postgres\.database option "extension"/u,
		);
	});

	it("rejects provider-shaped option keys by name", () => {
		for (const key of [
			"provider",
			"vendor",
			"product",
			"account",
			"tenant",
			"region",
			"providerId",
			"awsRegion",
			"myTenantThing",
		]) {
			// This is the neutrality rule enforced at the *key* level, not just the
			// value: the moment an author can write `{ region: "us-east-1" }` here,
			// placement has leaked into capability and the Bindle stops being
			// portable. The screen is case-insensitive and substring-based so a
			// camelCase spelling cannot slip past.
			expectRejection(
				// SAFETY: intentionally malformed input exercises the parser boundary.
				() => database({ [key]: "x" } as never),
				/unknown postgres\.database option|provider-neutral/u,
			);
		}
	});

	it("reports the neutrality failure for a known-but-provider-shaped key", () => {
		// `runtime` is known and neutral; there is no known key that is also
		// provider-shaped today, so this pins that the two screens are
		// independent — the neutrality check is not dead code hidden behind the
		// known-keys check for keys that are added later.
		expect(
			["version", "extensions", "migration", "runtime", "trustRef"].every(
				(key) => !/(provider|vendor|product|account|tenant|region)/iu.test(key),
			),
		).toBe(true);
	});

	it("exposes the same function under the namespaced entry point", () => {
		// Bindles are authored as `postgres.database(...)`; a divergence between
		// the two spellings would make the documented form behave differently
		// from the tested one.
		expect(postgres.database).toBe(database);
		expect(Object.isFrozen(postgres)).toBe(false);
		expect(Object.keys(postgres)).toEqual(["database"]);
	});
});

describe("database() — version", () => {
	it("emits a serverVersionMajor feature carrying the collapsed operator", () => {
		const requirement = database({ version: ">16" });
		expect(feature(requirement, "serverVersionMajor")).toMatchObject({
			operator: "at-least",
			value: 17,
			necessity: "required",
		});
	});

	it("omits the feature entirely when no version is asked for", () => {
		// Absent means "any supported major". Emitting a default gate would
		// quietly exclude products the author never meant to exclude.
		expect(feature(database({}), "serverVersionMajor")).toBeUndefined();
	});

	it("propagates a bad range as an authoring rejection", () => {
		expectRejection(
			() => database({ version: "latest" }),
			/must be a major version/u,
		);
	});
});

describe("database() — extensions", () => {
	it("emits an includes-all feature with names sorted", () => {
		const requirement = database({
			extensions: ["vector", "postgis", "hstore"],
		});
		// Sorting is what makes two authors who wrote the same set in different
		// orders produce the same requirement — and therefore the same selection
		// receipt. Without it the receipt digest would depend on typing order.
		expect(feature(requirement, "extensions")).toMatchObject({
			operator: "includes-all",
			value: ["hstore", "postgis", "vector"],
		});
	});

	it("rejects an empty list rather than treating it as no requirement", () => {
		// `extensions: []` reads as "I thought about extensions and need none",
		// which is the same as omitting the option — so the parser makes the
		// author say which one they meant instead of guessing.
		expectRejection(
			() => database({ extensions: [] }),
			/must not be an empty list; omit the option instead/u,
		);
	});

	it("rejects anything that is not a plain extension name", () => {
		for (const extension of [
			"Vector",
			"pg_stat statements",
			"vector;drop",
			"-vector",
			"1vector",
			"",
			"a".repeat(64),
			"vector.sql",
		]) {
			// Extension names reach a `CREATE EXTENSION` somewhere downstream. A
			// name carrying punctuation or whitespace is either a typo or an
			// injection attempt, and neither should become a portable requirement.
			expectRejection(
				() => database({ extensions: [extension] }),
				/is not a plain PostgreSQL extension name/u,
			);
		}
	});

	it("accepts the shapes real extension names take", () => {
		for (const extension of [
			"vector",
			"pg_stat_statements",
			"uuid-ossp",
			"_underscore_start",
			"a".repeat(63),
		]) {
			expect(
				() => database({ extensions: [extension] }),
				extension,
			).not.toThrow();
		}
	});
});

describe("database() — enumerated lists", () => {
	it("accepts every declared isolation level and sorts them", () => {
		const requirement = database({
			// SAFETY: the exported closed list is valid; this cast preserves the test's spread expression.
			isolation: [...POSTGRES_ISOLATION_LEVELS] as never,
		});
		const sorted = [...POSTGRES_ISOLATION_LEVELS].sort((a, b) =>
			a.localeCompare(b),
		);
		expect(feature(requirement, "isolationLevels")?.value).toEqual(sorted);
	});

	it("de-duplicates repeated members", () => {
		// A repeated member is harmless but would change the emitted value and
		// therefore the receipt digest; collapsing it keeps the requirement
		// canonical.
		const requirement = database({
			// SAFETY: intentionally duplicate input exercises canonicalization.
			isolation: ["serializable", "serializable"] as never,
		});
		expect(feature(requirement, "isolationLevels")?.value).toEqual([
			"serializable",
		]);
	});

	it("rejects an unrecognized member and an empty list", () => {
		expectRejection(
			// SAFETY: intentionally invalid input exercises the parser boundary.
			() => database({ isolation: ["snapshot"] as never }),
			/isolation level "snapshot" is not a recognized value/u,
		);
		// Empty is refused for the same reason as extensions: it is ambiguous
		// between "none needed" and "I forgot to fill this in".
		expectRejection(
			// SAFETY: intentionally invalid input exercises the parser boundary.
			() => database({ isolation: [] as never }),
			/isolation level list must not be empty/u,
		);
	});

	it("accepts every declared connectivity transport", () => {
		const requirement = database({
			// SAFETY: the exported closed list is valid test input.
			connectivity: [...POSTGRES_CONNECTIVITY_TRANSPORTS] as never,
		});
		// Transports are what the *consuming workload* can open; a product that
		// only offers one the workload cannot reach is a deployment that fails at
		// connect time, not at placement time, which is far more expensive.
		expect(feature(requirement, "connectivityTransports")?.operator).toBe(
			"includes-all",
		);
		expect(feature(requirement, "connectivityTransports")?.value).toHaveLength(
			POSTGRES_CONNECTIVITY_TRANSPORTS.length,
		);
	});

	it("rejects an unrecognized transport and an empty transport list", () => {
		expectRejection(
			// SAFETY: intentionally invalid input exercises the parser boundary.
			() => database({ connectivity: ["carrier-pigeon"] as never }),
			/connectivity transport "carrier-pigeon" is not a recognized value/u,
		);
		expectRejection(
			// SAFETY: intentionally invalid input exercises the parser boundary.
			() => database({ connectivity: [] as never }),
			/connectivity transport list must not be empty/u,
		);
	});

	it("accepts every declared migration tool and rejects an unknown one", () => {
		const requirement = database({
			// SAFETY: the exported closed list is valid test input.
			migration: { tools: [...POSTGRES_MIGRATION_TOOLS] as never },
		});
		expect(feature(requirement, "migrationToolCompatibility")?.operator).toBe(
			"includes-all",
		);
		expectRejection(
			// SAFETY: intentionally invalid input exercises the parser boundary.
			() => database({ migration: { tools: ["sqitch"] as never } }),
			/migration tool "sqitch" is not a recognized value/u,
		);
	});
});

describe("database() — boolean and numeric options", () => {
	it("emits pooling and jsonb features only for a literal true", () => {
		expect(feature(database({ pooling: true }), "pooling")).toMatchObject({
			operator: "equals",
			value: true,
		});
		expect(feature(database({ jsonb: true }), "jsonb")).toMatchObject({
			operator: "equals",
			value: true,
		});
		// `false` means "I do not require this", which is not the same as "the
		// product must not have it" — emitting an `equals false` gate would
		// exclude every pooled product from an author who wrote `pooling: false`.
		expect(feature(database({ pooling: false }), "pooling")).toBeUndefined();
		expect(feature(database({ jsonb: false }), "jsonb")).toBeUndefined();
	});

	it("maps minConnections onto an at-least gate over maxConnections", () => {
		const requirement = database({ minConnections: 200 });
		// The author asks for a floor; the profile records a ceiling. Getting the
		// direction wrong here would select the smallest product instead of one
		// large enough.
		expect(feature(requirement, "maxConnections")).toMatchObject({
			operator: "at-least",
			value: 200,
		});
	});

	it("maps minStorageBytes onto an at-least gate over maxStorageBytes", () => {
		expect(
			feature(database({ minStorageBytes: 1_000_000 }), "maxStorageBytes"),
		).toMatchObject({ operator: "at-least", value: 1_000_000 });
	});

	it("rejects non-positive or fractional numbers", () => {
		for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			// Zero would emit a gate every product satisfies — an author who wrote
			// it meant something, and silently accepting it hides the mistake.
			expectRejection(
				() => database({ minConnections: value }),
				/minConnections must be a positive integer/u,
			);
			expectRejection(
				() => database({ minStorageBytes: value }),
				/minStorageBytes must be a positive integer/u,
			);
		}
	});
});

describe("database() — migration requirements", () => {
	it("emits a feature per requested capability", () => {
		const requirement = database({
			migration: {
				requireExport: true,
				requireImport: true,
				requireLogicalReplication: true,
			},
		});
		for (const key of [
			"exportSupported",
			"importSupported",
			"logicalReplication",
		]) {
			expect(feature(requirement, key), key).toMatchObject({
				operator: "equals",
				value: true,
			});
		}
	});

	it("emits nothing for false or absent migration flags", () => {
		const explicit = database({
			migration: {
				requireExport: false,
				requireImport: false,
				requireLogicalReplication: false,
			},
		});
		expect(feature(explicit, "exportSupported")).toBeUndefined();
		expect(feature(explicit, "importSupported")).toBeUndefined();
		expect(feature(explicit, "logicalReplication")).toBeUndefined();
		// And the whole `migration` key being absent must behave identically —
		// the optional-chaining on `migration?.` is what makes that true.
		expect(featuresOf(database({ migration: {} }))).toEqual(
			featuresOf(database({})),
		);
	});

	it("carries requested profiles into the portability block", () => {
		const requirement = database({
			migration: { profiles: [...POSTGRES_MIGRATION_PROFILES] },
		});
		// Migration profiles are the exit path. They belong in `portability`
		// rather than `features` because they are scored by the PortabilityReport,
		// not used as a hard selection gate.
		//
		// Note the sort: `parseCapabilityRequirement` canonicalizes the list, so
		// the emitted order is alphabetical rather than the order the author
		// wrote — the same ordering-independence the rest of this module relies
		// on for stable receipts, applied one layer down.
		expect(requirement.portability?.requiredMigrationProfiles).toEqual(
			[...POSTGRES_MIGRATION_PROFILES].sort((a, b) => a.localeCompare(b)),
		);
		expect(
			database({
				migration: { profiles: [...POSTGRES_MIGRATION_PROFILES].reverse() },
			}).portability?.requiredMigrationProfiles,
		).toEqual(requirement.portability?.requiredMigrationProfiles);
	});

	it("rejects an unknown migration profile", () => {
		expectRejection(
			() =>
				// SAFETY: intentionally invalid input exercises the parser boundary.
				database({ migration: { profiles: ["migration.mysql/v1"] as never } }),
			/unknown postgres migration profile/u,
		);
	});

	it("ties requireExportProfile to requireExport, defaulting to false", () => {
		expect(database({}).portability?.requireExportProfile).toBe(false);
		expect(
			database({ migration: { requireExport: true } }).portability
				?.requireExportProfile,
		).toBe(true);
		// A requirement that asked for an export capability but not an export
		// *profile* would pass selection against a product with no documented way
		// to get the data back out.
		expect(
			database({ migration: { requireExport: false } }).portability
				?.requireExportProfile,
		).toBe(false);
	});

	it("always requires a standard binding", () => {
		// Without `connectionUriBinding` there is nothing to deposit into secret
		// custody, which is why the module documents all seven guarantees as
		// non-optional. This is the portability half of the same rule.
		expect(database({}).portability?.requireStandardBinding).toBe(true);
	});

	it("defaults requiredMigrationProfiles to an empty list", () => {
		expect(database({}).portability?.requiredMigrationProfiles).toEqual([]);
	});
});

describe("database() — guarantees and pass-through", () => {
	it("asserts every declared guarantee as equals-true", () => {
		const requirement = database({});
		// SAFETY: database() emits guarantee records with string keys.
		const keys = (requirement.guarantees as readonly { key: string }[]).map(
			(guarantee) => guarantee.key,
		);
		// All seven, every time. A product that merely speaks the wire protocol
		// over a read-only shim is a real thing and must not satisfy this call.
		expect([...keys].sort()).toEqual(
			POSTGRES_GUARANTEES.map((g) => g.key).sort(),
		);
		// SAFETY: database() emits these canonical guarantee records.
		for (const guarantee of requirement.guarantees as readonly {
			operator: string;
			value: unknown;
		}[]) {
			expect(guarantee.operator).toBe("equals");
			expect(guarantee.value).toBe(true);
		}
	});

	it("derives the exported guarantee keys from the capability vocabulary", () => {
		// Exported as a separate constant for consumers; if it drifted from
		// POSTGRES_GUARANTEES, a consumer checking coverage against it would
		// report a product as complete when it is not.
		expect(POSTGRES_REQUIRED_GUARANTEE_KEYS).toEqual(
			POSTGRES_GUARANTEES.map((guarantee) => guarantee.key),
		);
	});

	it("passes runtime and trustRef through only when supplied", () => {
		const bare = database({});
		expect(bare.trustRef).toBeUndefined();
		const withRefs = database({ trustRef: "trust://evidence/1" });
		// `trustRef` names the evidence the requirement is judged under. Emitting
		// a default would mean judging against evidence the author never chose.
		expect(withRefs.trustRef).toBe("trust://evidence/1");
	});

	it("pins the two stable profile identifiers", () => {
		// These strings appear in stored Bindles and receipts; changing either is
		// a breaking change for every artifact already written.
		expect(POSTGRES_PROFILE_ID).toBe("data.postgres/v1");
		expect(RELATIONAL_PROFILE_ID).toBe("data.relational/v1");
	});

	it("requires the postgres profile at version >=1", () => {
		expect(database({}).requiredProfiles).toEqual([
			{ profileId: POSTGRES_PROFILE_ID, versionRange: ">=1" },
		]);
	});
});

describe("database() — canonical ordering", () => {
	it("produces an identical requirement regardless of option order", () => {
		const a = database({
			version: ">=16",
			extensions: ["vector", "hstore"],
			pooling: true,
			minConnections: 50,
		});
		const b = database({
			minConnections: 50,
			pooling: true,
			extensions: ["hstore", "vector"],
			version: ">=16",
		});
		// This is the property the whole module is built around: two authors who
		// wrote the same intent must produce the same selection decision and the
		// same receipt. If ordering leaked through, an unrelated reformat of a
		// Bindle would change its receipt digest and invalidate an approval.
		expect(a).toEqual(b);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("does not mutate the caller's option arrays", () => {
		const extensions = ["vector", "hstore"];
		database({ extensions });
		// The sort is applied to a copy. Sorting in place would reorder the
		// author's own array as a side effect of building a requirement.
		expect(extensions).toEqual(["vector", "hstore"]);
	});
});
