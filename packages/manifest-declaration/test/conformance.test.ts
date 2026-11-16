import { describe, expect, it } from "vitest";

import {
	parseResourceIntent,
	RESOURCE_INTENT_SCHEMA,
	ResourceIntentError,
} from "../src/index.js";

/**
 * Conformance suite for the parse boundary.
 *
 * Every assertion names the *specific* refusal it means. A bare
 * `expect(...).toThrow()` here would pass whether the boundary refused for the
 * reason under test, for an unrelated reason, or because a typo in the test
 * threw a `TypeError` before the boundary was ever reached — which is how three
 * tests in this repository went green for years while testing nothing. The
 * matcher is therefore always the full message, and each case also asserts the
 * error class and the `path` that names the offending field.
 */

const VALID = {
	name: "cache",
	port: "kv",
	require: [],
	prefer: [],
	negotiation: "require",
	deps: [],
	objective: "min-cost",
};

function refusal<T>(input: T): ResourceIntentError {
	try {
		parseResourceIntent(input);
	} catch (error) {
		if (error instanceof ResourceIntentError) return error;
		throw new Error(`expected a ResourceIntentError, got ${String(error)}`, {
			cause: error,
		});
	}
	throw new Error("expected parseResourceIntent to refuse, but it returned");
}

describe("the schema id", () => {
	it("is the wire identity the PACT body names", () => {
		expect(RESOURCE_INTENT_SCHEMA).toBe("hobo.resource-intent/v1");
	});
});

describe("accepts a minimal valid declaration", () => {
	it("returns a frozen value with no invented keys", () => {
		const parsed = parseResourceIntent(VALID);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.keys(parsed).sort()).toEqual([
			"deps",
			"name",
			"negotiation",
			"objective",
			"port",
			"prefer",
			"require",
		]);
	});
});

describe("shape refusals", () => {
	it("refuses a non-object", () => {
		const error = refusal("not an object");
		expect(error.message).toBe(
			"resource intent $: expected an object, got string",
		);
		expect(error.path).toBe("$");
		expect(error.code).toBe("INVALID_RESOURCE_INTENT");
	});

	it("refuses null, distinctly from any other non-object", () => {
		expect(refusal(null).message).toBe(
			"resource intent $: expected an object, got null",
		);
	});

	it("refuses an array", () => {
		expect(refusal([]).message).toBe(
			"resource intent $: expected an object, got an array",
		);
	});

	it("refuses an unknown field rather than dropping it", () => {
		const error = refusal({ ...VALID, provider: "neon" });
		expect(error.message).toBe(
			"resource intent $.provider: unknown field; expected one of name, port, require, prefer, negotiation, deps, region, objective, placement",
		);
		expect(error.path).toBe("$.provider");
	});
});

describe("required string refusals", () => {
	it("refuses a missing name", () => {
		const { name: _dropped, ...withoutName } = VALID;
		expect(refusal(withoutName).message).toBe(
			"resource intent $.name: expected a string, got undefined",
		);
	});

	it("refuses an empty name", () => {
		expect(refusal({ ...VALID, name: "" }).message).toBe(
			"resource intent $.name: must not be empty",
		);
	});

	it("refuses an empty port", () => {
		expect(refusal({ ...VALID, port: "" }).message).toBe(
			"resource intent $.port: must not be empty",
		);
	});

	it("accepts a namespaced port, which the repository actually uses", () => {
		expect(parseResourceIntent({ ...VALID, port: "hobo:database" }).port).toBe(
			"hobo:database",
		);
	});

	it("refuses an empty objective", () => {
		expect(refusal({ ...VALID, objective: "" }).message).toBe(
			"resource intent $.objective: must not be empty",
		);
	});
});

describe("negotiation vocabulary", () => {
	it("accepts both members", () => {
		expect(
			parseResourceIntent({ ...VALID, negotiation: "prefer" }).negotiation,
		).toBe("prefer");
		expect(parseResourceIntent(VALID).negotiation).toBe("require");
	});

	it("refuses a value outside the closed vocabulary", () => {
		expect(refusal({ ...VALID, negotiation: "maybe" }).message).toBe(
			'resource intent $.negotiation: "maybe" is not one of require | prefer',
		);
	});
});

describe("list refusals", () => {
	it("refuses a non-array require", () => {
		expect(refusal({ ...VALID, require: "http" }).message).toBe(
			"resource intent $.require: expected an array, got string",
		);
	});

	it("refuses an empty entry, naming its index", () => {
		expect(refusal({ ...VALID, require: ["http", ""] }).message).toBe(
			"resource intent $.require[1]: must not be empty",
		);
	});

	it("refuses a duplicate feature", () => {
		expect(refusal({ ...VALID, require: ["http", "http"] }).message).toBe(
			'resource intent $.require[1]: duplicate entry "http"',
		);
	});

	it("refuses a duplicate dependency", () => {
		expect(refusal({ ...VALID, deps: ["db", "db"] }).message).toBe(
			'resource intent $.deps[1]: duplicate entry "db"',
		);
	});

	it("preserves authored order rather than normalising it", () => {
		const parsed = parseResourceIntent({
			...VALID,
			deps: ["zeta", "alpha", "mid"],
		});
		expect(parsed.deps).toEqual(["zeta", "alpha", "mid"]);
	});

	it("refuses a resource that depends on itself", () => {
		const error = refusal({
			...VALID,
			name: "cache",
			deps: ["other", "cache"],
		});
		expect(error.message).toBe(
			'resource intent $.deps: resource "cache" cannot depend on itself',
		);
		expect(error.path).toBe("$.deps");
	});
});

describe("placement selector refusals", () => {
	function withSelector<T>(selector: T) {
		return { ...VALID, placement: { selectors: [selector], affinities: [] } };
	}

	it("refuses an unknown operator", () => {
		expect(
			refusal(withSelector({ key: "region", op: "matches", values: ["x"] }))
				.message,
		).toBe(
			'resource intent $.placement.selectors[0].op: "matches" is not one of eq | ne | in | not-in | lt | lte | gt | gte | exists',
		);
	});

	it("refuses an empty selector key", () => {
		expect(
			refusal(withSelector({ key: "", op: "eq", values: ["x"] })).message,
		).toBe("resource intent $.placement.selectors[0].key: must not be empty");
	});

	it("refuses a comparison operator with no operand", () => {
		// @hobo/cloud's evaluator reads values[0]; with none it compares against
		// undefined and rejects every candidate without saying why.
		expect(
			refusal(withSelector({ key: "region", op: "eq", values: [] })).message,
		).toBe(
			'resource intent $.placement.selectors[0].values: the "eq" operator needs at least one operand',
		);
	});

	it("refuses an exists operator carrying operands", () => {
		expect(
			refusal(
				withSelector({ key: "encryption", op: "exists", values: ["aes"] }),
			).message,
		).toBe(
			'resource intent $.placement.selectors[0].values: the "exists" operator is a presence test and takes no operands',
		);
	});

	it("accepts the exists operator with no operands", () => {
		const parsed = parseResourceIntent(
			withSelector({ key: "encryption", op: "exists", values: [] }),
		);
		expect(parsed.placement?.selectors[0]?.values).toEqual([]);
	});

	it("refuses an unknown field inside a selector", () => {
		expect(
			refusal(
				withSelector({ key: "region", op: "eq", values: ["x"], negate: true }),
			).message,
		).toBe(
			"resource intent $.placement.selectors[0].negate: unknown field; expected one of key, op, values",
		);
	});
});

describe("placement affinity refusals", () => {
	function withAffinity<T>(rule: T) {
		return { ...VALID, placement: { selectors: [], affinities: [rule] } };
	}

	it("refuses an unknown mode", () => {
		expect(
			refusal(withAffinity({ mode: "near", targetPort: "kv", scope: "yard" }))
				.message,
		).toBe(
			'resource intent $.placement.affinities[0].mode: "near" is not one of affinity | anti-affinity',
		);
	});

	it("refuses an unknown scope", () => {
		expect(
			refusal(
				withAffinity({ mode: "affinity", targetPort: "kv", scope: "rack" }),
			).message,
		).toBe(
			'resource intent $.placement.affinities[0].scope: "rack" is not one of region | yard',
		);
	});

	it("refuses an empty target port", () => {
		expect(
			refusal(withAffinity({ mode: "affinity", targetPort: "", scope: "yard" }))
				.message,
		).toBe(
			"resource intent $.placement.affinities[0].targetPort: must not be empty",
		);
	});
});

describe("placement cardinality refusals", () => {
	function withPickN<T>(pickN: T) {
		return { ...VALID, placement: { selectors: [], affinities: [], pickN } };
	}

	it("refuses a cardinality of zero", () => {
		expect(refusal(withPickN({ count: 0 })).message).toBe(
			"resource intent $.placement.pickN.count: must be at least 1, got 0",
		);
	});

	it("refuses a negative cardinality", () => {
		expect(refusal(withPickN({ count: -1 })).message).toBe(
			"resource intent $.placement.pickN.count: must be at least 1, got -1",
		);
	});

	it("refuses a non-integer cardinality", () => {
		expect(refusal(withPickN({ count: 1.5 })).message).toBe(
			"resource intent $.placement.pickN.count: expected an integer, got 1.5",
		);
	});

	it("refuses a cardinality that does not fit the uint32 the wire form declares", () => {
		expect(refusal(withPickN({ count: 4_294_967_296 })).message).toBe(
			"resource intent $.placement.pickN.count: must fit in uint32, got 4294967296",
		);
	});

	it("accepts the largest cardinality the wire form can carry", () => {
		expect(
			parseResourceIntent(withPickN({ count: 4_294_967_295 })).placement?.pickN
				?.count,
		).toBe(4_294_967_295);
	});
});

describe("placement spread refusals", () => {
	it("refuses an unknown dimension", () => {
		expect(
			refusal({
				...VALID,
				placement: {
					selectors: [],
					affinities: [],
					spread: { dimension: "az" },
				},
			}).message,
		).toBe(
			'resource intent $.placement.spread.dimension: "az" is not one of region | yard',
		);
	});

	it("refuses a missing selectors list rather than defaulting it", () => {
		expect(refusal({ ...VALID, placement: { affinities: [] } }).message).toBe(
			"resource intent $.placement.selectors: expected an array, got undefined",
		);
	});

	it("refuses a missing affinities list rather than defaulting it", () => {
		expect(refusal({ ...VALID, placement: { selectors: [] } }).message).toBe(
			"resource intent $.placement.affinities: expected an array, got undefined",
		);
	});
});
