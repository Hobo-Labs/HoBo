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
		const decoded = fromCapabilityRequirementWire(
			JSON.parse(JSON.stringify(encoded)),
		);
		expect(JSON.stringify(decoded)).toBe(JSON.stringify(parsed));
	});

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
		expect(trip(canonical)).toBe(JSON.stringify(canonical));
	});
});
