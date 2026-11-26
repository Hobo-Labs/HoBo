/**
 * Round trip over the fixtures that already exist in this repo.
 *
 * Nothing here is invented. Inventing fixtures is how a schema passes its own
 * test while failing on real data, so every requirement driven through the
 * wire below is lifted from a file some other package already asserts against:
 *
 *   - packages/capability-profiles/test/selection.cases.jsonl
 *   - packages/cloud/test/profile-matching.cases.jsonl
 *   - packages/capability-profiles/contracts/pacts/catalog-selection.pact.json
 *   - packages/data-postgres/contracts/pacts/postgres-conformance.pact.json
 *
 * and the profile catalog is checked against the digest that twelve committed
 * golden offers under packages/recipes/test/golden/ carry.
 *
 * These are read as data, not imported. This package's only workspace
 * dependency is @hobo/core; reading another package's fixture file off disk
 * does not create a workspace edge, and the package-boundary guard scans
 * imports under src/, not filesystem reads under test/.
 *
 * The criterion is byte-identity under JSON.stringify, not deep equality.
 * Deep equality would pass while an encoder reordered keys or turned an absent
 * optional into a present `undefined`, and both of those change a digest.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { parseCapabilityProfile } from "../src/descriptor.js";
import {
	type CapabilityRequirementInput,
	parseCapabilityRequirement,
} from "../src/requirement.js";
import { STANDARD_CAPABILITY_PROFILES } from "../src/standard-profiles.js";
import {
	fromCapabilityProfileCatalogWire,
	fromCapabilityProfileDescriptorWire,
	fromCapabilityRequirementWire,
	toCapabilityProfileCatalogWire,
	toCapabilityProfileDescriptorWire,
	toCapabilityRequirementWire,
} from "../src/wire.js";

const repoFile = (relative: string): string =>
	readFileSync(
		fileURLToPath(new URL(`../../../${relative}`, import.meta.url)),
		"utf8",
	);

/**
 * The keys of `CapabilityRequirementInput`.
 *
 * The PACT request bodies are *selection* requests: they carry the requirement
 * inline alongside fields like `restrictToDefinitions` and `candidateProfiles`
 * that belong to the selection call, not to the requirement. Projecting rather
 * than passing the whole body through is the honest reading — and the
 * projection is asserted to be non-trivial below, so a body that turned out to
 * carry no requirement at all would fail rather than silently contribute an
 * empty case.
 */
const REQUIREMENT_KEYS = [
	"requiredProfiles",
	"preferredProfiles",
	"prohibitedProfiles",
	"runtime",
	"realization",
	"features",
	"guarantees",
	"portability",
	"trustRef",
] as const;

function projectRequirement(
	body: JsonObject,
): CapabilityRequirementInput | undefined {
	if (!Array.isArray(body.requiredProfiles)) return undefined;
	const projected = Object.fromEntries(
		REQUIREMENT_KEYS.filter((key) => key in body).map((key) => [
			key,
			body[key],
		]),
	);
	// SAFETY: requiredProfiles is present and the projection retains only input keys.
	return projected as CapabilityRequirementInput;
}

type Fixture = {
	readonly origin: string;
	readonly input: CapabilityRequirementInput;
};

function fixturesFromJsonl(relative: string): readonly Fixture[] {
	const found: Fixture[] = [];
	const lines = repoFile(relative).split("\n");
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		// SAFETY: committed JSONL fixtures follow the selection-case shape.
		const parsed = JSON.parse(trimmed) as {
			name?: string;
			input?: readonly { requirement?: JsonObject }[];
		};
		for (const entry of parsed.input ?? []) {
			if (!entry.requirement) continue;
			const projected = projectRequirement(entry.requirement);
			if (projected === undefined) continue;
			found.push({
				origin: `${relative}:${index + 1} (${parsed.name ?? "unnamed"})`,
				input: projected,
			});
		}
	}
	return found;
}

function fixturesFromPact(relative: string): readonly Fixture[] {
	const found: Fixture[] = [];
	// SAFETY: committed PACT fixtures follow the interaction shape projected here.
	const pact = JSON.parse(repoFile(relative)) as {
		interactions?: readonly {
			description?: string;
			request?: { body?: JsonObject };
		}[];
	};
	for (const interaction of pact.interactions ?? []) {
		const body = interaction.request?.body;
		if (!body) continue;
		const projected = projectRequirement(body);
		if (projected === undefined) continue;
		found.push({
			origin: `${relative} (${interaction.description ?? "unnamed"})`,
			input: projected,
		});
	}
	return found;
}

/**
 * The PACT sources come from this package's own `contracts/pact-inventory.json`
 * rather than from a list written here, so the inventory is load-bearing: an
 * entry that goes stale fails the harvest assertion instead of rotting into
 * prose nobody rechecks.
 */
// SAFETY: the committed inventory declares the consumed PACT paths.
const PACT_INVENTORY = JSON.parse(
	readFileSync(
		fileURLToPath(new URL("../contracts/pact-inventory.json", import.meta.url)),
		"utf8",
	),
) as { consumedBy: readonly { pact: string }[] };

const FIXTURES: readonly Fixture[] = [
	...fixturesFromJsonl(
		"packages/capability-profiles/test/selection.cases.jsonl",
	),
	...fixturesFromJsonl("packages/cloud/test/profile-matching.cases.jsonl"),
	...PACT_INVENTORY.consumedBy.flatMap((entry) => fixturesFromPact(entry.pact)),
];

describe("capability requirement round trip over existing repo fixtures", () => {
	/**
	 * Pins the harvest. Without this, a fixture file that moved or a selector
	 * that stopped matching would leave the suite running over zero cases and
	 * still reporting green — the §1.1 shape, where a test passes because it
	 * asserts nothing.
	 */
	it("harvests every requirement the four source files carry", () => {
		expect(FIXTURES.map((fixture) => fixture.origin).sort()).toEqual([
			"packages/capability-profiles/contracts/pacts/catalog-selection.pact.json (a PostgreSQL requirement resolves to a conformant Postgres product)",
			"packages/capability-profiles/contracts/pacts/catalog-selection.pact.json (a SQLite-class product never satisfies a PostgreSQL requirement)",
			"packages/capability-profiles/contracts/pacts/catalog-selection.pact.json (stale conformance evidence fails closed instead of ranking lower)",
			"packages/capability-profiles/test/selection.cases.jsonl:18 (rejects a missing required migration profile)",
			"packages/capability-profiles/test/selection.cases.jsonl:19 (rejects a prohibited profile)",
			"packages/capability-profiles/test/selection.cases.jsonl:20 (enforces required structured features)",
			"packages/capability-profiles/test/selection.cases.jsonl:21 (admits a candidate that satisfies the feature)",
			"packages/capability-profiles/test/selection.cases.jsonl:22 (enforces a required runtime model)",
			"packages/capability-profiles/test/selection.cases.jsonl:37 (denies a native implementation the requirement excludes)",
			"packages/capability-profiles/test/selection.cases.jsonl:38 (denies a pack the requirement excludes)",
			"packages/capability-profiles/test/selection.cases.jsonl:4 (accepts D1 for a relational requirement)",
			"packages/capability-profiles/test/selection.cases.jsonl:40 (denies a bridge the requirement excludes)",
			"packages/capability-profiles/test/selection.cases.jsonl:44 (rejects a candidate that does not support the required runtime)",
			"packages/capability-profiles/test/selection.cases.jsonl:45 (rejects a candidate supporting none of the allowed runtimes)",
			"packages/capability-profiles/test/selection.cases.jsonl:46 (admits a candidate supporting one of several allowed runtimes)",
			"packages/capability-profiles/test/selection.cases.jsonl:48 (satisfies an at-least feature at the bound)",
			"packages/capability-profiles/test/selection.cases.jsonl:49 (rejects an at-least feature one below the bound)",
			"packages/capability-profiles/test/selection.cases.jsonl:50 (rejects an at-least feature the candidate does not declare at all)",
			"packages/capability-profiles/test/selection.cases.jsonl:51 (rejects an at-least feature whose declared value is not a number)",
			"packages/capability-profiles/test/selection.cases.jsonl:52 (satisfies an at-most feature at the bound and rejects one above)",
			"packages/capability-profiles/test/selection.cases.jsonl:53 (rejects an at-most feature above the bound)",
			"packages/capability-profiles/test/selection.cases.jsonl:54 (satisfies a one-of feature)",
			"packages/capability-profiles/test/selection.cases.jsonl:55 (rejects a one-of feature outside the set)",
			"packages/capability-profiles/test/selection.cases.jsonl:56 (satisfies includes-all when the candidate declares a superset)",
			"packages/capability-profiles/test/selection.cases.jsonl:57 (rejects includes-all when one member is missing)",
			"packages/capability-profiles/test/selection.cases.jsonl:58 (rejects includes-all when the declared value is not a list)",
			"packages/capability-profiles/test/selection.cases.jsonl:59 (ignores a feature the requirement marks optional)",
			"packages/capability-profiles/test/selection.cases.jsonl:61 (rejects an unsatisfied guarantee)",
			"packages/capability-profiles/test/selection.cases.jsonl:62 (admits a satisfied guarantee)",
			"packages/capability-profiles/test/selection.cases.jsonl:65 (rejects a candidate missing a required migration profile)",
			"packages/cloud/test/profile-matching.cases.jsonl:4 (satisfies a relational requirement through the refinement graph)",
			"packages/data-postgres/contracts/pacts/postgres-conformance.pact.json (a relational-but-not-Postgres product is rejected rather than ranked lower)",
		]);
	});

	it.each(
		FIXTURES.map((fixture) => [fixture.origin, fixture] as const),
	)("survives the wire byte-identically: %s", (_origin, fixture) => {
		const parsed = parseCapabilityRequirement(fixture.input);
		const encoded = toCapabilityRequirementWire(parsed);
		// Through JSON, because that is what crossing a boundary costs.
		const decoded = fromCapabilityRequirementWire(
			JSON.parse(JSON.stringify(encoded)),
		);
		expect(JSON.stringify(decoded)).toBe(JSON.stringify(parsed));
	});

	/**
	 * The fixtures do not exercise every arm, so this covers the ones they
	 * miss: an absent optional next to a present one, a string-set value, a
	 * float, a negative weight-ordering tie, and an empty migration list.
	 */
	it("preserves presence for the optionals the fixtures never populate", () => {
		const parsed = parseCapabilityRequirement({
			requiredProfiles: [
				{ profileId: "data.postgres/v1", versionRange: ">=16" },
			],
			preferredProfiles: [
				{ profileId: "data.vector.pgvector/v1", weight: 3 },
				{ profileId: "kv.valkey/v1", weight: 3 },
			],
			prohibitedProfiles: [{ profileId: "data.sqlite/v1" }],
			runtime: {
				required: "oci",
				allowed: ["oci", "paas"],
				preferred: ["oci"],
			},
			realization: { allowNative: true, allowPack: false, allowBridge: true },
			features: [
				{
					key: "extensions",
					operator: "includes-all",
					value: ["pgvector", "postgis"],
					necessity: "required",
				},
				{
					key: "loadFactor",
					operator: "at-most",
					value: 0.75,
					necessity: "preferred",
				},
				{
					key: "serverVersion",
					operator: "one-of",
					value: "16",
					necessity: "required",
				},
				{
					key: "streaming",
					operator: "equals",
					value: false,
					necessity: "preferred",
				},
			],
			guarantees: [{ key: "tls", operator: "equals", value: true }],
			portability: { requireStandardBinding: true },
			trustRef: "trust/postgres-v1",
		});

		const decoded = fromCapabilityRequirementWire(
			JSON.parse(JSON.stringify(toCapabilityRequirementWire(parsed))),
		);
		expect(JSON.stringify(decoded)).toBe(JSON.stringify(parsed));
		// `trustRef` present, `runtime.required` present: assert the wire really
		// carried them rather than the decoder re-deriving a default.
		expect(decoded.trustRef).toBe("trust/postgres-v1");
		expect(decoded.runtime.required).toBe("oci");
	});

	it("keeps an absent trustRef absent rather than present-and-undefined", () => {
		const parsed = parseCapabilityRequirement({
			requiredProfiles: [{ profileId: "data.postgres/v1" }],
		});
		const decoded = fromCapabilityRequirementWire(
			JSON.parse(JSON.stringify(toCapabilityRequirementWire(parsed))),
		);
		expect("trustRef" in decoded).toBe(false);
		expect("required" in decoded.runtime).toBe(false);
	});
});

/**
 * The registry digest, transcribed from
 * packages/capability-profiles/src/registry.ts.
 *
 * Transcribed rather than imported: this package depends only on @hobo/core.
 * A wrong transcription cannot make this test pass, because the value it has
 * to reproduce is committed in twelve golden offer files that nothing here can
 * reach in to change.
 */
function registryDigestOf(
	profiles: readonly ReturnType<typeof parseCapabilityProfile>[],
): string {
	const summary = profiles
		.map((profile) => ({
			id: profile.id,
			primitive: profile.primitive,
			refines: profile.refines,
			requires: profile.requires,
			conflictsWith: profile.conflictsWith,
			maturity: profile.maturity,
			features: [...profile.features]
				.map((feature) => ({
					key: feature.key,
					valueKind: feature.valueKind,
					enumValues: feature.enumValues
						? [...feature.enumValues].sort()
						: undefined,
				}))
				.sort((a, b) => a.key.localeCompare(b.key)),
			guarantees: [...profile.guarantees]
				.map((guarantee) => ({
					key: guarantee.key,
					valueKind: guarantee.valueKind,
					enumValues: guarantee.enumValues
						? [...guarantee.enumValues].sort()
						: undefined,
				}))
				.sort((a, b) => a.key.localeCompare(b.key)),
			conformanceSuiteRef: profile.conformanceSuiteRef,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	return `sha256:${createHash("sha256").update(JSON.stringify(summary)).digest("hex")}`;
}

const GOLDEN_OFFERS = [
	"recipe-cloudflare-claimable-generated-report-v1",
	"recipe-cloudflare-claimable-webhook-inbox-v1",
	"recipe-cloudflare-neon-portable-sql-api-v1",
	"recipe-cloudflare-neon-upstash-polyglot-saas-v1",
	"recipe-cloudflare-upstash-live-leaderboard-v1",
	"recipe-convex-cloud-sponsored-transfer-v1",
	"recipe-convex-local-accountless-preview-v1",
	"recipe-convex-selfhosted-strong-claim-v1",
	"recipe-neon-claimable-sql-sandbox-v1",
	"recipe-netlify-claimable-generated-report-v1",
	"recipe-prisma-claimable-sql-sandbox-v1",
	"recipe-vercel-prisma-claimable-issue-tracker-v1",
] as const;

const goldenRegistryDigests = GOLDEN_OFFERS.map((name) => {
	// SAFETY: committed golden offers declare their registry digest.
	const offer = JSON.parse(
		repoFile(`packages/recipes/test/golden/${name}.offer.json`),
	) as { profileRegistryDigest?: string };
	return offer.profileRegistryDigest;
});

describe("standard capability profile catalog round trip", () => {
	it("reads one agreed registry digest out of all twelve golden offers", () => {
		expect(new Set(goldenRegistryDigests).size).toBe(1);
		expect(goldenRegistryDigests[0]).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});

	it("carries the catalog the golden offers were compiled against", () => {
		const parsed = STANDARD_CAPABILITY_PROFILES.map(parseCapabilityProfile);
		expect(registryDigestOf(parsed)).toBe(goldenRegistryDigests[0]);
	});

	it("still carries it after a full trip through the wire schema", () => {
		const decoded = fromCapabilityProfileCatalogWire(
			JSON.parse(
				JSON.stringify(
					toCapabilityProfileCatalogWire(STANDARD_CAPABILITY_PROFILES),
				),
			),
		);
		expect(registryDigestOf(decoded.map(parseCapabilityProfile))).toBe(
			goldenRegistryDigests[0],
		);
	});

	it.each(
		STANDARD_CAPABILITY_PROFILES.map(
			(descriptor) => [descriptor.id, descriptor] as const,
		),
	)("round-trips %s byte-identically", (_id, descriptor) => {
		const decoded = fromCapabilityProfileDescriptorWire(
			JSON.parse(JSON.stringify(toCapabilityProfileDescriptorWire(descriptor))),
		);
		expect(JSON.stringify(decoded)).toBe(JSON.stringify(descriptor));
	});

	/**
	 * The reason the StringList wrapper exists, pinned so deleting it fails a
	 * test that explains itself rather than sixty mysterious digest mismatches.
	 *
	 * Every descriptor in the catalog omits `enumValues` — no first-party
	 * profile declares an `enum` valueKind. A bare proto3 `repeated string
	 * enum_values` cannot distinguish that omission from an empty list, so it
	 * would decode all of them as `[]`. The registry digest is computed with
	 * JSON.stringify, which omits an `undefined` property and emits `[]` for an
	 * empty array, so the substitution is observable — and it lands on a value
	 * twelve committed golden offers carry.
	 */
	it("would break the golden digest if absent enumValues decoded as empty", () => {
		const parsed = STANDARD_CAPABILITY_PROFILES.map(parseCapabilityProfile);
		expect(
			parsed.every((profile) =>
				[...profile.features, ...profile.guarantees].every(
					(entry) => entry.enumValues === undefined,
				),
			),
			"the premise of this test is that no first-party profile declares enum values",
		).toBe(true);

		const asBareRepeated = parsed.map((profile) => ({
			...profile,
			features: profile.features.map((feature) => ({
				...feature,
				enumValues: feature.enumValues ?? [],
			})),
			guarantees: profile.guarantees.map((guarantee) => ({
				...guarantee,
				enumValues: guarantee.enumValues ?? [],
			})),
		}));

		expect(
			registryDigestOf(asBareRepeated),
			"a bare `repeated string enum_values` must be observably wrong, otherwise the StringList wrapper in capability_profile.proto is decoration",
		).not.toBe(goldenRegistryDigests[0]);
	});
});

describe("the wire form is more canonical than the parse boundary", () => {
	/**
	 * `parseCapabilityRequirement`'s doc comment claims "the returned
	 * requirement is canonically ordered so equivalent authoring order produces
	 * byte-identical decisions". That is true of array order and false of key
	 * order: `features` and `guarantees` are shallow-copied and sorted, so the
	 * element objects are the caller's own, with the caller's key order.
	 *
	 * The wire schema fixes it, because encoding names the fields in
	 * declaration order. This test pins both halves — the defect and the
	 * repair — so neither can regress unnoticed.
	 */
	const canonical = parseCapabilityRequirement({
		requiredProfiles: [{ profileId: "data.postgres/v1" }],
		features: [
			{
				key: "maxStorageBytes",
				operator: "at-least",
				value: 1_000_000_000,
				necessity: "required",
			},
		],
	});
	const shuffled = parseCapabilityRequirement({
		requiredProfiles: [{ profileId: "data.postgres/v1" }],
		features: [
			{
				value: 1_000_000_000,
				necessity: "required",
				key: "maxStorageBytes",
				operator: "at-least",
			},
		],
	});

	it("does not canonicalize feature key order at the parse boundary", () => {
		expect(canonical).toEqual(shuffled);
		expect(JSON.stringify(canonical)).not.toBe(JSON.stringify(shuffled));
	});

	/**
	 * Both halves of the codec, separately.
	 *
	 * Asserting only on the decoded value hides an encoder that forwards the
	 * caller's object unchanged, because the decoder rebuilds fields in
	 * declaration order and would launder the difference. That is not
	 * hypothetical — an earlier version of this test asserted only the round
	 * trip, and spreading `...entry` in the encoder left it green.
	 */
	it("canonicalizes on the way out", () => {
		expect(JSON.stringify(toCapabilityRequirementWire(shuffled))).toBe(
			JSON.stringify(toCapabilityRequirementWire(canonical)),
		);
		expect(
			Object.keys(toCapabilityRequirementWire(shuffled).features[0] ?? {}),
		).toEqual(["key", "operator", "value", "necessity"]);
	});

	it("canonicalizes on the way back", () => {
		const trip = (value: typeof canonical) =>
			JSON.stringify(
				fromCapabilityRequirementWire(
					JSON.parse(JSON.stringify(toCapabilityRequirementWire(value))),
				),
			);
		expect(trip(shuffled)).toBe(trip(canonical));
		// And the canonical spelling is a fixed point, so the wire does not
		// merely agree with itself — it agrees with the parse boundary.
		expect(trip(canonical)).toBe(JSON.stringify(canonical));
	});
});
