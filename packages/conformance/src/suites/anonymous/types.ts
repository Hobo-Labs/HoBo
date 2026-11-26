/**
 * The anonymous/claimable conformance dimension.
 *
 * Every other suite in this package asks "does this adapter implement the port
 * correctly". These four ask a different question: **is the product's story
 * about ownership true**. A product that advertises anonymous bootstrap and a
 * one-click claim is making a claim about who holds authority over a resource
 * at each instant, and that claim is only worth anything if it was executed
 * against the real provider and written down.
 *
 * The cases are pure data. Everything effectful — network, clock, randomness,
 * environment, filesystem — arrives through an injected executor port, so the
 * mandatory lane replays offline and deterministically and the live lane is the
 * same data driven by a real adapter.
 */

import type { EvidenceCheckOutcome } from "@hobo/trust";
import type { JsonValue } from "../../json.js";

import type { ConformanceSuiteDescriptor } from "../../types.js";

// public-contract: versions anonymous-provider conformance reports.
export const ANONYMOUS_CONFORMANCE_SCHEMA =
	"hobo.conformance.anonymous-claimable/v1" as const;

/** The four dimensions of the ownership story. */
export type AnonymousDimension =
	| "bootstrap"
	| "claim"
	| "binding"
	| "migration";

/**
 * A single case outcome.
 *
 * `unknown` is structurally distinct from `pass` everywhere in this package and
 * is never widened into one: a check nobody ran is not a check that succeeded.
 */
export type AnonymousCaseOutcome = EvidenceCheckOutcome;

/** Stable, machine-readable reasons a case did not pass. */
export const ANONYMOUS_FAILURE_CODES = [
	"executor.threw",
	"executor.unparseable-outcome",
	"expectation.unmet",
	"case.not-executed",
	"check.unsupported",
] as const;

export type AnonymousFailureCode = (typeof ANONYMOUS_FAILURE_CODES)[number];

// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface AnonymousCaseResult {
	readonly caseId: string;
	readonly check: string;
	readonly outcome: AnonymousCaseOutcome;
	readonly detail: string;
	readonly failureCode?: AnonymousFailureCode;
}

// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface AnonymousConformanceReport {
	readonly schema: typeof ANONYMOUS_CONFORMANCE_SCHEMA;
	readonly suiteId: string;
	readonly dimension: AnonymousDimension;
	readonly subjectId: string;
	readonly cases: readonly AnonymousCaseResult[];
	/** Declared check -> aggregated outcome. Every declared check is present. */
	readonly checks: Readonly<Record<string, AnonymousCaseOutcome>>;
	/** True only when every declared check passed. Unknown never counts. */
	readonly ok: boolean;
}

/**
 * A declarative case: the request handed to the executor plus the expectation
 * the runner evaluates against whatever comes back.
 */
export interface AnonymousCase<TRequest, TExpectation> {
	readonly id: string;
	readonly check: string;
	readonly title: string;
	readonly request: TRequest;
	readonly expect: TExpectation;
}

/** The single effectful seam. Offline lanes pass a table; live lanes a driver. */
export type AnonymousExecutor<TRequest> = (
	request: TRequest,
) => JsonValue | Promise<JsonValue>;

/**
 * Thrown by an executor that cannot exercise a case at all.
 *
 * Distinct from a thrown error because "the provider has no export API" is an
 * honest `unknown`, whereas "the export API blew up" is a `fail`. Conflating
 * them is exactly how an untested product acquires a passing record.
 */
export class UnsupportedCheckError extends Error {
	readonly code = "CHECK_UNSUPPORTED" as const;

	constructor(message: string) {
		super(message);
		this.name = "UnsupportedCheckError";
	}
}

/** Parse-boundary rejection for an executor outcome that is not the declared shape. */
export class AnonymousConformanceError extends Error {
	readonly code = "INVALID_ANONYMOUS_OUTCOME" as const;
	readonly caseId: string;

	constructor(caseId: string, detail: string) {
		super(`case ${caseId}: ${detail}`);
		this.name = "AnonymousConformanceError";
		this.caseId = caseId;
	}
}

/** A descriptor narrowed to this dimension, for the shared suite registry. */
export type AnonymousSuiteDescriptor = ConformanceSuiteDescriptor & {
	readonly dimension: AnonymousDimension;
};
