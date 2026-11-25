import { sortKeys as coreSortKeys } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	canonicalPlanJson,
	DEPLOYMENT_PLAN_SCHEMA,
	hashDeploymentPlan,
	type JsonObject,
	parseDeploymentPlan,
} from "../src/index.js";

/**
 * The canonical form is part of the contract, so the one thing that could
 * quietly change every plan digest gets its own suite.
 *
 * `@hobo/core` exports a `sortKeys` with the same name, the same signature and
 * the same doc-comment intent as the one `@hobo/cloud` keeps private, and
 * "reuse the shared helper" is an obvious, plausible, and wrong change to make
 * to this package. It is wrong because the two comparators are different:
 * core sorts with `localeCompare` (ICU collation, case-insensitive at the
 * primary level), and the plan digest is defined over the default comparator
 * (UTF-16 code unit order). This test pins the disagreement so the swap cannot
 * land silently.
 */

const planWith = (parameters: JsonObject) => ({
	schema: DEPLOYMENT_PLAN_SCHEMA,
	resources: [
		{
			name: "sessions",
			port: "kv",
			provider: "@hobo/provider-cloudflare",
			deps: [],
			realizationParameters: parameters,
		},
	],
	dependencyOrder: ["sessions"],
	objective: "min-cost",
});

describe("@hobo/core's sortKeys is not the plan canonicalization", () => {
	it.each([
		[{ Tier: 1, tier: 2 }, ["Tier", "tier"], ["tier", "Tier"]],
		[{ tierA: 1, tier_2: 2 }, ["tierA", "tier_2"], ["tier_2", "tierA"]],
		[
			{ TTLSeconds: 1, ttlSeconds: 2 },
			["TTLSeconds", "ttlSeconds"],
			["ttlSeconds", "TTLSeconds"],
		],
	])("disagrees on %j: plan order %j, core order %j", (parameters, planOrder, coreOrder) => {
		expect(Object.keys(parameters).sort()).toEqual(planOrder);
		expect(Object.keys(coreSortKeys(parameters))).toEqual(coreOrder);
		expect(planOrder).not.toEqual(coreOrder);
	});

	it("the disagreement reaches the digest, because parameter keys are author-supplied", () => {
		const parameters = { Tier: "gold", tier: "silver" };
		const parsed = parseDeploymentPlan(planWith(parameters));

		const viaPlan = canonicalPlanJson(parsed);
		const viaCore = JSON.stringify(coreSortKeys(parsed));
		expect(viaPlan).not.toBe(viaCore);
		expect(viaPlan).toContain('{"Tier":"gold","tier":"silver"}');
		expect(viaCore).toContain('{"tier":"silver","Tier":"gold"}');
	});

	it("agrees on the fixed field names, which is why the divergence is easy to miss", () => {
		const parsed = parseDeploymentPlan(planWith({ tier: "gold" }));
		expect(canonicalPlanJson(parsed)).toBe(
			JSON.stringify(coreSortKeys(parsed)),
		);
	});
});

describe("the canonical form itself", () => {
	it("emits no whitespace and no trailing newline", () => {
		const parsed = parseDeploymentPlan(planWith({ tier: "gold" }));
		const json = canonicalPlanJson(parsed);
		expect(json.startsWith('{"dependencyOrder"')).toBe(true);
		expect(json.endsWith("}")).toBe(true);
		expect(json).not.toContain("\n");
		expect(json).not.toContain("  ");
	});

	it("sorts keys at every depth, leaving arrays in place", () => {
		const parsed = parseDeploymentPlan(
			planWith({ zulu: 1, alpha: { z: 1, a: 2 } }),
		);
		expect(canonicalPlanJson(parsed)).toContain(
			'"realizationParameters":{"alpha":{"a":2,"z":1},"zulu":1}',
		);
	});

	it("hashes the canonical bytes, not the object", () => {
		const a = parseDeploymentPlan(planWith({ b: 1, a: 2 }));
		const b = parseDeploymentPlan(planWith({ a: 2, b: 1 }));
		expect(canonicalPlanJson(a)).toBe(canonicalPlanJson(b));
		expect(hashDeploymentPlan(a)).toBe(hashDeploymentPlan(b));
	});
});
