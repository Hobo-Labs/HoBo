// public-contract: persisted suite documents use this versioned schema identifier.
import type { JsonValue } from "./json.js";

export const SUITE_SCHEMA = "hobo.conformance.port-suite/v1" as const;
// public-contract: persisted reports use this versioned schema identifier.
export const REPORT_SCHEMA = "hobo.conformance.port-suite-report/v1" as const;
// public-contract: SDK parity artifacts use this versioned schema identifier.
export const SDK_PARITY_SCHEMA =
	"hobo.conformance.sdk-parity-report/v1" as const;
// public-contract: deterministic conformance runs share this default seed.
export const DEFAULT_SEED = "hobo-conformance-default-seed" as const;

export type ConformanceTier = "local" | "camp";

export type FailureCode =
	| "adapter.missing-function"
	| "adapter.threw"
	| "adapter.output-mismatch"
	| "golden-ir.mismatch"
	| "golden-ir.language-leak"
	| "trace-replay.regression"
	| "determinism.second-run-failed"
	| "determinism.seed-drift"
	| "coverage.claimed-unexercised"
	| "semantics-annex.missing-vector";

export type AssertionCode =
	| "adapter.output"
	| "golden-ir.equivalence"
	| "trace-replay.equivalence";

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface ValueDiff {
	path: string;
	expected: JsonValue;
	actual: JsonValue;
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface SuiteCall {
	function: string;
	input: JsonValue;
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface SuiteExpect {
	output?: JsonValue;
	goldenIr?: JsonValue;
	replayTrace?: JsonValue;
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface SuiteCase {
	id: string;
	tier: ConformanceTier;
	exercises?: string[];
	call: SuiteCall;
	expect?: SuiteExpect;
}

export interface ConformanceSuiteDefinition {
	id: string;
	port: {
		wit: string;
		functions: string[];
	};
	coverage?: {
		requiredFunctions?: string[];
	};
	cases: Array<
		Omit<SuiteCase, "tier"> & {
			tier?: ConformanceTier;
		}
	>;
}

export interface ConformanceSuite {
	schema: typeof SUITE_SCHEMA;
	id: string;
	port: {
		wit: string;
		functions: string[];
	};
	coverage: {
		requiredFunctions: string[];
	};
	cases: SuiteCase[];
}

export interface CaseContext {
	seed: string;
	caseId: string;
	random: () => number;
}

export interface AdapterResult {
	output: unknown;
	goldenIr: unknown;
	replayTrace: unknown;
}

export type AdapterFunction = (
	input: JsonValue,
	ctx: CaseContext,
) => Promise<AdapterResult> | AdapterResult;

export interface ConformanceAdapter {
	id: string;
	[fn: string]: AdapterFunction | string | number | undefined;
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface CaseAssertion {
	code: AssertionCode;
	caseId: string;
	function: string;
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface ConformanceFailure {
	code: FailureCode;
	caseId?: string;
	function?: string;
	seed?: string;
	path?: string;
	language?: string;
	categories?: string[];
	functions?: string[];
	message?: string;
	diff?: ValueDiff;
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface CoverageManifest {
	exercisedFunctions: string[];
	requiredFunctions: string[];
	unexercisedFunctions: string[];
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface RunProvenance {
	suiteId: string;
	port: string;
	adapterId: string;
	seed: string;
	cases: string[];
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface AdapterClaim {
	status: "listed" | "blocked";
	port: string;
	adapterId: string;
	failureCodes: FailureCode[];
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface PortSuiteReport {
	schema: typeof REPORT_SCHEMA;
	ok: boolean;
	suiteId: string;
	port: string;
	adapterId: string;
	seed: string;
	provenance: RunProvenance;
	claim: AdapterClaim;
	assertions: CaseAssertion[];
	coverage: CoverageManifest;
	failures: ConformanceFailure[];
	events: ConformanceRunEvent[];
}

export type ConformanceRunEvent =
	| {
			type: "conformance.RunStarted";
			suiteId: string;
			port: string;
			adapterId: string;
			seed: string;
			caseIds: string[];
	  }
	| {
			type: "conformance.CaseChecked";
			caseId: string;
			function: string;
			tier: ConformanceTier;
			skipped: boolean;
			failures: ConformanceFailure[];
			assertions: CaseAssertion[];
	  }
	| {
			type: "conformance.CoverageEvaluated";
			coverage: CoverageManifest;
			failures: ConformanceFailure[];
	  }
	| {
			type: "conformance.RunCompleted";
			ok: boolean;
			failureCodes: FailureCode[];
	  };

export interface RunConformanceSuiteOptions {
	seed?: string;
	determinism?: boolean;
	adapterId?: string;
	tiers?: ConformanceTier[];
	registry?: AdapterRegistry;
}

export interface AdapterRegistry {
	register(adapter: ConformanceAdapter): void;
	get(id: string): ConformanceAdapter | undefined;
	list(): ConformanceAdapter[];
}

/**
 * What a suite advertises about itself: the checks it can decide and the cases
 * it decides them with. Registering the description separately from the runner
 * is what lets a Resource Definition's `conformanceRef` point at a suite before
 * anybody has run it.
 */
// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface ConformanceSuiteDescriptor {
	readonly suiteId: string;
	readonly dimension: string;
	readonly checks: readonly string[];
	readonly caseIds: readonly string[];
}

export interface ConformanceSuiteRegistry {
	register(descriptor: ConformanceSuiteDescriptor): void;
	get(suiteId: string): ConformanceSuiteDescriptor | undefined;
	list(): readonly ConformanceSuiteDescriptor[];
	/** Every check any registered suite can decide, deduplicated and sorted. */
	checks(): readonly string[];
}

export interface SdkParityInput {
	language?: string;
	goldenIr?: {
		equivalent?: boolean;
		ir?: JsonValue;
	};
	semanticsAnnex?: {
		vectors?: Array<{
			category: string;
			passed?: boolean;
		}>;
	};
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface SdkParityReport {
	schema: typeof SDK_PARITY_SCHEMA;
	ok: boolean;
	language: string;
	failures: ConformanceFailure[];
}
