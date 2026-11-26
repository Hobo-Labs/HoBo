/**
 * Claim/ownership conformance — did authority actually move?
 *
 * The failure mode this suite exists to catch is the friendly one: a provider
 * redirects the browser back with `?claimed=true`, the product marks the
 * resource owned, and the bootstrap credential the deploy agent minted keeps
 * working forever. Ownership is only real when an *independent* read confirms
 * it, the mandatory rotation and bootstrap-authority revocation have finished,
 * and the credential that existed before the claim has stopped working.
 */

import type {
	ClaimItemStatus,
	CreatorAuthorityAfterClaim,
	PostClaimAction,
} from "@hobo/claims";
import type { JsonValue } from "../../json.js";

import {
	type AnonymousSuiteDefinition,
	type CaseJudgement,
	optionalBoolean,
	optionalText,
	requireBoolean,
	requireMember,
	requireRecord,
	requireText,
} from "./harness.js";
import { type AnonymousCase, AnonymousConformanceError } from "./types.js";

// public-contract: stable suite identifier used in evidence and reports.
export const CLAIM_SUITE_ID = "hobo.anonymous.claim/v1";

export const CLAIM_CHECKS = {
	callbackIsNotOwnership: "claim.callback-is-not-ownership",
	independentVerification: "claim.independent-verification",
	obligationsGateCompletion: "claim.obligations-gate-completion",
	preClaimCredentialRevoked: "claim.pre-claim-credential-revoked",
} as const;

export type ClaimCheck = (typeof CLAIM_CHECKS)[keyof typeof CLAIM_CHECKS];

export const CLAIM_STEPS = [
	"observe-provider-callback",
	"verify-ownership",
	"complete-post-claim-actions",
	"replay-pre-claim-credential",
] as const;

export type ClaimStep = (typeof CLAIM_STEPS)[number];

const CLAIM_ITEM_STATUSES: readonly ClaimItemStatus[] = [
	"pending",
	"in-progress",
	"observed",
	"verified",
	"needs-rotation",
	"completed",
	"expired",
	"repairable-failure",
	"compensating",
	"failed",
];

const POST_CLAIM_ACTIONS: readonly PostClaimAction[] = [
	"rotate-binding",
	"revoke-bootstrap-authority",
	"reauthorize-agent",
	"verify-health",
	"migrate-data",
];

const CREATOR_AUTHORITIES: readonly CreatorAuthorityAfterClaim[] = [
	"absent",
	"reauthorization-required",
	"rotatable",
	"retained",
	"unknown",
];

export interface ClaimStepRequest {
	readonly caseId: string;
	readonly step: ClaimStep;
	readonly subjectRef: string;
	readonly requiredPostClaimActions: readonly PostClaimAction[];
	readonly completedPostClaimActions: readonly PostClaimAction[];
}

// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface ClaimStepOutcome {
	readonly caseId: string;
	readonly itemStatus: ClaimItemStatus;
	readonly providerReportedClaimed: boolean;
	readonly independentlyVerified: boolean;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly outstandingPostClaimActions: readonly PostClaimAction[];
	readonly preClaimCredentialAccepted?: boolean;
	readonly verificationRef?: string;
	readonly evidenceRef?: string;
}

export type ClaimExpectation =
	| { readonly kind: "callback-alone-does-not-complete" }
	| { readonly kind: "independent-verification-completes" }
	| { readonly kind: "obligations-block-completion" }
	| { readonly kind: "obligations-satisfied-completes" }
	| { readonly kind: "pre-claim-credential-rejected" };

export type ClaimCase = AnonymousCase<ClaimStepRequest, ClaimExpectation>;

const SUBJECT_REF = "resource:conformance/claimable-1";
const MANDATORY_ACTIONS: readonly PostClaimAction[] = [
	"rotate-binding",
	"revoke-bootstrap-authority",
];

export const CLAIM_CASES: readonly ClaimCase[] = Object.freeze([
	{
		id: "claim/provider-callback-alone",
		check: CLAIM_CHECKS.callbackIsNotOwnership,
		title: "a provider callback reporting success does not complete the claim",
		request: {
			caseId: "claim/provider-callback-alone",
			step: "observe-provider-callback",
			subjectRef: SUBJECT_REF,
			requiredPostClaimActions: MANDATORY_ACTIONS,
			completedPostClaimActions: [],
		},
		expect: { kind: "callback-alone-does-not-complete" },
	},
	{
		id: "claim/independent-verification-succeeds",
		check: CLAIM_CHECKS.independentVerification,
		title: "an independent read of the provider confirms the new owner",
		request: {
			caseId: "claim/independent-verification-succeeds",
			step: "verify-ownership",
			subjectRef: SUBJECT_REF,
			requiredPostClaimActions: MANDATORY_ACTIONS,
			completedPostClaimActions: [],
		},
		expect: { kind: "independent-verification-completes" },
	},
	{
		id: "claim/outstanding-obligations-block-completion",
		check: CLAIM_CHECKS.obligationsGateCompletion,
		title: "verified ownership with rotation outstanding is not yet complete",
		request: {
			caseId: "claim/outstanding-obligations-block-completion",
			step: "verify-ownership",
			subjectRef: SUBJECT_REF,
			requiredPostClaimActions: MANDATORY_ACTIONS,
			completedPostClaimActions: [],
		},
		expect: { kind: "obligations-block-completion" },
	},
	{
		id: "claim/completes-after-rotation-and-revocation",
		check: CLAIM_CHECKS.obligationsGateCompletion,
		title:
			"the item completes only after rotation and bootstrap-authority revocation",
		request: {
			caseId: "claim/completes-after-rotation-and-revocation",
			step: "complete-post-claim-actions",
			subjectRef: SUBJECT_REF,
			requiredPostClaimActions: MANDATORY_ACTIONS,
			completedPostClaimActions: MANDATORY_ACTIONS,
		},
		expect: { kind: "obligations-satisfied-completes" },
	},
	{
		id: "claim/pre-claim-credential-no-longer-works",
		check: CLAIM_CHECKS.preClaimCredentialRevoked,
		title:
			"a historically-known pre-claim credential is rejected by the claimed resource",
		request: {
			caseId: "claim/pre-claim-credential-no-longer-works",
			step: "replay-pre-claim-credential",
			subjectRef: SUBJECT_REF,
			requiredPostClaimActions: MANDATORY_ACTIONS,
			completedPostClaimActions: MANDATORY_ACTIONS,
		},
		expect: { kind: "pre-claim-credential-rejected" },
	},
]);

export function parseClaimStepOutcome(
	raw: JsonValue,
	caseId: string,
): ClaimStepOutcome {
	const record = requireRecord(raw, caseId, "claim outcome");
	const reportedCaseId = requireText(record.caseId, caseId, "caseId");
	if (reportedCaseId !== caseId) {
		throw new AnonymousConformanceError(
			caseId,
			`outcome reports caseId ${JSON.stringify(reportedCaseId)}`,
		);
	}
	if (!Array.isArray(record.outstandingPostClaimActions)) {
		throw new AnonymousConformanceError(
			caseId,
			"outstandingPostClaimActions must be an array",
		);
	}
	const outstanding = record.outstandingPostClaimActions.map((entry, index) =>
		requireMember(
			entry,
			caseId,
			`outstandingPostClaimActions[${index}]`,
			POST_CLAIM_ACTIONS,
		),
	);
	const preClaimCredentialAccepted = optionalBoolean(
		record.preClaimCredentialAccepted,
		caseId,
		"preClaimCredentialAccepted",
	);
	const verificationRef = optionalText(
		record.verificationRef,
		caseId,
		"verificationRef",
	);
	const evidenceRef = optionalText(record.evidenceRef, caseId, "evidenceRef");

	return {
		caseId,
		itemStatus: requireMember(
			record.itemStatus,
			caseId,
			"itemStatus",
			CLAIM_ITEM_STATUSES,
		),
		providerReportedClaimed: requireBoolean(
			record.providerReportedClaimed,
			caseId,
			"providerReportedClaimed",
		),
		independentlyVerified: requireBoolean(
			record.independentlyVerified,
			caseId,
			"independentlyVerified",
		),
		creatorAuthorityAfterClaim: requireMember(
			record.creatorAuthorityAfterClaim,
			caseId,
			"creatorAuthorityAfterClaim",
			CREATOR_AUTHORITIES,
		),
		outstandingPostClaimActions: outstanding,
		...(preClaimCredentialAccepted !== undefined
			? { preClaimCredentialAccepted }
			: undefined),
		...(verificationRef !== undefined ? { verificationRef } : undefined),
		...(evidenceRef !== undefined ? { evidenceRef } : undefined),
	};
}

function judgeClaimCase(
	suiteCase: ClaimCase,
	outcome: ClaimStepOutcome,
): CaseJudgement {
	switch (suiteCase.expect.kind) {
		case "callback-alone-does-not-complete":
			return judgeCallbackAlone(outcome);
		case "independent-verification-completes":
			return judgeIndependentVerification(outcome);
		case "obligations-block-completion":
			return judgeObligationsBlock(suiteCase, outcome);
		case "obligations-satisfied-completes":
			return judgeObligationsSatisfied(suiteCase, outcome);
		case "pre-claim-credential-rejected":
			return judgePreClaimCredential(outcome);
	}
}

function judgeCallbackAlone(outcome: ClaimStepOutcome): CaseJudgement {
	if (!outcome.providerReportedClaimed) {
		return {
			outcome: "fail",
			detail:
				"the provider callback was not even observed, so this case proves nothing",
		};
	}
	if (outcome.independentlyVerified) {
		return {
			outcome: "fail",
			detail:
				"the adapter treated the provider callback itself as independent verification",
		};
	}
	if (outcome.itemStatus === "completed") {
		return {
			outcome: "fail",
			detail: "the claim item completed on a provider callback alone",
		};
	}
	if (outcome.itemStatus !== "observed") {
		return {
			outcome: "fail",
			detail: `an observed-but-unverified claim should sit at "observed", not "${outcome.itemStatus}"`,
		};
	}
	return {
		outcome: "pass",
		detail: "the provider callback moved the item to observed and no further",
	};
}

function judgeIndependentVerification(
	outcome: ClaimStepOutcome,
): CaseJudgement {
	if (!outcome.independentlyVerified) {
		return {
			outcome: "fail",
			detail: "independent ownership verification did not succeed",
		};
	}
	if (outcome.verificationRef === undefined) {
		return {
			outcome: "fail",
			detail: "verification succeeded but produced no verification reference",
		};
	}
	if (outcome.creatorAuthorityAfterClaim === "unknown") {
		return {
			outcome: "fail",
			detail:
				"verification did not establish what authority the creator retains after the claim",
		};
	}
	if (
		outcome.itemStatus !== "verified" &&
		outcome.itemStatus !== "needs-rotation" &&
		outcome.itemStatus !== "completed"
	) {
		return {
			outcome: "fail",
			detail: `verification succeeded but the item is "${outcome.itemStatus}"`,
		};
	}
	return {
		outcome: "pass",
		detail: `ownership verified independently (${outcome.verificationRef}), creator authority is ${outcome.creatorAuthorityAfterClaim}`,
	};
}

function judgeObligationsBlock(
	suiteCase: ClaimCase,
	outcome: ClaimStepOutcome,
): CaseJudgement {
	const missing = suiteCase.request.requiredPostClaimActions.filter(
		(action) => !suiteCase.request.completedPostClaimActions.includes(action),
	);
	if (missing.length === 0) {
		return {
			outcome: "fail",
			detail: "the case declared no outstanding obligation to block on",
		};
	}
	if (outcome.itemStatus === "completed") {
		return {
			outcome: "fail",
			detail: `the item completed with ${missing.join(", ")} still outstanding`,
		};
	}
	if (outcome.outstandingPostClaimActions.length === 0) {
		return {
			outcome: "fail",
			detail:
				"the adapter reported no outstanding obligations it has not performed",
		};
	}
	return {
		outcome: "pass",
		detail: `completion is blocked by ${outcome.outstandingPostClaimActions.join(", ")}`,
	};
}

function judgeObligationsSatisfied(
	suiteCase: ClaimCase,
	outcome: ClaimStepOutcome,
): CaseJudgement {
	const required = suiteCase.request.requiredPostClaimActions;
	if (!required.includes("rotate-binding")) {
		return {
			outcome: "fail",
			detail:
				"the case must demand credential rotation to prove it is mandatory",
		};
	}
	if (!required.includes("revoke-bootstrap-authority")) {
		return {
			outcome: "fail",
			detail:
				"the case must demand bootstrap-authority revocation to prove it is mandatory",
		};
	}
	if (outcome.outstandingPostClaimActions.length > 0) {
		return {
			outcome: "fail",
			detail: `obligations remain outstanding: ${outcome.outstandingPostClaimActions.join(", ")}`,
		};
	}
	if (outcome.itemStatus !== "completed") {
		return {
			outcome: "fail",
			detail: `all obligations are satisfied but the item is "${outcome.itemStatus}"`,
		};
	}
	if (outcome.evidenceRef === undefined) {
		return {
			outcome: "fail",
			detail: "a completed claim item carries no evidence reference",
		};
	}
	if (outcome.creatorAuthorityAfterClaim === "retained") {
		return {
			outcome: "fail",
			detail:
				"bootstrap-authority revocation was reported done yet creator authority is still retained",
		};
	}
	return {
		outcome: "pass",
		detail: `completed after rotation and revocation; creator authority is ${outcome.creatorAuthorityAfterClaim}`,
	};
}

function judgePreClaimCredential(outcome: ClaimStepOutcome): CaseJudgement {
	if (outcome.preClaimCredentialAccepted === undefined) {
		return {
			outcome: "fail",
			detail: "the adapter never replayed the pre-claim credential",
		};
	}
	if (outcome.preClaimCredentialAccepted) {
		return {
			outcome: "fail",
			detail:
				"a credential known before the claim still authenticates against the claimed resource",
		};
	}
	return {
		outcome: "pass",
		detail: "the pre-claim credential is rejected by the claimed resource",
	};
}

export const CLAIM_CONFORMANCE_SUITE: AnonymousSuiteDefinition<
	ClaimStepRequest,
	ClaimExpectation,
	ClaimStepOutcome
> = Object.freeze({
	suiteId: CLAIM_SUITE_ID,
	dimension: "claim",
	checks: Object.freeze(Object.values(CLAIM_CHECKS)),
	cases: CLAIM_CASES,
	parse: parseClaimStepOutcome,
	judge: judgeClaimCase,
});
