/**
 * The TrafficRouting port's parse boundary.
 *
 * A strict parse-don't-validate layer, and the strictness is the interesting
 * part. Three properties are load-bearing and each is pinned directly:
 *
 * **Unknown keys are refused, not ignored.** A typo'd field in a routing plan
 * would otherwise be silently dropped, and a dropped `weight` means traffic
 * splits differently from what the author wrote. Refusing turns a silent
 * misroute into a parse error.
 *
 * **A plan's rules may only reference backends the plan declares — and must
 * match them exactly.** Two copies of a backend that disagree on weight or
 * endpoint is a plan with two answers, so the cross-reference check compares
 * whole objects rather than just ids.
 *
 * **Every path in an error names where the failure was.** These documents nest
 * several levels; "invalid weight" without `plan.intent.rules[2].backends[1]`
 * is unactionable on anything real.
 */

import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";

import {
	parseBackendRef,
	parseMinAvailabilitySpec,
	parseResiliencySpec,
	parseRoutingMatch,
	parseRoutingPlan,
	parseRoutingProvider,
	parseRoutingRule,
	parseRoutingWeight,
	parseTrafficIntent,
	TrafficRoutingParseError,
} from "../src/ports/traffic-routing.js";

const backend = (overrides: JsonObject = {}) => ({
	id: "b1",
	service: "api",
	...overrides,
});

const rule = (overrides: JsonObject = {}) => ({
	backends: [backend()],
	...overrides,
});

const intent = (overrides: JsonObject = {}) => ({
	service: "api",
	tenantId: "t1",
	rules: [rule()],
	...overrides,
});

const plan = (overrides: JsonObject = {}) => ({
	planId: "p1",
	intent: intent(),
	backends: [backend()],
	createdAt: "2026-01-01T00:00:00Z",
	...overrides,
});

describe("parseRoutingWeight", () => {
	it.each([1, 50, 100])("accepts %d", (weight) => {
		expect(parseRoutingWeight(weight)).toBe(weight);
	});

	it.each([0, -1, 101, 1.5, "50", null, undefined])("rejects %s", (weight) => {
		expect(() => parseRoutingWeight(weight)).toThrow(TrafficRoutingParseError);
	});

	it("rejects above 100, since weights are percentages", () => {
		expect(() => parseRoutingWeight(101)).toThrow(TrafficRoutingParseError);
	});
});

describe("parseRoutingProvider", () => {
	it("rejects an unknown provider rather than passing it through", () => {
		expect(() => parseRoutingProvider("myproxy")).toThrow(
			TrafficRoutingParseError,
		);
	});

	it("rejects a non-string", () => {
		expect(() => parseRoutingProvider(7)).toThrow(TrafficRoutingParseError);
	});
});

describe("parseBackendRef", () => {
	it("parses a minimal backend", () => {
		expect(parseBackendRef(backend())).toMatchObject({
			id: "b1",
			service: "api",
		});
	});

	it("requires an id", () => {
		expect(() => parseBackendRef({ service: "api" })).toThrow(
			TrafficRoutingParseError,
		);
	});

	it("requires a service", () => {
		expect(() => parseBackendRef({ id: "b1" })).toThrow(
			TrafficRoutingParseError,
		);
	});

	it("refuses an unknown key rather than ignoring it", () => {
		// A dropped field means the plan does something other than what was
		// written, silently. Refusing makes that a parse error instead.
		expect(() => parseBackendRef(backend({ wieght: 50 }))).toThrow(
			TrafficRoutingParseError,
		);
	});

	it("names the failing path", () => {
		expect(() => parseBackendRef(backend({ weight: 0 }), "b")).toThrow(
			/b\.weight/u,
		);
	});

	it("omits optional fields rather than setting them undefined", () => {
		const parsed = parseBackendRef(backend());
		expect(parsed).not.toHaveProperty("weight");
		expect(parsed).not.toHaveProperty("endpoint");
		expect(parsed).not.toHaveProperty("locationHints");
	});

	it("keeps location hints when supplied", () => {
		expect(
			parseBackendRef(backend({ locationHints: ["eu-west-1"] })).locationHints,
		).toEqual(["eu-west-1"]);
	});

	it("rejects duplicate location hints", () => {
		expect(() =>
			parseBackendRef(backend({ locationHints: ["eu", "eu"] })),
		).toThrow(TrafficRoutingParseError);
	});

	it("freezes the result", () => {
		expect(Object.isFrozen(parseBackendRef(backend()))).toBe(true);
	});

	it.each([
		null,
		undefined,
		"b1",
		7,
		[],
	])("rejects the non-record %s", (raw) => {
		expect(() => parseBackendRef(raw)).toThrow(TrafficRoutingParseError);
	});
});

describe("parseRoutingRule", () => {
	it("defaults the weight strategy to static", () => {
		// An absent strategy must be a definite one, not undefined behaviour.
		expect(parseRoutingRule(rule()).weightStrategy).toBe("static");
	});

	it("rejects an unknown weight strategy", () => {
		expect(() => parseRoutingRule(rule({ weightStrategy: "random" }))).toThrow(
			TrafficRoutingParseError,
		);
	});

	it("requires a backend list", () => {
		expect(() => parseRoutingRule({})).toThrow(TrafficRoutingParseError);
	});

	it("rejects duplicate backend ids within one rule", () => {
		// Two entries for one backend is a rule with two answers for it.
		expect(() =>
			parseRoutingRule(rule({ backends: [backend(), backend()] })),
		).toThrow(/unique backend id/u);
	});

	it("names the index of the duplicate", () => {
		expect(() =>
			parseRoutingRule(rule({ backends: [backend(), backend()] }), "r"),
		).toThrow(/r\.backends\[1\]\.id/u);
	});

	it("omits match when absent", () => {
		expect(parseRoutingRule(rule())).not.toHaveProperty("match");
	});

	it("keeps a match when supplied", () => {
		expect(
			parseRoutingRule(rule({ match: { pathPrefix: "/api" } })).match,
		).toMatchObject({ pathPrefix: "/api" });
	});
});

describe("parseRoutingMatch", () => {
	it("accepts an empty match", () => {
		expect(parseRoutingMatch({})).toEqual({});
	});

	it("refuses an unknown key", () => {
		expect(() => parseRoutingMatch({ pathPrefixx: "/a" })).toThrow(
			TrafficRoutingParseError,
		);
	});

	it("freezes the result", () => {
		expect(Object.isFrozen(parseRoutingMatch({}))).toBe(true);
	});
});

describe("parseMinAvailabilitySpec", () => {
	it("accepts an empty spec", () => {
		expect(parseMinAvailabilitySpec({})).toEqual({});
	});

	it("accepts positive counts", () => {
		expect(
			parseMinAvailabilitySpec({
				minHealthyBackends: 2,
				minDistinctLocations: 2,
			}),
		).toMatchObject({ minHealthyBackends: 2, minDistinctLocations: 2 });
	});

	it.each([0, -1, 1.5])("rejects the count %s", (value) => {
		// A minimum of zero is not a minimum; it is the absence of one, and
		// should be expressed by omitting the field.
		expect(() =>
			parseMinAvailabilitySpec({ minHealthyBackends: value }),
		).toThrow(TrafficRoutingParseError);
	});

	it("refuses an unknown key", () => {
		expect(() => parseMinAvailabilitySpec({ minHealthy: 2 })).toThrow(
			TrafficRoutingParseError,
		);
	});
});

describe("parseResiliencySpec", () => {
	it("accepts an empty spec", () => {
		expect(parseResiliencySpec({})).toEqual({});
	});

	it("accepts zero retries but not a zero timeout", () => {
		// Zero retries is a real choice — "try once". A zero timeout is not a
		// timeout, so the two use different numeric guards on purpose.
		expect(parseResiliencySpec({ retries: 0 }).retries).toBe(0);
		expect(() => parseResiliencySpec({ timeoutMs: 0 })).toThrow(
			TrafficRoutingParseError,
		);
	});

	it("rejects negative retries", () => {
		expect(() => parseResiliencySpec({ retries: -1 })).toThrow(
			TrafficRoutingParseError,
		);
	});

	it("accepts a positive timeout", () => {
		expect(parseResiliencySpec({ timeoutMs: 5_000 }).timeoutMs).toBe(5_000);
	});

	it("refuses an unknown key", () => {
		expect(() => parseResiliencySpec({ timeout: 5 })).toThrow(
			TrafficRoutingParseError,
		);
	});
});

describe("parseTrafficIntent", () => {
	it("parses a minimal intent", () => {
		expect(parseTrafficIntent(intent())).toMatchObject({
			service: "api",
			tenantId: "t1",
		});
	});

	it("requires rules", () => {
		expect(() =>
			parseTrafficIntent({ service: "api", tenantId: "t1" }),
		).toThrow(TrafficRoutingParseError);
	});

	it("names the index of a failing rule", () => {
		expect(() =>
			parseTrafficIntent(intent({ rules: [rule(), { backends: [] }] })),
		).toThrow(/rules\[1\]/u);
	});

	it("refuses an unknown key", () => {
		expect(() => parseTrafficIntent(intent({ tenant: "t1" }))).toThrow(
			TrafficRoutingParseError,
		);
	});
});

describe("parseRoutingPlan cross-references", () => {
	it("parses a consistent plan", () => {
		expect(parseRoutingPlan(plan()).planId).toBe("p1");
	});

	it("rejects a rule referencing an undeclared backend", () => {
		// A plan that routes to something it never declared is a plan whose
		// backends list is not the source of truth it claims to be.
		expect(() =>
			parseRoutingPlan(
				plan({
					intent: intent({
						rules: [rule({ backends: [backend({ id: "b9" })] })],
					}),
				}),
			),
		).toThrow(/backend declared in plan\.backends/u);
	});

	it("names the exact rule and backend index that failed", () => {
		expect(() =>
			parseRoutingPlan(
				plan({
					intent: intent({
						rules: [rule(), rule({ backends: [backend({ id: "b9" })] })],
					}),
				}),
			),
		).toThrow(/plan\.intent\.rules\[1\]\.backends\[0\]\.id/u);
	});

	it("rejects a backend that matches by id but differs in detail", () => {
		// Two copies that disagree on weight is a plan with two answers. The
		// check compares whole objects rather than just ids for this reason.
		expect(() =>
			parseRoutingPlan(
				plan({
					backends: [backend({ weight: 50 })],
					intent: intent({
						rules: [rule({ backends: [backend({ weight: 30 })] })],
					}),
				}),
			),
		).toThrow(/exactly matching its plan\.backends declaration/u);
	});

	it("accepts identical copies of a backend", () => {
		expect(() =>
			parseRoutingPlan(
				plan({
					backends: [backend({ weight: 50 })],
					intent: intent({
						rules: [rule({ backends: [backend({ weight: 50 })] })],
					}),
				}),
			),
		).not.toThrow();
	});

	it("rejects duplicate ids in the plan's own backend list", () => {
		expect(() =>
			parseRoutingPlan(plan({ backends: [backend(), backend()] })),
		).toThrow(/unique backend id/u);
	});

	it("requires a created-at instant", () => {
		expect(() =>
			parseRoutingPlan({
				planId: "p1",
				intent: intent(),
				backends: [backend()],
			}),
		).toThrow(TrafficRoutingParseError);
	});

	it.each([
		"2026-01-01",
		"not-a-date",
		"2026-01-01 00:00:00Z",
	])("rejects the malformed instant %s", (createdAt) => {
		expect(() => parseRoutingPlan(plan({ createdAt }))).toThrow(
			TrafficRoutingParseError,
		);
	});

	it.each([
		"2026-01-01T00:00:00Z",
		"2026-01-01T00:00:00.123Z",
		"2026-01-01T00:00:00+01:00",
	])("accepts the instant %s", (createdAt) => {
		expect(() => parseRoutingPlan(plan({ createdAt }))).not.toThrow();
	});

	it("omits optional plan fields rather than setting them undefined", () => {
		const parsed = parseRoutingPlan(plan());
		expect(parsed).not.toHaveProperty("stationId");
		expect(parsed).not.toHaveProperty("degraded");
		expect(parsed).not.toHaveProperty("notes");
	});

	it("keeps degraded when explicitly false", () => {
		// `false` is a statement, not an absence; dropping it would lose the
		// distinction between "not degraded" and "not measured".
		expect(parseRoutingPlan(plan({ degraded: false })).degraded).toBe(false);
	});

	it("rejects a non-boolean degraded", () => {
		expect(() => parseRoutingPlan(plan({ degraded: "no" }))).toThrow(
			TrafficRoutingParseError,
		);
	});

	it("keeps notes when supplied", () => {
		expect(
			parseRoutingPlan(plan({ notes: ["fallback applied"] })).notes,
		).toEqual(["fallback applied"]);
	});

	it("refuses an unknown plan key", () => {
		expect(() => parseRoutingPlan(plan({ plan_id: "p1" }))).toThrow(
			TrafficRoutingParseError,
		);
	});

	it("freezes the plan", () => {
		expect(Object.isFrozen(parseRoutingPlan(plan()))).toBe(true);
	});

	it("is deterministic", () => {
		expect(parseRoutingPlan(plan())).toEqual(parseRoutingPlan(plan()));
	});
});
