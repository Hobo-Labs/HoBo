/**
 * Deny community Flux for control-plane, secrets, residency-constrained,
 * and hostile-code workloads. Orbit/Git preview is not a waiver.
 */
// public-contract: policy pack id Gatekeeper and Matching pin.
export const COMMUNITY_FLUX_POLICY_PACK_ID = "hobo.policy.community-flux/v1";

export interface CommunityFluxPolicyPack {
	readonly id: typeof COMMUNITY_FLUX_POLICY_PACK_ID;
	readonly denyCommunityFor: readonly string[];
}

export const DEFAULT_COMMUNITY_FLUX_POLICY_PACK: CommunityFluxPolicyPack =
	Object.freeze({
		id: COMMUNITY_FLUX_POLICY_PACK_ID,
		denyCommunityFor: [
			"control-plane",
			"secrets",
			"residency-constrained",
			"hostile-code",
			"rivet-control-plane",
			"celld-fleet",
		],
	});

export interface CommunityFluxPolicyInput {
	readonly pack?: CommunityFluxPolicyPack;
	readonly tier: "community-free" | "paid-multi-instance";
	readonly workloadClass: string;
}

export interface CommunityFluxPolicyEvaluation {
	readonly allowed: boolean;
	readonly effect: "allow" | "deny";
	readonly ruleId: string;
	readonly reasons: readonly string[];
}

export function evaluateCommunityFluxPolicy(
	input: CommunityFluxPolicyInput,
): CommunityFluxPolicyEvaluation {
	const pack = input.pack ?? DEFAULT_COMMUNITY_FLUX_POLICY_PACK;
	const ruleId = `${pack.id}:deny.community-flux`;
	if (
		input.tier === "community-free" &&
		pack.denyCommunityFor.includes(input.workloadClass)
	) {
		return {
			allowed: false,
			effect: "deny",
			ruleId,
			reasons: [
				`community Flux denied for workload class '${input.workloadClass}'`,
			],
		};
	}
	return {
		allowed: true,
		effect: "allow",
		ruleId,
		reasons: [],
	};
}
