/**
 * Bootstrap conformance — does the advertised bootstrap class actually work?
 *
 * A catalog entry saying `anonymous-claimable` is a marketing string until
 * something proves that consent was captured *before* money or quota moved,
 * that a proof-of-work path terminates inside a declared ceiling, that the
 * lease expiry came out of the provider's own response rather than a local
 * timer we invented, and that asking for a resource kind nobody allowlisted is
 * refused rather than quietly provisioned.
 */

import type { BootstrapClass } from "@hobo/claims";
import { isJsonNumber, type JsonValue } from "../../json.js";

import {
	type AnonymousSuiteDefinition,
	type CaseJudgement,
	optionalInstant,
	optionalMember,
	optionalText,
	requireBoolean,
	requireMember,
	requireRecord,
	requireText,
} from "./harness.js";
import { type AnonymousCase, AnonymousConformanceError } from "./types.js";

// public-contract: stable suite identifier used in evidence and reports.
export const BOOTSTRAP_SUITE_ID = "hobo.anonymous.bootstrap/v1";

export const BOOTSTRAP_CHECKS = {
	advertisedClassHolds: "bootstrap.advertised-class-holds",
	consentBeforeEffect: "bootstrap.consent-before-effect",
	proofOfWorkBounded: "bootstrap.proof-of-work-bounded",
	providerReportedExpiry: "bootstrap.provider-reported-expiry",
	resourceAllowlistFailClosed: "bootstrap.resource-allowlist-fail-closed",
} as const;

export type BootstrapCheck =
	(typeof BOOTSTRAP_CHECKS)[keyof typeof BOOTSTRAP_CHECKS];

export const BOOTSTRAP_CLASSES: readonly BootstrapClass[] = [
	"public-anonymous",
	"anonymous-claimable",
	"proof-of-work",
	"capability-token",
	"agent-self-registration",
	"wallet",
	"sponsor",
	"local",
	"preauthenticated-agent",
	"self-hosted-hobo",
];

/** Everything the executor needs. No clock, no environment, no randomness. */
export interface BootstrapAttemptRequest {
	readonly caseId: string;
	readonly advertisedClass: BootstrapClass;
	readonly consent: "granted" | "withheld";
	readonly requestedResourceKind: string;
	readonly allowedResourceKinds: readonly string[];
	readonly proofOfWorkCeiling: number;
	/** Injected instant. The suite never reads a clock. */
	readonly issuedAtMs: number;
}

export const BOOTSTRAP_EXPIRY_SOURCES = [
	"provider-response",
	"local-timer",
	"absent",
] as const;

export type BootstrapExpirySource = (typeof BOOTSTRAP_EXPIRY_SOURCES)[number];

// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface BootstrapAttemptOutcome {
	readonly caseId: string;
	readonly effectAttempted: boolean;
	readonly consentRecordedAtMs?: number;
	readonly effectStartedAtMs?: number;
	readonly observedClass?: BootstrapClass;
	readonly proofOfWork?: {
		readonly iterations: number;
		readonly ceiling: number;
		readonly completed: boolean;
	};
	readonly leaseExpiry?: {
		readonly source: BootstrapExpirySource;
		readonly expiresAtMs?: number;
	};
	readonly refusal?: { readonly code: string; readonly detail: string };
}

export type BootstrapExpectation =
	| { readonly kind: "consent-precedes-effect" }
	| { readonly kind: "refused"; readonly code: string }
	| { readonly kind: "proof-of-work-within-ceiling" }
	| { readonly kind: "expiry-from-provider-response" }
	| { readonly kind: "class-observed" };

export type BootstrapCase = AnonymousCase<
	BootstrapAttemptRequest,
	BootstrapExpectation
>;

const ANONYMOUS_ALLOWLIST: readonly string[] = [
	"database",
	"object-store",
	"site",
];

/**
 * The declarative case table. Data only — no behavior, no imports of anything
 * effectful, and safe to serialize into the protobuf record in `data-models/`.
 */
export const BOOTSTRAP_CASES: readonly BootstrapCase[] = Object.freeze([
	{
		id: "bootstrap/advertised-class-holds",
		check: BOOTSTRAP_CHECKS.advertisedClassHolds,
		title:
			"the class the catalog advertises is the class the provider performs",
		request: {
			caseId: "bootstrap/advertised-class-holds",
			advertisedClass: "anonymous-claimable",
			consent: "granted",
			requestedResourceKind: "database",
			allowedResourceKinds: ANONYMOUS_ALLOWLIST,
			proofOfWorkCeiling: 0,
			issuedAtMs: 1_700_000_000_000,
		},
		expect: { kind: "class-observed" },
	},
	{
		id: "bootstrap/consent-recorded-before-effect",
		check: BOOTSTRAP_CHECKS.consentBeforeEffect,
		title:
			"consent is recorded strictly before the effectful provisioning call",
		request: {
			caseId: "bootstrap/consent-recorded-before-effect",
			advertisedClass: "anonymous-claimable",
			consent: "granted",
			requestedResourceKind: "database",
			allowedResourceKinds: ANONYMOUS_ALLOWLIST,
			proofOfWorkCeiling: 0,
			issuedAtMs: 1_700_000_000_000,
		},
		expect: { kind: "consent-precedes-effect" },
	},
	{
		id: "bootstrap/withheld-consent-refuses",
		check: BOOTSTRAP_CHECKS.consentBeforeEffect,
		title: "withheld consent refuses instead of provisioning",
		request: {
			caseId: "bootstrap/withheld-consent-refuses",
			advertisedClass: "anonymous-claimable",
			consent: "withheld",
			requestedResourceKind: "database",
			allowedResourceKinds: ANONYMOUS_ALLOWLIST,
			proofOfWorkCeiling: 0,
			issuedAtMs: 1_700_000_000_000,
		},
		expect: { kind: "refused", code: "CONSENT_REQUIRED" },
	},
	{
		id: "bootstrap/proof-of-work-bounded",
		check: BOOTSTRAP_CHECKS.proofOfWorkBounded,
		title: "a proof-of-work bootstrap terminates inside its declared ceiling",
		request: {
			caseId: "bootstrap/proof-of-work-bounded",
			advertisedClass: "proof-of-work",
			consent: "granted",
			requestedResourceKind: "site",
			allowedResourceKinds: ANONYMOUS_ALLOWLIST,
			proofOfWorkCeiling: 4096,
			issuedAtMs: 1_700_000_000_000,
		},
		expect: { kind: "proof-of-work-within-ceiling" },
	},
	{
		id: "bootstrap/expiry-comes-from-provider",
		check: BOOTSTRAP_CHECKS.providerReportedExpiry,
		title:
			"lease expiry is parsed from the provider response, not a local timer",
		request: {
			caseId: "bootstrap/expiry-comes-from-provider",
			advertisedClass: "anonymous-claimable",
			consent: "granted",
			requestedResourceKind: "database",
			allowedResourceKinds: ANONYMOUS_ALLOWLIST,
			proofOfWorkCeiling: 0,
			issuedAtMs: 1_700_000_000_000,
		},
		expect: { kind: "expiry-from-provider-response" },
	},
	{
		id: "bootstrap/allowlist-refuses-unlisted-kind",
		check: BOOTSTRAP_CHECKS.resourceAllowlistFailClosed,
		title: "a resource kind outside the allowlist is refused fail-closed",
		request: {
			caseId: "bootstrap/allowlist-refuses-unlisted-kind",
			advertisedClass: "anonymous-claimable",
			consent: "granted",
			requestedResourceKind: "gpu-cluster",
			allowedResourceKinds: ANONYMOUS_ALLOWLIST,
			proofOfWorkCeiling: 0,
			issuedAtMs: 1_700_000_000_000,
		},
		expect: { kind: "refused", code: "RESOURCE_NOT_ALLOWLISTED" },
	},
]);

export function parseBootstrapAttemptOutcome(
	raw: JsonValue,
	caseId: string,
): BootstrapAttemptOutcome {
	const record = requireRecord(raw, caseId, "bootstrap outcome");
	const reportedCaseId = requireText(record.caseId, caseId, "caseId");
	if (reportedCaseId !== caseId) {
		throw new AnonymousConformanceError(
			caseId,
			`outcome reports caseId ${JSON.stringify(reportedCaseId)}`,
		);
	}

	const proofOfWork =
		record.proofOfWork === undefined
			? undefined
			: parseProofOfWork(record.proofOfWork, caseId);
	const leaseExpiry =
		record.leaseExpiry === undefined
			? undefined
			: parseLeaseExpiry(record.leaseExpiry, caseId);
	const refusal =
		record.refusal === undefined
			? undefined
			: parseRefusal(record.refusal, caseId);
	const observedClass = optionalMember(
		record.observedClass,
		caseId,
		"observedClass",
		BOOTSTRAP_CLASSES,
	);
	const consentRecordedAtMs = optionalInstant(
		record.consentRecordedAtMs,
		caseId,
		"consentRecordedAtMs",
	);
	const effectStartedAtMs = optionalInstant(
		record.effectStartedAtMs,
		caseId,
		"effectStartedAtMs",
	);

	return {
		caseId,
		effectAttempted: requireBoolean(
			record.effectAttempted,
			caseId,
			"effectAttempted",
		),
		...(consentRecordedAtMs !== undefined
			? { consentRecordedAtMs }
			: undefined),
		...(effectStartedAtMs !== undefined ? { effectStartedAtMs } : undefined),
		...(observedClass !== undefined ? { observedClass } : undefined),
		...(proofOfWork !== undefined ? { proofOfWork } : undefined),
		...(leaseExpiry !== undefined ? { leaseExpiry } : undefined),
		...(refusal !== undefined ? { refusal } : undefined),
	};
}

function parseProofOfWork(
	raw: JsonValue,
	caseId: string,
): NonNullable<BootstrapAttemptOutcome["proofOfWork"]> {
	const record = requireRecord(raw, caseId, "proofOfWork");
	const iterations = record.iterations;
	const ceiling = record.ceiling;
	if (
		!isJsonNumber(iterations) ||
		!Number.isInteger(iterations) ||
		iterations < 0
	) {
		throw new AnonymousConformanceError(
			caseId,
			"proofOfWork.iterations must be a non-negative integer",
		);
	}
	if (!isJsonNumber(ceiling) || !Number.isInteger(ceiling) || ceiling < 0) {
		throw new AnonymousConformanceError(
			caseId,
			"proofOfWork.ceiling must be a non-negative integer",
		);
	}
	return {
		iterations,
		ceiling,
		completed: requireBoolean(
			record.completed,
			caseId,
			"proofOfWork.completed",
		),
	};
}

function parseLeaseExpiry(
	raw: JsonValue,
	caseId: string,
): NonNullable<BootstrapAttemptOutcome["leaseExpiry"]> {
	const record = requireRecord(raw, caseId, "leaseExpiry");
	const expiresAtMs = optionalInstant(
		record.expiresAtMs,
		caseId,
		"leaseExpiry.expiresAtMs",
	);
	return {
		source: requireMember(
			record.source,
			caseId,
			"leaseExpiry.source",
			BOOTSTRAP_EXPIRY_SOURCES,
		),
		...(expiresAtMs !== undefined ? { expiresAtMs } : undefined),
	};
}

function parseRefusal(
	raw: JsonValue,
	caseId: string,
): NonNullable<BootstrapAttemptOutcome["refusal"]> {
	const record = requireRecord(raw, caseId, "refusal");
	return {
		code: requireText(record.code, caseId, "refusal.code"),
		detail: optionalText(record.detail, caseId, "refusal.detail") ?? "",
	};
}

function judgeBootstrapCase(
	suiteCase: BootstrapCase,
	outcome: BootstrapAttemptOutcome,
): CaseJudgement {
	switch (suiteCase.expect.kind) {
		case "consent-precedes-effect":
			return judgeConsentOrder(outcome);
		case "refused":
			return judgeRefusal(outcome, suiteCase.expect.code);
		case "proof-of-work-within-ceiling":
			return judgeProofOfWork(suiteCase, outcome);
		case "expiry-from-provider-response":
			return judgeExpiry(suiteCase, outcome);
		case "class-observed":
			return judgeObservedClass(suiteCase, outcome);
	}
}

function judgeConsentOrder(outcome: BootstrapAttemptOutcome): CaseJudgement {
	if (outcome.consentRecordedAtMs === undefined) {
		return {
			outcome: "fail",
			detail: "no consent record accompanied the bootstrap attempt",
		};
	}
	if (!outcome.effectAttempted) {
		return {
			outcome: "fail",
			detail: "consent was granted but the bootstrap effect never ran",
		};
	}
	if (outcome.effectStartedAtMs === undefined) {
		return {
			outcome: "fail",
			detail: "the effectful call reported no start instant to order against",
		};
	}
	if (outcome.consentRecordedAtMs > outcome.effectStartedAtMs) {
		return {
			outcome: "fail",
			detail: `consent was recorded at ${outcome.consentRecordedAtMs}, after the effect started at ${outcome.effectStartedAtMs}`,
		};
	}
	return {
		outcome: "pass",
		detail: `consent recorded at ${outcome.consentRecordedAtMs}, effect started at ${outcome.effectStartedAtMs}`,
	};
}

function judgeRefusal(
	outcome: BootstrapAttemptOutcome,
	expectedCode: string,
): CaseJudgement {
	if (outcome.effectAttempted) {
		return {
			outcome: "fail",
			detail:
				"the provisioning effect ran even though the attempt had to be refused",
		};
	}
	if (outcome.refusal === undefined) {
		return { outcome: "fail", detail: "no refusal was reported" };
	}
	if (outcome.refusal.code !== expectedCode) {
		return {
			outcome: "fail",
			detail: `refused with ${outcome.refusal.code}, expected ${expectedCode}`,
		};
	}
	return {
		outcome: "pass",
		detail: `refused fail-closed with ${expectedCode}`,
	};
}

function judgeProofOfWork(
	suiteCase: BootstrapCase,
	outcome: BootstrapAttemptOutcome,
): CaseJudgement {
	const proof = outcome.proofOfWork;
	if (proof === undefined) {
		return {
			outcome: "fail",
			detail: "a proof-of-work bootstrap reported no proof-of-work work",
		};
	}
	if (proof.ceiling > suiteCase.request.proofOfWorkCeiling) {
		return {
			outcome: "fail",
			detail: `provider raised the ceiling to ${proof.ceiling}, above the declared ${suiteCase.request.proofOfWorkCeiling}`,
		};
	}
	if (proof.iterations > proof.ceiling) {
		return {
			outcome: "fail",
			detail: `proof-of-work ran ${proof.iterations} iterations, past its ${proof.ceiling} ceiling`,
		};
	}
	if (!proof.completed) {
		return {
			outcome: "fail",
			detail: "proof-of-work never completed inside its ceiling",
		};
	}
	return {
		outcome: "pass",
		detail: `proof-of-work completed in ${proof.iterations}/${proof.ceiling} iterations`,
	};
}

function judgeExpiry(
	suiteCase: BootstrapCase,
	outcome: BootstrapAttemptOutcome,
): CaseJudgement {
	const expiry = outcome.leaseExpiry;
	if (expiry === undefined || expiry.source === "absent") {
		return {
			outcome: "fail",
			detail: "the bootstrap produced no lease expiry at all",
		};
	}
	if (expiry.source !== "provider-response") {
		return {
			outcome: "fail",
			detail: `lease expiry came from a ${expiry.source}; only the provider knows when it reclaims the resource`,
		};
	}
	if (expiry.expiresAtMs === undefined) {
		return {
			outcome: "fail",
			detail: "the provider response was cited but carried no expiry instant",
		};
	}
	if (expiry.expiresAtMs <= suiteCase.request.issuedAtMs) {
		return {
			outcome: "fail",
			detail: `provider-reported expiry ${expiry.expiresAtMs} is not after the request instant ${suiteCase.request.issuedAtMs}`,
		};
	}
	return {
		outcome: "pass",
		detail: `provider reported expiry ${expiry.expiresAtMs}`,
	};
}

function judgeObservedClass(
	suiteCase: BootstrapCase,
	outcome: BootstrapAttemptOutcome,
): CaseJudgement {
	if (outcome.observedClass === undefined) {
		return {
			outcome: "fail",
			detail: "the adapter reported no observed bootstrap class",
		};
	}
	if (outcome.observedClass !== suiteCase.request.advertisedClass) {
		return {
			outcome: "fail",
			detail: `advertised ${suiteCase.request.advertisedClass} but performed ${outcome.observedClass}`,
		};
	}
	if (!outcome.effectAttempted) {
		return {
			outcome: "fail",
			detail: `class ${outcome.observedClass} was advertised but no bootstrap effect ran`,
		};
	}
	return {
		outcome: "pass",
		detail: `performed the advertised ${outcome.observedClass} bootstrap`,
	};
}

export const BOOTSTRAP_CONFORMANCE_SUITE: AnonymousSuiteDefinition<
	BootstrapAttemptRequest,
	BootstrapExpectation,
	BootstrapAttemptOutcome
> = Object.freeze({
	suiteId: BOOTSTRAP_SUITE_ID,
	dimension: "bootstrap",
	checks: Object.freeze(Object.values(BOOTSTRAP_CHECKS)),
	cases: BOOTSTRAP_CASES,
	parse: parseBootstrapAttemptOutcome,
	judge: judgeBootstrapCase,
});
