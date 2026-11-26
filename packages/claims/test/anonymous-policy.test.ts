import { describe, expect, it } from "vitest";

import {
	type AnonymousRequest,
	type AnonymousUsage,
	admitAnonymousDeployment,
	assertAnonymousAdmission,
	DEFAULT_ANONYMOUS_POLICY,
	nextPollDelayMs,
} from "../src/index.js";

const NOW = Date.UTC(2026, 7, 8, 12);

const cleanUsage: AnonymousUsage = {
	sessionDeployments: 0,
	riskBucketDeployments: 0,
	riskBucketWindowStartMs: NOW - 1000,
	concurrentProvisioning: 0,
	concurrentClaims: 0,
	sponsorResourceCount: 0,
	sponsorSpentMinorUnits: 0,
};

const cleanRequest: AnonymousRequest = {
	recipeId: "recipe.cloudflare.claimable-webhook-inbox/v1",
	providerIds: ["cloudflare"],
	bootstrapClass: "anonymous-claimable",
	requestedTtlMs: 60 * 60 * 1000,
	estimatedSponsorCostMinorUnits: 0,
	sourceBytes: 1024,
	fileCount: 4,
	largestFileBytes: 512,
};

function admit(
	usage: Partial<AnonymousUsage> = {},
	request: Partial<AnonymousRequest> = {},
) {
	return admitAnonymousDeployment({
		policy: DEFAULT_ANONYMOUS_POLICY,
		usage: { ...cleanUsage, ...usage },
		request: { ...cleanRequest, ...request },
		nowMs: NOW,
	});
}

describe("anonymous admission", () => {
	it("admits a bounded request from a fresh session", () => {
		expect(admit()).toEqual({ ok: true });
	});

	it("refuses once the session quota is spent", () => {
		const result = admit({ sessionDeployments: 3 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.refusals[0].code).toBe("ANONYMOUS_QUOTA_EXCEEDED");
	});

	it("treats an expired risk window as a fresh budget", () => {
		const exhausted = admit({
			riskBucketDeployments: 20,
			riskBucketWindowStartMs: NOW - 1000,
		});
		expect(exhausted.ok).toBe(false);
		const expired = admit({
			riskBucketDeployments: 20,
			riskBucketWindowStartMs: NOW - 2 * 60 * 60 * 1000,
		});
		expect(expired).toEqual({ ok: true });
	});

	it("tells an exhausted bucket when to come back", () => {
		const result = admit({
			riskBucketDeployments: 20,
			riskBucketWindowStartMs: NOW,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.refusals[0].retryAfterMs).toBe(
			DEFAULT_ANONYMOUS_POLICY.riskBucketWindowMs,
		);
	});

	it("counts the request against the sponsor budget before spending it", () => {
		const result = admit(
			{ sponsorSpentMinorUnits: 49_900 },
			{ estimatedSponsorCostMinorUnits: 500 },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.refusals.map((r) => r.code)).toContain(
			"SPONSOR_BUDGET_EXCEEDED",
		);
	});

	it("refuses a bootstrap class the operator has not allowed", () => {
		const result = admit({}, { bootstrapClass: "wallet" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.refusals[0].code).toBe("BOOTSTRAP_POLICY_DENIED");
	});

	it("honors the provider and recipe kill switches without a code change", () => {
		const killed = admitAnonymousDeployment({
			policy: {
				...DEFAULT_ANONYMOUS_POLICY,
				disabledProviders: ["cloudflare"],
			},
			usage: cleanUsage,
			request: cleanRequest,
			nowMs: NOW,
		});
		expect(killed.ok).toBe(false);
		if (killed.ok) return;
		expect(killed.refusals[0].code).toBe("PROVIDER_KILL_SWITCH");
	});

	it("bounds TTL and payload size", () => {
		const result = admit(
			{},
			{
				requestedTtlMs: 30 * 24 * 60 * 60 * 1000,
				fileCount: 5000,
				largestFileBytes: 50 * 1024 * 1024,
			},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.refusals.map((r) => r.code).sort()).toEqual([
			"PAYLOAD_TOO_LARGE",
			"PAYLOAD_TOO_LARGE",
			"TTL_OUT_OF_BOUNDS",
		]);
	});

	it("reports every violated ceiling, not only the first", () => {
		const result = admit(
			{ sessionDeployments: 5, concurrentClaims: 9 },
			{ requestedTtlMs: -1 },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.refusals.length).toBeGreaterThanOrEqual(3);
	});

	it("rate limits polling below the configured interval", () => {
		const result = admit({ lastPollAtMs: NOW - 100 }, { pollAtMs: NOW });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.refusals[0].code).toBe("PROVIDER_RATE_LIMITED");
		expect(result.refusals[0].retryAfterMs).toBe(1900);
	});

	it("throws a stable claim error code from the throwing variant", () => {
		expect(() =>
			assertAnonymousAdmission(admit({ sessionDeployments: 3 })),
		).toThrow(/session already holds/u);
		expect(() => assertAnonymousAdmission({ ok: true })).not.toThrow();
	});

	it("backs off exponentially up to a cap", () => {
		const policy = { minPollIntervalMs: 2000 };
		expect(nextPollDelayMs(0, policy)).toBe(2000);
		expect(nextPollDelayMs(3, policy)).toBe(16_000);
		expect(nextPollDelayMs(30, policy)).toBe(60_000);
	});
});
