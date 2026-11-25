/**
 * What Vercel *cannot* do with a routing plan, and how it says so.
 *
 * `vercel-traffic-routing.test.ts` covers the refusals that stop a plan before
 * it starts — no credential, no project, a reused plan id. This covers the
 * other half: a plan that is well-formed but asks for more than Vercel's two
 * realizations can express.
 *
 * The reporting is in **two layers, and the distinction is the interesting
 * part**:
 *
 * In **auto mode** the adapter first has to pick a realization from the plan's
 * shape. A plan matching neither Rolling Releases nor rewrites gets a single
 * `mode` in `unmet` — because at that point the adapter genuinely does not know
 * which realization the operator was reaching for, and guessing in order to
 * produce a more specific complaint would be inventing intent.
 *
 * In a **forced mode** the operator has already said which realization they
 * want, so the adapter can be specific: `availability-constraints`,
 * `rules[0].path-prefix`, `backend-count`. That is why pinning a mode is the
 * documented way to find out *why* a plan will not realize.
 *
 * Underneath both is the rule that matters: **an unrealizable plan is declined,
 * never approximated**. Applying the part that fits is the tempting behaviour
 * and the dangerous one — an operator who asked for a canary gated on a header,
 * and got an ungated canary, has shipped to everybody.
 */
import { describe, expect, it } from "vitest";

import { createVercelTrafficRouting } from "../../src/traffic-routing/vercel.js";

/** A Vercel API that accepts everything and returns a stageable version. */
function stubFetch(body: unknown = { version: { id: "ver_1" } }) {
	return (async () =>
		({
			ok: true,
			status: 200,
			json: async () => body,
		}) as unknown as Response) as unknown as typeof fetch;
}

/**
 * Rolling Releases need a Vercel deployment id per backend. The fixture
 * supplies the map so that an unrealizable plan is unrealizable for its
 * *shape*, which is what these tests vary.
 */
const routing = (options: Record<string, unknown> = {}) =>
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
	} as never);

/** Two weighted backends under one static rule — the rolling-release shape. */
const canaryRule = (overrides: Record<string, unknown> = {}) => ({
	weightStrategy: "static",
	backends: [
		{ id: "stable", service: "web", weight: 90 },
		{ id: "canary", service: "web", weight: 10 },
	],
	...overrides,
});

/** One endpoint under a path prefix — the rewrites shape. */
const rewriteRule = (overrides: Record<string, unknown> = {}) => ({
	weightStrategy: "static",
	match: { pathPrefix: "/api" },
	backends: [
		{ id: "api", service: "api", endpoint: "https://api.example.com" },
	],
	...overrides,
});

let planCounter = 0;

const plan = (rules: unknown[], intent: Record<string, unknown> = {}) => {
	planCounter += 1;
	return {
		planId: `plan-${planCounter}`,
		intent: { service: "web", tenantId: "t1", rules, ...intent },
		backends: [],
		createdAt: "2026-01-01T00:00:00Z",
	} as never;
};

const applyWith = async (
	options: Record<string, unknown>,
	rules: unknown[],
	intent: Record<string, unknown> = {},
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

const auto = (rules: unknown[], intent: Record<string, unknown> = {}) =>
	applyWith({}, rules, intent);
const forced = (
	mode: "rolling-release" | "rewrites",
	rules: unknown[],
	intent: Record<string, unknown> = {},
) => applyWith({ mode }, rules, intent);

describe("a plan Vercel can realize", () => {
	it("realizes a two-backend canary as a rolling release", async () => {
		const result = await auto([canaryRule()]);
		expect(result.realized).toBe("full");
	});

	it("claims the weighted-backends capability it actually configured", async () => {
		// The positive half of the honesty: claiming a capability that was not
		// configured is the same failure as hiding one that was not available.
		expect((await auto([canaryRule()])).capabilities).toEqual([
			"weighted-backends",
		]);
	});

	it("reports no unmet capabilities when everything fits", async () => {
		// A spurious entry would send an operator looking for a limitation that
		// does not apply to them.
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
		// The adapter genuinely does not know which realization the operator was
		// reaching for; a more specific complaint would be inventing intent.
		const result = await auto([canaryRule()], {
			availability: { zones: ["us-east-1a"] },
		});
		expect(result.unmet).toEqual(["mode"]);
	});

	it("says the plan is neither realization, in words", async () => {
		// The note is what a human reads first; the code is for machines.
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
		// Reporting success for a plan that routes nothing would have a caller
		// believe their traffic moved.
		const result = await auto([]);
		expect(result.realized).toBe("none");
	});

	it("claims no capabilities when it declines", async () => {
		// Capabilities on a denial would read as a partial application.
		expect((await auto([])).capabilities).toEqual([]);
	});

	it("applies no rules when it declines", async () => {
		expect((await auto([])).appliedRules).toBe(0);
	});
});

describe("a forced mode names the specific constraint", () => {
	it("names an availability constraint", async () => {
		// Vercel's edge decides placement; a plan pinning zones asks for
		// something the platform does not expose.
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
		// "unsupported strategy" without the name leaves an operator guessing
		// which of their rules to change.
		const result = await forced("rolling-release", [
			canaryRule({ weightStrategy: "latency-based" }),
		]);
		expect(result.unmet.join(" ")).toContain("latency-based");
	});

	it("names a backend count that is not exactly two", async () => {
		// A Rolling Release is stable-plus-canary by construction.
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
		// This is the case the whole design exists for: an ungated canary
		// shipped in place of a header-gated one reaches everybody.
		const result = await forced("rolling-release", [
			canaryRule({ match: { headers: { "x-canary": "1" } } }),
		]);
		expect(result.unmet).toContain("rules[0].header-match");
	});

	it("lists every unmet constraint rather than stopping at the first", async () => {
		// A plan with several problems must not require several round trips to
		// fix.
		const result = await forced(
			"rolling-release",
			[canaryRule({ match: { pathPrefix: "/api" } })],
			{ availability: { zones: ["a"] }, resiliency: { retries: 2 } },
		);
		expect(result.unmet.length).toBeGreaterThan(2);
	});

	it("indexes the rule a rewrite constraint came from", async () => {
		// With several rules, an unindexed complaint does not say which one.
		const result = await forced("rewrites", [
			rewriteRule(),
			rewriteRule({ match: undefined, backends: [{ id: "b", service: "b" }] }),
		]);
		expect(result.unmet.join(" ")).toContain("rules[1]");
	});

	it("names a rewrite rule with no path prefix", async () => {
		// A rewrite with no source path matches everything, which is not what a
		// rule scoped to one service asked for.
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
		// There is nowhere to rewrite *to*; realizing it would produce a route
		// pointing at nothing.
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
		// An operator who pinned the mode wants that mode or an error, not a
		// silent fallback to the other one.
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
		// This is a configuration gap rather than a plan-shape problem, and
		// naming the backend is what tells the operator which id to supply.
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
		// Without it there is nothing to promote, so the route was staged and
		// never went live. Reporting success would claim traffic moved.
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
		// They need different fixes — one is a retry, the other is a plan edit —
		// so they must not share a code.
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
