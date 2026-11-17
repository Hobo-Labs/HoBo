import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../../src/json.js";
import {
	createVercelTrafficRouting,
	type VercelTrafficRoutingOptions,
} from "../../src/traffic-routing/vercel.js";

type FixtureBackend = {
	id: string;
	service: string;
	weight?: number;
	endpoint?: string;
};
type FixtureRule = {
	weightStrategy: string;
	backends: FixtureBackend[];
	match?: { pathPrefix?: string; headers?: Record<string, string> } | undefined;
};

function stubFetch(
	body: JsonValue = { version: { id: "ver_1" } },
): typeof fetch {
	return async () => {
		const response = new Response(null, { status: 200 });
		response.json = async () => body;
		return response;
	};
}

const routing = (options: Partial<VercelTrafficRoutingOptions> = {}) =>
	createVercelTrafficRouting({
		token: "vt-token",
		projectIdOrName: "proj",
		fetchImpl: stubFetch(),
		deploymentIdsByBackend: {
			stable: "dpl_stable",
			canary: "dpl_canary",
			a: "dpl_a",
			b: "dpl_b",
			c: "dpl_c",
		},
		...options,
	});

const canaryRule = (overrides: Partial<FixtureRule> = {}) => ({
	weightStrategy: "static",
	backends: [
		{ id: "stable", service: "web", weight: 90 },
		{ id: "canary", service: "web", weight: 10 },
	],
	...overrides,
});

const rewriteRule = (overrides: Partial<FixtureRule> = {}) => ({
	weightStrategy: "static",
	match: { pathPrefix: "/api" },
	backends: [
		{ id: "api", service: "api", endpoint: "https://api.example.com" },
	],
	...overrides,
});

let planCounter = 0;

const plan = (rules: FixtureRule[], intent: JsonObject = {}) => {
	planCounter += 1;
	return {
		planId: `plan-${planCounter}`,
		intent: { service: "web", tenantId: "t1", rules, ...intent },
		backends: [],
		createdAt: "2026-01-01T00:00:00Z",
	} as never;
};

const applyWith = async (
	options: Partial<VercelTrafficRoutingOptions>,
	rules: FixtureRule[],
	intent: JsonObject = {},
) => {
	const result = await routing(options).apply(plan(rules, intent));
	return {
		realized: result.realized,
		unmet: [...((result as { unmet?: readonly string[] }).unmet ?? [])],
		capabilities: [...(result.capabilities ?? [])],
		notes: [...(result.notes ?? [])],
		appliedRules: (result as { appliedRules?: number }).appliedRules,
	};
};

const auto = (rules: FixtureRule[], intent: JsonObject = {}) =>
	applyWith({}, rules, intent);
const forced = (
	mode: "rolling-release" | "rewrites",
	rules: FixtureRule[],
	intent: JsonObject = {},
) => applyWith({ mode }, rules, intent);

describe("a plan Vercel can realize", () => {
	it("realizes a two-backend canary as a rolling release", async () => {
		const result = await auto([canaryRule()]);
		expect(result.realized).toBe("full");
	});

	it("claims the weighted-backends capability it actually configured", async () => {
		expect((await auto([canaryRule()])).capabilities).toEqual([
			"weighted-backends",
		]);
	});

	it("reports no unmet capabilities when everything fits", async () => {
		expect((await auto([canaryRule()])).unmet).toEqual([]);
	});

	it("counts the rules it applied", async () => {
		expect((await auto([canaryRule()])).appliedRules).toBe(1);
	});

	it("realizes a path-prefixed rewrite", async () => {
		const result = await forced("rewrites", [rewriteRule()]);
		expect(result.realized).toBe("full");
	});
});

describe("auto mode, when no realization fits", () => {
	it("reports a single mode verdict rather than guessing at specifics", async () => {
		const result = await auto([canaryRule()], {
			availability: { zones: ["us-east-1a"] },
		});
		expect(result.unmet).toEqual(["mode"]);
	});

	it("says the plan is neither realization, in words", async () => {
		const result = await auto([canaryRule()], { resiliency: { retries: 3 } });
		expect(result.notes.join(" ")).toMatch(
			/not a Vercel rolling-release or rewrites/u,
		);
	});

	it("declines a non-static weight strategy", async () => {
		const result = await auto([
			canaryRule({ weightStrategy: "latency-based" }),
		]);
		expect(result.realized).toBe("none");
	});

	it("declines three backends, which is neither shape", async () => {
		const result = await auto([
			canaryRule({
				backends: [
					{ id: "a", service: "web", weight: 50 },
					{ id: "b", service: "web", weight: 30 },
					{ id: "c", service: "web", weight: 20 },
				],
			}),
		]);
		expect(result.realized).toBe("none");
	});

	it("declines an empty rule list rather than succeeding at nothing", async () => {
		const result = await auto([]);
		expect(result.realized).toBe("none");
	});

	it("claims no capabilities when it declines", async () => {
		expect((await auto([])).capabilities).toEqual([]);
	});

	it("applies no rules when it declines", async () => {
		expect((await auto([])).appliedRules).toBe(0);
	});
});

describe("a forced mode names the specific constraint", () => {
	it("names an availability constraint", async () => {
		const result = await forced("rolling-release", [canaryRule()], {
			availability: { zones: ["us-east-1a"] },
		});
		expect(result.unmet).toContain("availability-constraints");
	});

	it("names a resiliency constraint", async () => {
		const result = await forced("rolling-release", [canaryRule()], {
			resiliency: { retries: 3 },
		});
		expect(result.unmet).toContain("resiliency");
	});

	it("names the weight strategy it cannot use, not just that it cannot", async () => {
		const result = await forced("rolling-release", [
			canaryRule({ weightStrategy: "latency-based" }),
		]);
		expect(result.unmet.join(" ")).toContain("latency-based");
	});

	it("names a backend count that is not exactly two", async () => {
		const result = await forced("rolling-release", [
			canaryRule({
				backends: [
					{ id: "a", service: "web", weight: 50 },
					{ id: "b", service: "web", weight: 30 },
					{ id: "c", service: "web", weight: 20 },
				],
			}),
		]);
		expect(result.unmet).toContain("backend-count");
	});

	it("names multiple rules under a realization that takes one", async () => {
		const result = await forced("rolling-release", [
			canaryRule(),
			canaryRule(),
		]);
		expect(result.unmet).toContain("multiple-rules");
	});

	it("names a path prefix a Rolling Release cannot scope to", async () => {
		const result = await forced("rolling-release", [
			canaryRule({ match: { pathPrefix: "/api" } }),
		]);
		expect(result.unmet).toContain("rules[0].path-prefix");
	});

	it("names a header match a Rolling Release cannot gate on", async () => {
		const result = await forced("rolling-release", [
			canaryRule({ match: { headers: { "x-canary": "1" } } }),
		]);
		expect(result.unmet).toContain("rules[0].header-match");
	});

	it("lists every unmet constraint rather than stopping at the first", async () => {
		const result = await forced(
			"rolling-release",
			[canaryRule({ match: { pathPrefix: "/api" } })],
			{ availability: { zones: ["a"] }, resiliency: { retries: 2 } },
		);
		expect(result.unmet.length).toBeGreaterThan(2);
	});

	it("indexes the rule a rewrite constraint came from", async () => {
		const result = await forced("rewrites", [
			rewriteRule(),
			rewriteRule({ match: undefined, backends: [{ id: "b", service: "b" }] }),
		]);
		expect(result.unmet.join(" ")).toContain("rules[1]");
	});

	it("names a rewrite rule with no path prefix", async () => {
		const result = await forced("rewrites", [
			{
				weightStrategy: "static",
				backends: [
					{ id: "api", service: "api", endpoint: "https://api.example.com" },
				],
			},
		]);
		expect(result.unmet).toContain("rules[0].path-prefix");
	});

	it("names a rewrite backend with no endpoint", async () => {
		const result = await forced("rewrites", [
			rewriteRule({ backends: [{ id: "api", service: "api" }] }),
		]);
		expect(result.unmet).toContain("rules[0].endpoint");
	});

	it("names a rewrite rule with more than one backend", async () => {
		const result = await forced("rewrites", [
			rewriteRule({
				backends: [
					{ id: "a", service: "a", endpoint: "https://a.example" },
					{ id: "b", service: "b", endpoint: "https://b.example" },
				],
			}),
		]);
		expect(result.unmet).toContain("rules[0].backend-count");
	});

	it("declines a canary-shaped plan when rewrites is forced", async () => {
		expect((await forced("rewrites", [canaryRule()])).realized).toBe("none");
	});

	it("declines a rewrite-shaped plan when rolling-release is forced", async () => {
		expect((await forced("rolling-release", [rewriteRule()])).realized).toBe(
			"none",
		);
	});
});

describe("missing deployment mappings", () => {
	it("names the backend whose deployment is unmapped", async () => {
		const result = await applyWith(
			{ deploymentIdsByBackend: { stable: "dpl_stable" } },
			[canaryRule()],
		);
		expect(result.unmet.join(" ")).toContain("deployment:canary");
	});

	it("names both when neither is mapped", async () => {
		const result = await applyWith({ deploymentIdsByBackend: {} }, [
			canaryRule(),
		]);
		expect(result.unmet).toEqual(
			expect.arrayContaining(["deployment:canary", "deployment:stable"]),
		);
	});

	it("says deployment mappings are required, in words", async () => {
		const result = await applyWith({ deploymentIdsByBackend: {} }, [
			canaryRule(),
		]);
		expect(result.notes.join(" ")).toMatch(/deployment mappings are required/u);
	});
});

describe("a provider that does not answer as expected", () => {
	it("declines when the route stage returns no version id", async () => {
		const result = await applyWith(
			{ mode: "rewrites", fetchImpl: stubFetch({}) },
			[rewriteRule()],
		);
		expect(result.realized).toBe("none");
		expect(result.unmet).toContain("provider-api");
	});

	it("says what the provider failed to return", async () => {
		const result = await applyWith(
			{ mode: "rewrites", fetchImpl: stubFetch({}) },
			[rewriteRule()],
		);
		expect(result.notes.join(" ")).toMatch(/did not return a version id/u);
	});

	it("distinguishes a provider failure from an unrealizable plan", async () => {
		const providerFailure = await applyWith(
			{ mode: "rewrites", fetchImpl: stubFetch({}) },
			[rewriteRule()],
		);
		const planProblem = await forced("rewrites", [
			rewriteRule({ backends: [{ id: "api", service: "api" }] }),
		]);
		expect(providerFailure.unmet).not.toEqual(planProblem.unmet);
	});
});
