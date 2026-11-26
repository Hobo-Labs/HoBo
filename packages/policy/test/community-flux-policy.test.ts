import { describe, expect, it } from "vitest";

import {
	COMMUNITY_FLUX_POLICY_PACK_ID,
	evaluateCommunityFluxPolicy,
} from "../src/index.js";

describe("community Flux policy", () => {
	it("denies control plane, secrets, celld fleet, and hostile code on community-free", () => {
		for (const workloadClass of [
			"control-plane",
			"secrets",
			"rivet-control-plane",
			"celld-fleet",
			"hostile-code",
			"residency-constrained",
		]) {
			const verdict = evaluateCommunityFluxPolicy({
				tier: "community-free",
				workloadClass,
			});
			expect(verdict.allowed).toBe(false);
			expect(verdict.ruleId).toBe(
				`${COMMUNITY_FLUX_POLICY_PACK_ID}:deny.community-flux`,
			);
		}
	});

	it("allows preview web on community and control plane on paid multi-instance", () => {
		expect(
			evaluateCommunityFluxPolicy({
				tier: "community-free",
				workloadClass: "web-preview",
			}).allowed,
		).toBe(true);
		expect(
			evaluateCommunityFluxPolicy({
				tier: "paid-multi-instance",
				workloadClass: "rivet-control-plane",
			}).allowed,
		).toBe(true);
	});
});
