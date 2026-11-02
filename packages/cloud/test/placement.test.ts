import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseJsonValue, type JsonValue } from "../src/json.js";
import { type ManifestV1, parseManifest } from "@hobo/bindles";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import { describe, expect, it } from "vitest";

import {
	createRegistryFromProviders,
	matchResource,
	type PlacementContext,
	type PlacementCriteria,
	type PlannerRegistry,
	plan,
	type ResourceDefinition,
	type ResourceIntent,
} from "../src/index.js";

// E19 placement-constraint vocabulary golden vectors (0015 §B deliverable 2):
// property selectors, affinity/anti-affinity between resource classes, spread,
// and pickN, each resolved deterministically as hard filters BETWEEN capability
// negotiation and the untouched lexicographic ranking (ADR-0033/ADR-0088).
// The vocabulary records what the Planner PLANS; execution of spread and
// anti-affinity stays delegated to wadm.

const HELLO_BINDLE_PLAN_HASH =
	"sha256:30eb585558f0614fac037fa5ada935eaad03e86f35c39110af21b2c58bdaf5b6";

function definition(overrides: {
	providerId: string;
	port: string;
	regions: string[];
	features?: string[];
	marginalPrice?: string;
	specificity?: number;
	priority?: number;
}): ResourceDefinition {
	const features = overrides.features ?? [];
	const port = overrides.port;
	return {
		id: `${overrides.providerId}:${port}`,
		providerId: overrides.providerId,
		port,
		features,
		regions: overrides.regions,
		specificity: overrides.specificity ?? 10,
		priority: overrides.priority ?? 0,
		cost: {
			sku: `${port}-standard`,
			unit: "gb",
			marginalPrice: overrides.marginalPrice ?? "0.010",
		},
		satisfies: (req) => {
			if (req.port !== port) return { kind: "none" };
			const missing = (req.features ?? []).filter(
				(feature) => !features.includes(feature),
			);
			if (missing.length === 0) return { kind: "full" };
			return { kind: "partial", missing };
		},
	};
}

function registryOf(defs: ResourceDefinition[]): PlannerRegistry {
	return {
		catalogHash: "sha256:placement-test-catalog",
		definitions: () => defs.map((d) => ({ ...d })),
		providers: () => [...new Set(defs.map((d) => d.providerId))],
	};
}

function kvIntent(overrides: Partial<ResourceIntent> = {}): ResourceIntent {
	return {
		name: "cache",
		port: "kv",
		require: [],
		prefer: [],
		negotiation: "require",
		deps: [],
		objective: "min-cost",
		...overrides,
	};
}

function criteria(overrides: Partial<PlacementCriteria>): PlacementCriteria {
	return { selectors: [], affinities: [], ...overrides };
}

// Two kv providers: alpha (us-east-1, pricier) and beta (eu-west-1, cheaper).
function twoYardRegistry(): PlannerRegistry {
	return registryOf([
		definition({
			providerId: "alpha",
			port: "kv",
			regions: ["us-east-1"],
			features: ["eventual", "encryption=aes256", "latency=20"],
			marginalPrice: "0.010",
		}),
		definition({
			providerId: "beta",
			port: "kv",
			regions: ["eu-west-1"],
			features: ["eventual", "latency=45"],
			marginalPrice: "0.005",
		}),
	]);
}

describe("E19 placement: property selectors", () => {
	it("baseline (no placement) keeps the pre-E19 min-cost winner", () => {
		const outcome = matchResource(kvIntent(), twoYardRegistry());
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.decision.providerId).toBe("beta");
		expect(outcome.region).toBe("eu-west-1");
	});

	it("region eq selector overrides the cheaper out-of-region candidate", () => {
		const outcome = matchResource(
			kvIntent({
				placement: criteria({
					selectors: [{ key: "region", op: "eq", values: ["us-east-1"] }],
				}),
			}),
			twoYardRegistry(),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.decision.providerId).toBe("alpha");
		expect(outcome.region).toBe("us-east-1");
		const betaRejection = outcome.decision.rejectedCandidates.find(
			(entry) => entry.definitionId === "beta:kv",
		);
		expect(betaRejection?.reason).toContain("placement: selector region");
	});

	it("cost lt selector keeps only candidates under the bound", () => {
		const outcome = matchResource(
			kvIntent({
				placement: criteria({
					selectors: [{ key: "cost", op: "lt", values: ["0.008"] }],
				}),
			}),
			twoYardRegistry(),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.decision.providerId).toBe("beta");
	});

	it("custom-key selectors read key=value features (exists + numeric lte)", () => {
		const existsOutcome = matchResource(
			kvIntent({
				placement: criteria({
					selectors: [{ key: "encryption", op: "exists", values: [] }],
				}),
			}),
			twoYardRegistry(),
		);
		expect(existsOutcome.ok).toBe(true);
		if (existsOutcome.ok) {
			expect(existsOutcome.decision.providerId).toBe("alpha");
		}

		const latencyOutcome = matchResource(
			kvIntent({
				placement: criteria({
					selectors: [{ key: "latency", op: "lte", values: ["25"] }],
				}),
			}),
			twoYardRegistry(),
		);
		expect(latencyOutcome.ok).toBe(true);
		if (latencyOutcome.ok) {
			expect(latencyOutcome.decision.providerId).toBe("alpha");
		}
	});

	it("rejects with placement.unsatisfiable and per-candidate reasons when no candidate matches", () => {
		const outcome = matchResource(
			kvIntent({
				placement: criteria({
					selectors: [{ key: "region", op: "eq", values: ["mars-north-1"] }],
				}),
			}),
			twoYardRegistry(),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.remediation.code).toBe("placement.unsatisfiable");
		expect(outcome.remediation.missing.length).toBe(2);
		for (const reason of outcome.remediation.missing) {
			expect(reason).toContain("placement: selector region");
		}
	});
});

describe("E19 placement: affinity / anti-affinity between resource classes", () => {
	const dbOnAlpha: PlacementContext = {
		placements: [
			{
				resource: "ledger",
				port: "database",
				providerId: "alpha",
				region: "us-east-1",
			},
		],
	};

	it("anti-affinity (yard scope) steers the match away from the target class's yard", () => {
		const outcome = matchResource(
			kvIntent({
				placement: criteria({
					affinities: [
						{ mode: "anti-affinity", targetPort: "database", scope: "yard" },
					],
				}),
			}),
			twoYardRegistry(),
			dbOnAlpha,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.decision.providerId).toBe("beta");
		const alphaRejection = outcome.decision.rejectedCandidates.find(
			(entry) => entry.definitionId === "alpha:kv",
		);
		expect(alphaRejection?.reason).toContain("anti-affinity");
	});

	it("affinity (yard scope) requires co-location with the target class's yard", () => {
		const outcome = matchResource(
			kvIntent({
				placement: criteria({
					affinities: [
						{ mode: "affinity", targetPort: "database", scope: "yard" },
					],
				}),
			}),
			twoYardRegistry(),
			dbOnAlpha,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// alpha is pricier, but affinity is a hard filter applied before ranking.
		expect(outcome.decision.providerId).toBe("alpha");
	});

	it("affinity (region scope) picks the co-located region of a multi-region candidate", () => {
		const registry = registryOf([
			definition({
				providerId: "gamma",
				port: "kv",
				regions: ["eu-west-1", "us-east-1"],
			}),
		]);
		const context: PlacementContext = {
			placements: [
				{
					resource: "ledger",
					port: "database",
					providerId: "gamma",
					region: "us-east-1",
				},
			],
		};
		const outcome = matchResource(
			kvIntent({
				placement: criteria({
					affinities: [
						{ mode: "affinity", targetPort: "database", scope: "region" },
					],
				}),
			}),
			registry,
			context,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// Without affinity the lexicographically smallest region (eu-west-1) wins.
		expect(outcome.region).toBe("us-east-1");
	});

	it("anti-affinity (region scope) picks a region outside the target class's regions", () => {
		const registry = registryOf([
			definition({
				providerId: "gamma",
				port: "kv",
				regions: ["eu-west-1", "us-east-1"],
			}),
		]);
		const context: PlacementContext = {
			placements: [
				{
					resource: "ledger",
					port: "database",
					providerId: "gamma",
					region: "eu-west-1",
				},
			],
		};
		const outcome = matchResource(
			kvIntent({
				placement: criteria({
					affinities: [
						{ mode: "anti-affinity", targetPort: "database", scope: "region" },
					],
				}),
			}),
			registry,
			context,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.region).toBe("us-east-1");
	});

	it("a rule referencing a class with no decided placement is vacuously satisfied", () => {
		const outcome = matchResource(
			kvIntent({
				placement: criteria({
					affinities: [
						{ mode: "anti-affinity", targetPort: "queue", scope: "yard" },
					],
				}),
			}),
			twoYardRegistry(),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.decision.providerId).toBe("beta");
	});
});

describe("E19 placement: spread", () => {
	it("spread across regions picks the least-loaded region, lexicographic tiebreak", () => {
		const registry = registryOf([
			definition({
				providerId: "gamma",
				port: "kv",
				regions: ["ap-south-1", "eu-west-1", "us-east-1"],
			}),
		]);
		const context: PlacementContext = {
			placements: [
				{
					resource: "cache-a",
					port: "kv",
					providerId: "gamma",
					region: "ap-south-1",
				},
			],
		};
		const outcome = matchResource(
			kvIntent({
				name: "cache-b",
				placement: criteria({ spread: { dimension: "region" } }),
			}),
			registry,
			context,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// ap-south-1 already carries one kv placement; eu-west-1 and us-east-1 are
		// tied at zero, so the lexicographically smallest wins.
		expect(outcome.region).toBe("eu-west-1");
	});

	it("spread across yards filters to the least-loaded yard before ranking", () => {
		const context: PlacementContext = {
			placements: [
				{
					resource: "cache-a",
					port: "kv",
					providerId: "beta",
					region: "eu-west-1",
				},
			],
		};
		const outcome = matchResource(
			kvIntent({
				name: "cache-b",
				placement: criteria({ spread: { dimension: "yard" } }),
			}),
			twoYardRegistry(),
			context,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// beta is cheaper but already carries a kv placement; spread keeps alpha.
		expect(outcome.decision.providerId).toBe("alpha");
		const betaRejection = outcome.decision.rejectedCandidates.find(
			(entry) => entry.definitionId === "beta:kv",
		);
		expect(betaRejection?.reason).toContain("spread");
	});
});

describe("E19 placement: pickN cardinality", () => {
	it("succeeds when at least N distinct candidates satisfy the criteria", () => {
		const outcome = matchResource(
			kvIntent({ placement: criteria({ pickN: { count: 2 } }) }),
			twoYardRegistry(),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// The full ranking records the N candidates; the Planner still places one.
		expect(outcome.decision.ranking.length).toBe(2);
	});

	it("rejects with placement.cardinality-unsatisfiable when fewer than N candidates survive", () => {
		const outcome = matchResource(
			kvIntent({
				placement: criteria({
					selectors: [{ key: "region", op: "eq", values: ["us-east-1"] }],
					pickN: { count: 2 },
				}),
			}),
			twoYardRegistry(),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.remediation.code).toBe(
			"placement.cardinality-unsatisfiable",
		);
		expect(outcome.remediation.remediation).toContain("pickN=2");
	});
});

describe("E19 placement: determinism + plan() integration", () => {
	function fixture(name: string): JsonValue {
		return parseJsonValue(
			readFileSync(
				fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
				"utf8",
			),
		);
	}
	function helloBindle(): ManifestV1 {
		return parseManifest(fixture("hello-bindle.manifest.json"));
	}

	it("matching with placement criteria is deterministic across runs", () => {
		const intent = kvIntent({
			placement: criteria({
				selectors: [{ key: "region", op: "in", values: ["us-east-1"] }],
				affinities: [
					{ mode: "anti-affinity", targetPort: "queue", scope: "yard" },
				],
			}),
		});
		const a = matchResource(intent, twoYardRegistry());
		const b = matchResource(intent, twoYardRegistry());
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("plan() with an empty placement map stays byte-stable on the golden hash", () => {
		const registry = createRegistryFromProviders([createCloudflareProvider()]);
		const result = plan(
			helloBindle(),
			{ deploymentId: "hello-bindle-001", placement: {} },
			registry,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.planHash).toBe(HELLO_BINDLE_PLAN_HASH);
	});

	it("plan() surfaces per-resource placement remediations", () => {
		const registry = createRegistryFromProviders([createCloudflareProvider()]);
		const result = plan(
			helloBindle(),
			{
				deploymentId: "hello-pickn",
				placement: {
					sessions: criteria({ pickN: { count: 99 } }),
				},
			},
			registry,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.remediations).toHaveLength(1);
		expect(result.remediations[0]?.resource).toBe("sessions");
		expect(result.remediations[0]?.code).toBe(
			"placement.cardinality-unsatisfiable",
		);
	});
});
