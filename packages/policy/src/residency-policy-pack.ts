/**
 * Residency policy pack (ADR-0146): the walkthrough's `eu-data-stays-in-eu`
 * rule made real. Deliberately dependency-free — the caller computes the
 * geographic verdict with `evaluateResidency` (@hobo/core jurisdiction port)
 * and this pack turns it into a policy decision: deny for regulated
 * classifications, warn for unregulated ones, and an evidence obligation on
 * every allow so the decision trail carries the jurisdictions it relied on.
 */

// public-contract: residency policy pack id consumers pin.
export const RESIDENCY_POLICY_PACK_ID = "hobo.policy.residency/v1";

/** Structural mirror of @hobo/core's ResidencyEvaluation (no dependency). */
export interface ResidencyVerdictInput {
	readonly ok: boolean;
	readonly code?: string;
	readonly region: string;
	readonly regionJurisdictions: readonly string[];
	readonly remediation?: string;
}

export interface ResidencyPolicyPack {
	readonly id: typeof RESIDENCY_POLICY_PACK_ID;
	/** Classifications a residency conflict hard-denies for. */
	readonly enforceForClassifications: readonly string[];
	/** Unmapped regions are conflicts even for unregulated data. */
	readonly denyUnmappedRegions: boolean;
}

export const DEFAULT_RESIDENCY_POLICY_PACK: ResidencyPolicyPack = Object.freeze(
	{
		id: RESIDENCY_POLICY_PACK_ID,
		enforceForClassifications: Object.freeze(["pii", "phi", "pci", "secret"]),
		denyUnmappedRegions: true,
	},
);

export interface ResidencyEvidenceObligation {
	readonly kind: "residency-evidence";
	readonly region: string;
	readonly jurisdictions: readonly string[];
	readonly classification: string;
}

export interface ResidencyPolicyEvaluation {
	readonly allowed: boolean;
	readonly effect: "allow" | "warn" | "deny";
	readonly ruleId: string;
	readonly reasons: readonly string[];
	/** Evidence carried on allow decisions (jurisdictions relied upon). */
	readonly obligations: readonly ResidencyEvidenceObligation[];
}

export function evaluateResidencyPolicy(input: {
	readonly pack?: ResidencyPolicyPack;
	readonly classification: string;
	readonly verdict: ResidencyVerdictInput;
}): ResidencyPolicyEvaluation {
	const pack = input.pack ?? DEFAULT_RESIDENCY_POLICY_PACK;
	const regulated = pack.enforceForClassifications.includes(
		input.classification,
	);
	const ruleId = `${pack.id}:classification-region`;

	if (!input.verdict.ok) {
		const reason =
			input.verdict.remediation ??
			`residency conflict (${input.verdict.code ?? "unknown"}) in region ${input.verdict.region}`;
		const unmapped = input.verdict.code === "region-unmapped";
		const deny = regulated || (unmapped && pack.denyUnmappedRegions);
		return Object.freeze({
			allowed: !deny,
			effect: deny ? ("deny" as const) : ("warn" as const),
			ruleId,
			reasons: Object.freeze([
				deny
					? `'${input.classification}' data would land outside its allowed jurisdictions: ${reason}`
					: `residency warning for '${input.classification}' data: ${reason}`,
			]),
			obligations: Object.freeze([]),
		});
	}

	return Object.freeze({
		allowed: true,
		effect: "allow" as const,
		ruleId,
		reasons: Object.freeze([]),
		obligations: Object.freeze([
			Object.freeze({
				kind: "residency-evidence",
				region: input.verdict.region,
				jurisdictions: Object.freeze([...input.verdict.regionJurisdictions]),
				classification: input.classification,
			}),
		]),
	});
}
