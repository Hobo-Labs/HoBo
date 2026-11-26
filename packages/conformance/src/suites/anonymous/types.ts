import type { EvidenceCheckOutcome } from "@hobo/trust";
import type { JsonValue } from "../../json.js";

import type { ConformanceSuiteDescriptor } from "../../types.js";

// public-contract: versions anonymous-provider conformance reports.
export const ANONYMOUS_CONFORMANCE_SCHEMA =
	"hobo.conformance.anonymous-claimable/v1" as const;

export type AnonymousDimension =
	| "bootstrap"
	| "claim"
	| "binding"
	| "migration";

export type AnonymousCaseOutcome = EvidenceCheckOutcome;

export const ANONYMOUS_FAILURE_CODES = [
	"executor.threw",
	"executor.unparseable-outcome",
	"expectation.unmet",
	"case.not-executed",
	"check.unsupported",
] as const;

export type AnonymousFailureCode = (typeof ANONYMOUS_FAILURE_CODES)[number];

// domain-view:
export interface AnonymousCaseResult {
	readonly caseId: string;
	readonly check: string;
	readonly outcome: AnonymousCaseOutcome;
	readonly detail: string;
	readonly failureCode?: AnonymousFailureCode;
}

// domain-view:
export interface AnonymousConformanceReport {
	readonly schema: typeof ANONYMOUS_CONFORMANCE_SCHEMA;
	readonly suiteId: string;
	readonly dimension: AnonymousDimension;
	readonly subjectId: string;
	readonly cases: readonly AnonymousCaseResult[];
	readonly checks: Readonly<Record<string, AnonymousCaseOutcome>>;
	readonly ok: boolean;
}

export interface AnonymousCase<TRequest, TExpectation> {
	readonly id: string;
	readonly check: string;
	readonly title: string;
	readonly request: TRequest;
	readonly expect: TExpectation;
}

export type AnonymousExecutor<TRequest> = (
	request: TRequest,
) => JsonValue | Promise<JsonValue>;

export class UnsupportedCheckError extends Error {
	readonly code = "CHECK_UNSUPPORTED" as const;

	constructor(message: string) {
		super(message);
		this.name = "UnsupportedCheckError";
	}
}

export class AnonymousConformanceError extends Error {
	readonly code = "INVALID_ANONYMOUS_OUTCOME" as const;
	readonly caseId: string;

	constructor(caseId: string, detail: string) {
		super(`case ${caseId}: ${detail}`);
		this.name = "AnonymousConformanceError";
		this.caseId = caseId;
	}
}

export type AnonymousSuiteDescriptor = ConformanceSuiteDescriptor & {
	readonly dimension: AnonymousDimension;
};
