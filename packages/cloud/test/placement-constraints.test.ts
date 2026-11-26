/**
 * Placement criteria are HARD filters applied between capability negotiation and
 * objective ranking. That position is the whole point: they narrow the candidate
 * set without touching the lexicographic `specificity → priority → objective →
 * id` ranking among the survivors. Two consequences make this code worth testing
 * exhaustively rather than by example.
 *
 * First, a filter that is too *loose* silently places a workload somewhere the
 * operator forbade — anti-affinity that fails to exclude is indistinguishable
 * from no rule at all, right up until both replicas die with the same yard.
 * Second, a filter that is too *tight* empties the candidate set and turns a
 * deployable request into an unplaceable one, which is why several branches here
 * deliberately decline to narrow: a rule with no decided target yet is vacuously
 * satisfied, and a region filter that would leave nothing keeps what it had.
 *
 * Both failure directions are invisible on a single well-formed example, so this
 * file drives every selector operator, both affinity modes at both scopes, and
 * the "declines to narrow" branches explicitly.
 */
import { describe, expect, test } from "vitest";

import type {
	PlacementAffinityRule,
	PlacementCriteria,
	PlacementPropertySelector,
	ResourceIntent,
} from "../src/plan-types.js";
// Imported from the module rather than the package index: these are internal
// planner helpers that `src/index.ts` deliberately does not re-export.
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
	// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
	return { key, op, values } as PlacementPropertySelector;
}

function rule(
	mode: PlacementAffinityRule["mode"],
	scope: PlacementAffinityRule["scope"],
	targetPort = "cache",
): PlacementAffinityRule {
	// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
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
	// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
	return { resource: "db", port: "database", ...overrides } as ResourceIntent;
}

function criteria(
	overrides: Partial<PlacementCriteria> = {},
): PlacementCriteria {
	// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
	return {
		selectors: [],
		affinities: [],
		...overrides,
	} as PlacementCriteria;
}

describe("property resolution", () => {
	test("the well-known keys read the definition record, not features", () => {
		// `region`, `provider` and `cost` are structural fields. Reading them from
		// features would make every candidate fail a selector on them.
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
		// This is how a provider advertises arbitrary placement properties
		// without the planner needing to know their names.
		const def = definition({ features: ["tier=premium", "zone=a"] });
		expect(
			selectorRejection(def, selector("eq", "tier", ["premium"])),
		).toBeUndefined();
		expect(
			selectorRejection(def, selector("eq", "zone", ["a"])),
		).toBeUndefined();
	});

	test("several values for one key are all resolved", () => {
		// A multi-valued property must match if *any* value matches, or a
		// candidate advertising two zones would be rejected for both.
		const def = definition({ features: ["zone=a", "zone=b"] });
		expect(
			selectorRejection(def, selector("eq", "zone", ["b"])),
		).toBeUndefined();
	});

	test("a bare feature token resolves for exists but has no value", () => {
		// `gpu` with no `=` is a presence flag. Treating it as a value would make
		// `gpu eq gpu` true, which reads as nonsense in a manifest.
		const def = definition({ features: ["gpu"] });
		expect(selectorRejection(def, selector("exists", "gpu"))).toBeUndefined();
		expect(
			selectorRejection(def, selector("eq", "gpu", ["gpu"])),
		).toBeUndefined();
	});

	test("a key=value entry suppresses the bare-token fallback", () => {
		// The fallback only fires when no `key=` entry matched, so a candidate
		// advertising `tier=basic` must not also count as bare `tier`.
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
		// Otherwise a selector on `zone` would pick up `zonal=true`.
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
		// `ne` is an exclusion, so it must consider *all* values. Checking only
		// one would let a candidate advertising the forbidden region through
		// because some other region also matched.
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
		// `every` over an empty list is true. Worth pinning deliberately: a
		// candidate that advertises nothing satisfies every exclusion, which is
		// the permissive reading. An operator writing `ne tier=free` to exclude
		// free tiers will not exclude a candidate that declares no tier at all.
		const bare = definition({ features: [] });
		expect(
			selectorRejection(bare, selector("ne", "tier", ["free"])),
		).toBeUndefined();
		expect(
			selectorRejection(bare, selector("not-in", "tier", ["free"])),
		).toBeUndefined();
	});

	test("lt, lte, gt and gte compare numerically, not lexically", () => {
		// String comparison would make "0.50" >= "0.9" true. Cost filters are the
		// main user of these, so a lexical compare would pick expensive
		// candidates while claiming to cap spend.
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
		// Fail closed: an unparseable bound must not be read as "no constraint",
		// or a typo'd cost cap would silently stop capping.
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
		// `Number.parseFloat("Infinity")` is finite-checked away; without that a
		// bound of Infinity would make every `lt` pass unconditionally.
		expect(
			selectorRejection(def, selector("lt", "cost", ["Infinity"])),
		).toBeDefined();
		expect(
			selectorRejection(def, selector("lt", "cost", ["NaN"])),
		).toBeDefined();
	});

	test("a rejection reason names the key, the operator and what was advertised", () => {
		// The reason is shown to whoever's deploy just failed; without the
		// advertised values they cannot tell whether to fix the rule or the
		// provider.
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
		// The planner visits intents in a byte-stable order, so a rule whose
		// target has not been placed yet cannot be evaluated. Rejecting instead
		// would make placement depend on declaration order.
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
		// A rule about the cache class must not be satisfied by a queue
		// placement that happens to share a provider.
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
		// The failure this prevents: two replicas that were meant to be isolated
		// landing on one yard and dying together.
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
		// Colocation at yard scope is about the provider; a matching provider in
		// a different region is still colocated.
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
		// A placement whose region was never resolved carries no information; a
		// rule evaluated against it would filter on the empty string.
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
		// The distinction that matters: a candidate advertising *only* the
		// forbidden region has nowhere to go and must be rejected, but one that
		// also advertises another region is fine — the concrete choice is made
		// later by pickPlacementRegion.
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
		// Reporting the first failure keeps the message actionable; a candidate
		// that fails five rules produces one reason, not five.
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
		// Selectors are cheap and context-free; affinities depend on prior
		// placements. Evaluating them in the other order would make the reported
		// reason depend on how much of the plan had been decided.
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
		// Spread is opt-in; filtering by default would silently change ranking
		// for every intent that never asked for it.
		expect(
			spreadSurvivors(candidates, intent(), emptyPlacementContext()),
		).toHaveLength(3);
	});

	test("a spread on another dimension is not applied here", () => {
		// Region spread is handled in pickPlacementRegion, not by filtering
		// candidates — applying it here would drop providers for the wrong reason.
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
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
		// This is the spread itself: once provider `a` holds a database, the
		// next database goes to `b` or `c`.
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
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
		// A cache on provider `a` says nothing about how databases are spread.
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
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
		// The filter is on the *minimum*, so a uniformly loaded set keeps all its
		// candidates rather than collapsing to one.
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
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
		// `Math.min()` of nothing is Infinity, and filtering against that would
		// be meaningless — the early return is what keeps this well-defined.
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const spread = intent({
			placement: criteria({ spread: { dimension: "yard" } }),
		} as Partial<ResourceIntent>);
		expect(spreadSurvivors([], spread, emptyPlacementContext())).toEqual([]);
	});

	test("candidate order is preserved among survivors", () => {
		// Ranking happens after this filter and expects the lexicographic order
		// it was given; reordering here would perturb the tie-break.
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
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
		// The user asked for it by name; no derived rule may override that.
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const pinned = intent({
			region: "ap-south",
			placement: criteria({ affinities: [rule("anti-affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(pinned, def, context(placed("p", "ap-south"))),
		).toBe("ap-south");
	});

	test("with no criteria it picks the lexicographically smallest region", () => {
		// The deterministic pre-E19 rule; anything order-dependent would make
		// two identical plans differ.
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
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const withAffinity = intent({
			placement: criteria({ affinities: [rule("affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withAffinity, def, context(placed("p", "us-east"))),
		).toBe("us-east");
	});

	test("region anti-affinity steers away from the target's region", () => {
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const withAnti = intent({
			placement: criteria({ affinities: [rule("anti-affinity", "region")] }),
		} as Partial<ResourceIntent>);
		// Without the rule this would pick ap-south; the rule must move it off
		// whatever the target holds.
		expect(
			pickPlacementRegion(withAnti, def, context(placed("p", "ap-south"))),
		).toBe("eu-west");
	});

	test("an affinity that would empty the set is declined rather than applied", () => {
		// The `if (kept.length > 0)` guard. Narrowing to nothing would return the
		// empty string and place the resource nowhere — worse than ignoring a
		// rule that cannot be honoured.
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const withAffinity = intent({
			placement: criteria({ affinities: [rule("affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withAffinity, def, context(placed("p", "sa-east"))),
		).toBe("ap-south");
	});

	test("an anti-affinity that would empty the set is declined too", () => {
		const single = definition({ regions: ["us-east"] });
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const withAnti = intent({
			placement: criteria({ affinities: [rule("anti-affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withAnti, single, context(placed("p", "us-east"))),
		).toBe("us-east");
	});

	test("yard-scope rules do not influence the region choice", () => {
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const withYardRule = intent({
			placement: criteria({ affinities: [rule("anti-affinity", "yard")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withYardRule, def, context(placed("p", "ap-south"))),
		).toBe("ap-south");
	});

	test("a rule whose targets carry no region is skipped", () => {
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const withAffinity = intent({
			placement: criteria({ affinities: [rule("affinity", "region")] }),
		} as Partial<ResourceIntent>);
		expect(
			pickPlacementRegion(withAffinity, def, context(placed("p", ""))),
		).toBe("ap-south");
	});

	test("region spread prefers the least-used region", () => {
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const spread = intent({
			placement: criteria({ spread: { dimension: "region" } }),
		} as Partial<ResourceIntent>);
		// ap-south would win lexicographically, but it already carries a
		// same-class placement, so the spread moves off it.
		expect(
			pickPlacementRegion(
				spread,
				def,
				context(placed("p", "ap-south", "database")),
			),
		).toBe("eu-west");
	});

	test("region spread ignores placements of another class", () => {
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
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
		// The `regions.length > 1` guard: with a single option there is nothing
		// to spread across, and the usage scan would be wasted work.
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
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
		// Order matters: spreading first could pick a region the affinity then
		// forbids, and the affinity pass would have nothing left to narrow.
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
		const both = intent({
			placement: criteria({
				affinities: [rule("affinity", "region")],
				spread: { dimension: "region" },
			}),
		} as Partial<ResourceIntent>);
		// Affinity pins the set to {us-east, eu-west}; spread then avoids the
		// one already carrying a database.
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
		// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
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
		// The definition is shared across candidates in a plan pass; sorting it
		// in place would reorder what a later intent sees.
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
		// The context accumulates as a plan pass proceeds; a shared array would
		// leak one plan's decisions into the next.
		const a = emptyPlacementContext();
		a.placements.push(placed("p", "us-east"));
		expect(emptyPlacementContext().placements).toEqual([]);
	});
});
