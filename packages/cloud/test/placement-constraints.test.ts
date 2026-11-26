import { describe, expect, test } from "vitest";

import type {
	PlacementAffinityRule,
	PlacementCriteria,
	PlacementPropertySelector,
	ResourceIntent,
} from "../src/plan-types.js";
import {
	affinityRejection,
	type DecidedPlacement,
	emptyPlacementContext,
	type PlacementContext,
	pickPlacementRegion,
	placementRejection,
	selectorRejection,
	spreadSurvivors,
} from "../src/planner/placement.js";
import type { ResourceDefinition } from "../src/registry/catalog.js";

function definition(
	overrides: Partial<ResourceDefinition> = {},
): ResourceDefinition {
	return {
		id: "acme:database",
		providerId: "acme",
		port: "database",
		features: [],
		regions: ["us-east"],
		specificity: 10,
		priority: 0,
		cost: { sku: "db", unit: "hour", marginalPrice: "0.10" },
		satisfies: () => ({ kind: "full" }),
		...overrides,
	};
}

function selector(
	op: PlacementPropertySelector["op"],
	key: string,
	values: string[] = [],
): PlacementPropertySelector {
	return { key, op, values } as PlacementPropertySelector;
}

function rule(
	mode: PlacementAffinityRule["mode"],
	scope: PlacementAffinityRule["scope"],
	targetPort = "cache",
): PlacementAffinityRule {
	return { mode, scope, targetPort } as PlacementAffinityRule;
}

function context(...placements: DecidedPlacement[]): PlacementContext {
	return { placements };
}

function placed(
	providerId: string,
	region: string,
	port = "cache",
): DecidedPlacement {
	return { resource: `${port}-1`, port, providerId, region };
}

function intent(overrides: Partial<ResourceIntent> = {}): ResourceIntent {
	return { resource: "db", port: "database", ...overrides } as ResourceIntent;
}

function criteria(
	overrides: Partial<PlacementCriteria> = {},
): PlacementCriteria {
	return {
		selectors: [],
		affinities: [],
		...overrides,
	} as PlacementCriteria;
}

describe("property resolution", () => {
	test("the well-known keys read the definition record, not features", () => {
		const def = definition({ regions: ["eu-west", "us-east"] });
		expect(
			selectorRejection(def, selector("eq", "provider", ["acme"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("eq", "region", ["eu-west"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("eq", "cost", ["0.10"])),
		).toBeUndefined();
	});

	test("an unknown key reads key=value entries out of the features", () => {
		const def = definition({ features: ["tier=premium", "zone=a"] });
		expect(
			selectorRejection(def, selector("eq", "tier", ["premium"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("eq", "zone", ["a"])),
		).toBeUndefined();
	});

	test("several values for one key are all resolved", () => {
		const def = definition({ features: ["zone=a", "zone=b"] });
		expect(
			selectorRejection(def, selector("eq", "zone", ["b"])),
		).toBeUndefined();
	});

	test("a bare feature token resolves for exists but has no value", () => {
		const def = definition({ features: ["gpu"] });
		expect(selectorRejection(def, selector("exists", "gpu"))).toBeUndefined();
		expect(
			selectorRejection(def, selector("eq", "gpu", ["gpu"])),
		).toBeUndefined();
	});

	test("a key=value entry suppresses the bare-token fallback", () => {
		const def = definition({ features: ["tier=basic", "tier"] });
		expect(
			selectorRejection(def, selector("eq", "tier", ["tier"])),
		).toBeDefined();
		expect(
			selectorRejection(def, selector("eq", "tier", ["basic"])),
		).toBeUndefined();
	});

	test("a key with no matching feature resolves to nothing", () => {
		expect(
			selectorRejection(definition(), selector("exists", "absent")),
		).toBeDefined();
	});

	test("prefix matching is on `key=`, not a bare prefix", () => {
		const def = definition({ features: ["zonal=true"] });
		expect(selectorRejection(def, selector("exists", "zone"))).toBeDefined();
	});
});

describe("selector operators", () => {
	const def = definition({
		regions: ["us-east", "eu-west"],
		features: ["tier=premium"],
		cost: { sku: "db", unit: "hour", marginalPrice: "0.50" },
	});

	test("exists passes when the property is advertised and fails otherwise", () => {
		expect(selectorRejection(def, selector("exists", "tier"))).toBeUndefined();
		expect(selectorRejection(def, selector("exists", "nope"))).toBeDefined();
	});

	test("eq matches any advertised value", () => {
		expect(
			selectorRejection(def, selector("eq", "region", ["eu-west"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("eq", "region", ["ap-south"])),
		).toBeDefined();
	});

	test("ne requires every advertised value to differ", () => {
		expect(
			selectorRejection(def, selector("ne", "region", ["ap-south"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("ne", "region", ["us-east"])),
		).toBeDefined();
	});

	test("in passes when any advertised value is on the list", () => {
		expect(
			selectorRejection(def, selector("in", "region", ["ap-south", "eu-west"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("in", "region", ["ap-south"])),
		).toBeDefined();
	});

	test("not-in requires every advertised value to be off the list", () => {
		expect(
			selectorRejection(def, selector("not-in", "region", ["ap-south"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("not-in", "region", ["us-east"])),
		).toBeDefined();
	});

	test("ne and not-in pass vacuously when nothing is advertised", () => {
		const bare = definition({ features: [] });
		expect(
			selectorRejection(bare, selector("ne", "tier", ["free"])),
		).toBeUndefined();
		expect(
			selectorRejection(bare, selector("not-in", "tier", ["free"])),
		).toBeUndefined();
	});

	test("lt, lte, gt and gte compare numerically, not lexically", () => {
		expect(
			selectorRejection(def, selector("lt", "cost", ["0.9"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("gt", "cost", ["0.9"])),
		).toBeDefined();
		expect(
			selectorRejection(def, selector("gt", "cost", ["0.1"])),
		).toBeUndefined();
	});

	test("lte and gte include the boundary while lt and gt exclude it", () => {
		expect(
			selectorRejection(def, selector("lte", "cost", ["0.50"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("gte", "cost", ["0.50"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("lt", "cost", ["0.50"])),
		).toBeDefined();
		expect(
			selectorRejection(def, selector("gt", "cost", ["0.50"])),
		).toBeDefined();
	});

	test("a numeric comparison against a non-numeric bound rejects", () => {
		expect(
			selectorRejection(def, selector("lt", "cost", ["cheap"])),
		).toBeDefined();
		expect(selectorRejection(def, selector("lt", "cost", []))).toBeDefined();
	});

	test("a numeric comparison against a non-numeric property rejects", () => {
		expect(
			selectorRejection(def, selector("lt", "region", ["5"])),
		).toBeDefined();
	});

	test("a numeric comparison passes when any advertised value satisfies it", () => {
		const multi = definition({ features: ["size=10", "size=2"] });
		expect(
			selectorRejection(multi, selector("lt", "size", ["5"])),
		).toBeUndefined();
	});

	test("Infinity and NaN are not accepted as numeric bounds", () => {
		expect(
			selectorRejection(def, selector("lt", "cost", ["Infinity"])),
		).toBeDefined();
		expect(
			selectorRejection(def, selector("lt", "cost", ["NaN"])),
		).toBeDefined();
	});

	test("a rejection reason names the key, the operator and what was advertised", () => {
		const reason = selectorRejection(
			def,
			selector("eq", "region", ["ap-south"]),
		);
		expect(reason).toContain("region");
		expect(reason).toContain("eq");
		expect(reason).toContain("ap-south");
		expect(reason).toContain("us-east");
	});
});

describe("affinity at yard scope", () => {
	const def = definition({ providerId: "acme" });

	test("a rule with no decided target is vacuously satisfied", () => {
		expect(
			affinityRejection(def, rule("affinity", "yard"), emptyPlacementContext()),
		).toBeUndefined();
		expect(
			affinityRejection(
				def,
				rule("anti-affinity", "yard"),
				emptyPlacementContext(),
			),
		).toBeUndefined();
	});

	test("only placements of the target port are considered", () => {
		const ctx = context(placed("other-provider", "us-east", "queue"));
		expect(
			affinityRejection(def, rule("affinity", "yard"), ctx),
		).toBeUndefined();
	});

	test("affinity requires the candidate to share a provider with the target", () => {
		expect(
			affinityRejection(
				def,
				rule("affinity", "yard"),
				context(placed("acme", "us-east")),
			),
		).toBeUndefined();
		expect(
			affinityRejection(
				def,
				rule("affinity", "yard"),
				context(placed("other", "us-east")),
			),
		).toBeDefined();
	});

	test("anti-affinity forbids sharing a provider with the target", () => {
		expect(
			affinityRejection(
				def,
				rule("anti-affinity", "yard"),
				context(placed("acme", "us-east")),
			),
		).toBeDefined();
		expect(
			affinityRejection(
				def,
				rule("anti-affinity", "yard"),
				context(placed("other", "us-east")),
			),
		).toBeUndefined();
	});

	test("affinity is satisfied by any one of several decided targets", () => {
		const ctx = context(placed("other", "us-east"), placed("acme", "eu-west"));
		expect(
			affinityRejection(def, rule("affinity", "yard"), ctx),
		).toBeUndefined();
	});

	test("anti-affinity is violated by any one of several decided targets", () => {
		const ctx = context(placed("other", "us-east"), placed("acme", "eu-west"));
		expect(
			affinityRejection(def, rule("anti-affinity", "yard"), ctx),
		).toBeDefined();
	});

	test("the rejection names the required or forbidden yard", () => {
		const affinityReason = affinityRejection(
			def,
			rule("affinity", "yard"),
			context(placed("other", "us-east")),
		);
		expect(affinityReason).toContain("other");
		expect(affinityReason).toContain("cache");

		const antiReason = affinityRejection(
			def,
			rule("anti-affinity", "yard"),
			context(placed("acme", "us-east")),
		);
		expect(antiReason).toContain("acme");
	});

	test("yard-scope rules ignore regions entirely", () => {
		expect(
			affinityRejection(
				def,
				rule("affinity", "yard"),
				context(placed("acme", "ap-south")),
			),
		).toBeUndefined();
	});
});

describe("affinity at region scope", () => {
	const def = definition({ regions: ["us-east", "eu-west"] });

	test("targets with no concrete region are ignored", () => {
		const ctx = context(placed("other", ""));
		expect(
			affinityRejection(def, rule("affinity", "region"), ctx),
		).toBeUndefined();
		expect(
			affinityRejection(def, rule("anti-affinity", "region"), ctx),
		).toBeUndefined();
	});

	test("affinity requires an overlapping advertised region", () => {
		expect(
			affinityRejection(
				def,
				rule("affinity", "region"),
				context(placed("p", "eu-west")),
			),
		).toBeUndefined();
		expect(
			affinityRejection(
				def,
				rule("affinity", "region"),
				context(placed("p", "ap-south")),
			),
		).toBeDefined();
	});

	test("anti-affinity requires an escape region, not merely a non-overlap", () => {
		const single = definition({ regions: ["us-east"] });
		expect(
			affinityRejection(
				single,
				rule("anti-affinity", "region"),
				context(placed("p", "us-east")),
			),
		).toBeDefined();
		expect(
			affinityRejection(
				def,
				rule("anti-affinity", "region"),
				context(placed("p", "us-east")),
			),
		).toBeUndefined();
	});

	test("anti-affinity passes when nothing overlaps at all", () => {
		const single = definition({ regions: ["ap-south"] });
		expect(
			affinityRejection(
				single,
				rule("anti-affinity", "region"),
				context(placed("p", "us-east")),
			),
		).toBeUndefined();
	});

	test("the rejection names the target regions, sorted", () => {
		const reason = affinityRejection(
			definition({ regions: ["ap-south"] }),
			rule("affinity", "region"),
			context(placed("p", "us-east"), placed("p", "eu-west")),
		);
		expect(reason).toContain("eu-west, us-east");
	});
});

describe("placementRejection", () => {
	test("a candidate meeting every criterion survives", () => {
		expect(
			placementRejection(
				definition({ features: ["tier=premium"] }),
				criteria({ selectors: [selector("eq", "tier", ["premium"])] }),
				emptyPlacementContext(),
			),
		).toBeUndefined();
	});

	test("the first failing selector short-circuits", () => {
		const reason = placementRejection(
			definition(),
			criteria({
				selectors: [
					selector("eq", "region", ["ap-south"]),
					selector("eq", "provider", ["nobody"]),
				],
			}),
			emptyPlacementContext(),
		);
		expect(reason).toContain("ap-south");
		expect(reason).not.toContain("nobody");
	});

	test("selectors are evaluated before affinities", () => {
		const reason = placementRejection(
			definition(),
			criteria({
				selectors: [selector("eq", "region", ["ap-south"])],
				affinities: [rule("anti-affinity", "yard")],
			}),
			context(placed("acme", "us-east")),
		);
		expect(reason).toContain("selector");
	});

	test("an affinity failure is reported when the selectors all pass", () => {
		const reason = placementRejection(
			definition(),
			criteria({ affinities: [rule("anti-affinity", "yard")] }),
			context(placed("acme", "us-east")),
		);
		expect(reason).toContain("anti-affinity");
	});

	test("empty criteria reject nothing", () => {
		expect(
			placementRejection(definition(), criteria(), emptyPlacementContext()),
		).toBeUndefined();
	});
});

describe("spreadSurvivors", () => {
	const candidates = [
		definition({ id: "a:db", providerId: "a" }),
		definition({ id: "b:db", providerId: "b" }),
		definition({ id: "c:db", providerId: "c" }),
	];

	test("with no spread declared every candidate survives", () => {
		expect(
			spreadSurvivors(candidates, intent(), emptyPlacementContext()),
		).toHaveLength(3);
	});

	test("a spread on another dimension is not applied here", () => {
		const withRegionSpread = intent({
			placement: criteria({ spread: { dimension: "region" } }),
		} as Partial<ResourceIntent>);
		expect(
			spreadSurvivors(
				candidates,
				withRegionSpread,
				context(placed("a", "us-east", "database")),
			),
		).toHaveLength(3);
	});

	test("it keeps only the providers carrying the fewest same-class placements", () => {
		const spread = intent({
			placement: criteria({ spread: { dimension: "yard" } }),
		} as Partial<ResourceIntent>);
		const survivors = spreadSurvivors(
			candidates,
			spread,
			context(placed("a", "us-east", "database")),
		);
		expect(survivors.map((s) => s.providerId)).toEqual(["b", "c"]);
	});

	test("placements of a different class do not count toward the spread", () => {
		const spread = intent({
			placement: criteria({ spread: { dimension: "yard" } }),
		} as Partial<ResourceIntent>);
		expect(
			spreadSurvivors(
				candidates,
				spread,
				context(placed("a", "us-east", "cache")),
			),
		).toHaveLength(3);
	});

	test("when every provider is equally loaded nothing is filtered", () => {
		const spread = intent({
			placement: criteria({ spread: { dimension: "yard" } }),
		} as Partial<ResourceIntent>);
		const survivors = spreadSurvivors(
			candidates,
			spread,
			context(
				placed("a", "us-east", "database"),
				placed("b", "us-east", "database"),
				placed("c", "us-east", "database"),
			),
		);
		expect(survivors).toHaveLength(3);
	});

	test("an empty candidate list is returned unchanged", () => {
		const spread = intent({
			placement: criteria({ spread: { dimension: "yard" } }),
		} as Partial<ResourceIntent>);
		expect(spreadSurvivors([], spread, emptyPlacementContext())).toEqual([]);
	});

	test("candidate order is preserved among survivors", () => {
		const spread = intent({
			placement: criteria({ spread: { dimension: "yard" } }),
		} as Partial<ResourceIntent>);
		const survivors = spreadSurvivors(
			candidates,
			spread,
			context(placed("b", "us-east", "database")),
		);
		expect(survivors.map((s) => s.id)).toEqual(["a:db", "c:db"]);
	});
});

describe("pickPlacementRegion", () => {
	const def = definition({ regions: ["us-east", "eu-west", "ap-south"] });

	test("an explicit region on the intent wins over everything", () => {
		const pinned = intent({
			region: "ap-south",
			placement: criteria({ affinities: [rule("anti-affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(pinned, def, context(placed("p", "ap-south"))),
		).toBe("ap-south");
	});

	test("with no criteria it picks the lexicographically smallest region", () => {
		expect(pickPlacementRegion(intent(), def, emptyPlacementContext())).toBe(
			"ap-south",
		);
	});

	test("a definition advertising no regions yields the empty string", () => {
		expect(
			pickPlacementRegion(
				intent(),
				definition({ regions: [] }),
				emptyPlacementContext(),
			),
		).toBe("");
	});

	test("region affinity narrows to the target's region", () => {
		const withAffinity = intent({
			placement: criteria({ affinities: [rule("affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withAffinity, def, context(placed("p", "us-east"))),
		).toBe("us-east");
	});

	test("region anti-affinity steers away from the target's region", () => {
		const withAnti = intent({
			placement: criteria({ affinities: [rule("anti-affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withAnti, def, context(placed("p", "ap-south"))),
		).toBe("eu-west");
	});

	test("an affinity that would empty the set is declined rather than applied", () => {
		const withAffinity = intent({
			placement: criteria({ affinities: [rule("affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withAffinity, def, context(placed("p", "sa-east"))),
		).toBe("ap-south");
	});

	test("an anti-affinity that would empty the set is declined too", () => {
		const single = definition({ regions: ["us-east"] });
		const withAnti = intent({
			placement: criteria({ affinities: [rule("anti-affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withAnti, single, context(placed("p", "us-east"))),
		).toBe("us-east");
	});

	test("yard-scope rules do not influence the region choice", () => {
		const withYardRule = intent({
			placement: criteria({ affinities: [rule("anti-affinity", "yard")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withYardRule, def, context(placed("p", "ap-south"))),
		).toBe("ap-south");
	});

	test("a rule whose targets carry no region is skipped", () => {
		const withAffinity = intent({
			placement: criteria({ affinities: [rule("affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withAffinity, def, context(placed("p", ""))),
		).toBe("ap-south");
	});

	test("region spread prefers the least-used region", () => {
		const spread = intent({
			placement: criteria({ spread: { dimension: "region" } }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(
				spread,
				def,
				context(placed("p", "ap-south", "database")),
			),
		).toBe("eu-west");
	});

	test("region spread ignores placements of another class", () => {
		const spread = intent({
			placement: criteria({ spread: { dimension: "region" } }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(
				spread,
				def,
				context(placed("p", "ap-south", "cache")),
			),
		).toBe("ap-south");
	});

	test("region spread does nothing when only one region remains", () => {
		const spread = intent({
			placement: criteria({ spread: { dimension: "region" } }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(
				spread,
				definition({ regions: ["us-east"] }),
				context(placed("p", "us-east", "database")),
			),
		).toBe("us-east");
	});

	test("affinity narrowing runs before the spread", () => {
		const both = intent({
			placement: criteria({
				affinities: [rule("affinity", "region")],
				spread: { dimension: "region" },
			}),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(
				both,
				def,
				context(
					placed("p", "us-east"),
					placed("p", "eu-west"),
					placed("q", "us-east", "database"),
				),
			),
		).toBe("eu-west");
	});

	test("the choice is deterministic across repeated calls", () => {
		const spread = intent({
			placement: criteria({ spread: { dimension: "region" } }),
		} as Partial<ResourceIntent>);
		const ctx = context(placed("p", "ap-south", "database"));
		const first = pickPlacementRegion(spread, def, ctx);
		for (let i = 0; i < 5; i++) {
			expect(pickPlacementRegion(spread, def, ctx)).toBe(first);
		}
	});

	test("it does not mutate the definition's region list", () => {
		const shared = definition({ regions: ["us-east", "ap-south"] });
		pickPlacementRegion(intent(), shared, emptyPlacementContext());
		expect(shared.regions).toEqual(["us-east", "ap-south"]);
	});
});

describe("emptyPlacementContext", () => {
	test("it starts with no decided placements", () => {
		expect(emptyPlacementContext().placements).toEqual([]);
	});

	test("two calls do not share the placement array", () => {
		const a = emptyPlacementContext();
		a.placements.push(placed("p", "us-east"));
		expect(emptyPlacementContext().placements).toEqual([]);
	});
});
