/**
 * Every case is a line in `evaluate.cases.jsonl`.
 *
 * One deliberate strengthening came with the move: the suite this replaced
 * asserted `reasons` with `toContain`, which passes no matter what else fired.
 * The cases below pin the **whole sorted reason set**, so a rule that starts
 * denying for an extra reason is red here rather than silently widening.
 */

import { describeConcern } from "@hobo/contract-harness";
import {
	computeEvidenceDigest,
	DEFAULT_TRUST_REQUIREMENT,
	type EvidenceVerifier,
	evaluateTrust,
	parseTrustEvidence,
	parseTrustRequirement,
	type TrustEvidenceInput,
	type TrustRequirementInput,
} from "../src/index.js";

const TESTED_AT = Date.UTC(2026, 7, 1);
const NOW = Date.UTC(2026, 7, 8);
const DAY = 24 * 60 * 60 * 1000;

const VERIFIERS: Record<string, EvidenceVerifier | undefined> = {
	valid: { id: "test.always-valid/v1", verify: () => "valid" },
	invalid: { id: "test.always-invalid/v1", verify: () => "invalid" },
	absent: undefined,
};

const BASE: Omit<TrustEvidenceInput, "evidenceDigest"> = {
	schemaVersion: "hobo.trust-evidence/v1",
	providerId: "cloudflare",
	productDefinitionId: "cloudflare.workers/v1",
	adapterVersion: "0.3.1",
	providerClass: "established",
	testedAt: TESTED_AT,
	expiresAt: TESTED_AT + 30 * DAY,
	checks: {
		"bootstrap.official-contract": "pass",
		"claim.documented-contract": "pass",
		"conformance.suite": "pass",
	},
	creatorAuthorityAfterClaim: "rotatable",
	claimActionCount: 1,
	realizations: ["native"],
	sponsorBacked: false,
	signature: "sig:test",
	sourceRefs: [
		{
			url: "https://developers.cloudflare.com/workers/",
			checkedAt: "2026-08-08",
		},
	],
};

/** One evaluation, described entirely by JSON. */
interface Ask {
	/** Top-level replacements on the evidence body. */
	readonly evidence?: Partial<TrustEvidenceInput>;
	/** Fields left out entirely — "the evidence is silent", not "set to false". */
	readonly omit?: readonly string[];
	/** Top-level replacements on the default requirement. */
	readonly requirement?: Partial<TrustRequirementInput>;
	/** Overrides the digest, which is otherwise computed over the body. */
	readonly digest?: string;
	readonly nowMs?: number;
	/** Offset from the evidence's own expiry, for the clock cases. */
	readonly nowRelativeToExpiry?: number;
	readonly signature?: keyof typeof VERIFIERS;
	/** Evidence absent altogether: the fail-closed case. */
	readonly noEvidence?: boolean;
}

function build(ask: Ask) {
	const draft = { ...BASE, ...ask.evidence } as Record<string, unknown>;
	for (const key of ask.omit ?? []) delete draft[key];
	const body = draft as unknown as Omit<TrustEvidenceInput, "evidenceDigest">;
	return parseTrustEvidence({
		...body,
		evidenceDigest: ask.digest ?? computeEvidenceDigest(body),
	});
}

describeConcern("evaluateTrust", {
	cases: `${import.meta.dirname}/evaluate.cases.jsonl`,
	subject: () => ({
		/** The verdict, reduced to the three things every case asserted on. */
		verdict: (ask: Ask = {}) => {
			const record = ask.noEvidence ? undefined : build(ask);
			const requirement = ask.requirement
				? parseTrustRequirement({
						...DEFAULT_TRUST_REQUIREMENT,
						...ask.requirement,
					} as TrustRequirementInput)
				: DEFAULT_TRUST_REQUIREMENT;
			const nowMs =
				ask.nowRelativeToExpiry !== undefined && record
					? record.expiresAt + ask.nowRelativeToExpiry
					: (ask.nowMs ?? NOW);
			const result = evaluateTrust(
				record,
				requirement,
				nowMs,
				VERIFIERS[ask.signature ?? "valid"],
			);
			return {
				selectable: result.selectable,
				signatureOutcome: result.signatureOutcome,
				reasons: [...result.reasons.map((reason) => reason.code)].sort(),
			};
		},
		/**
		 * Determinism, which needs two calls and so cannot be a value case.
		 *
		 * Returns whether the two verdicts — same facts, different authoring
		 * order — agree, digest included.
		 */
		isDeterministic: (a: Ask, b: Ask) => {
			const one = evaluateTrust(
				build(a),
				DEFAULT_TRUST_REQUIREMENT,
				NOW,
				VERIFIERS.valid,
			);
			const two = evaluateTrust(
				build(b),
				DEFAULT_TRUST_REQUIREMENT,
				NOW,
				VERIFIERS.valid,
			);
			return (
				JSON.stringify(one) === JSON.stringify(two) &&
				one.verdictDigest === two.verdictDigest
			);
		},
	}),
});
