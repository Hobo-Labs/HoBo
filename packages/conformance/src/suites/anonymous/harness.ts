/**
 * The shared runner behind all four anonymous-dimension suites.
 *
 * It owns the two rules that make the resulting evidence trustworthy:
 *
 * 1. **A case that did not run is `unknown`.** Filtering, an unsupported
 *    provider capability, and an empty check all collapse to `unknown`, never
 *    to `pass`.
 * 2. **Aggregation is worst-wins.** One failing case sinks its check; one
 *    unknown case downgrades an otherwise-passing check. There is no averaging
 *    and no "mostly passed".
 */
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../../json.js";
import {
	ANONYMOUS_CONFORMANCE_SCHEMA,
	type AnonymousCase,
	type AnonymousCaseOutcome,
	type AnonymousCaseResult,
	AnonymousConformanceError,
	type AnonymousConformanceReport,
	type AnonymousDimension,
	type AnonymousExecutor,
	type AnonymousSuiteDescriptor,
	UnsupportedCheckError,
} from "./types.js";

export interface CaseJudgement {
	readonly outcome: AnonymousCaseOutcome;
	readonly detail: string;
}

/**
 * A suite is a description, not a program: cases plus the parser that turns an
 * executor's answer into a derived domain type, plus the pure judge.
 */
export interface AnonymousSuiteDefinition<TRequest, TExpectation, TOutcome> {
	readonly suiteId: string;
	readonly dimension: AnonymousDimension;
	readonly checks: readonly string[];
	readonly cases: readonly AnonymousCase<TRequest, TExpectation>[];
	readonly parse: (raw: JsonValue, caseId: string) => TOutcome;
	readonly judge: (
		suiteCase: AnonymousCase<TRequest, TExpectation>,
		outcome: TOutcome,
	) => CaseJudgement;
}

export interface RunAnonymousSuiteOptions {
	readonly subjectId?: string;
	/** Run only these cases. Everything omitted reports as `unknown`. */
	readonly caseIds?: readonly string[];
}

interface CaseOutcomeBag {
	[check: string]: AnonymousCaseOutcome;
}

interface OutcomeSeverity {
	readonly pass: number;
	readonly unknown: number;
	readonly fail: number;
}

const OUTCOME_SEVERITY: OutcomeSeverity = {
	pass: 0,
	unknown: 1,
	fail: 2,
};

export function describeAnonymousSuite<TRequest, TExpectation, TOutcome>(
	definition: AnonymousSuiteDefinition<TRequest, TExpectation, TOutcome>,
): AnonymousSuiteDescriptor {
	return Object.freeze({
		suiteId: definition.suiteId,
		dimension: definition.dimension,
		checks: Object.freeze([...definition.checks]),
		caseIds: Object.freeze(definition.cases.map((suiteCase) => suiteCase.id)),
	});
}

export async function runAnonymousSuite<TRequest, TExpectation, TOutcome>(
	definition: AnonymousSuiteDefinition<TRequest, TExpectation, TOutcome>,
	execute: AnonymousExecutor<TRequest>,
	options: RunAnonymousSuiteOptions = {},
): Promise<AnonymousConformanceReport> {
	if (!(execute instanceof Function)) {
		throw new TypeError("an anonymous conformance executor is required");
	}

	const selected =
		options.caseIds === undefined ? undefined : new Set(options.caseIds);
	const results: AnonymousCaseResult[] = [];

	for (const suiteCase of definition.cases) {
		if (selected !== undefined && !selected.has(suiteCase.id)) {
			results.push({
				caseId: suiteCase.id,
				check: suiteCase.check,
				outcome: "unknown",
				detail: "case was not selected for this run",
				failureCode: "case.not-executed",
			});
			continue;
		}
		results.push(await evaluateCase(definition, suiteCase, execute));
	}

	const checks = aggregateChecks(definition.checks, results);

	return Object.freeze({
		schema: ANONYMOUS_CONFORMANCE_SCHEMA,
		suiteId: definition.suiteId,
		dimension: definition.dimension,
		subjectId: options.subjectId ?? "unknown-subject",
		cases: Object.freeze(results),
		checks: Object.freeze(checks),
		ok: Object.values(checks).every((outcome) => outcome === "pass"),
	});
}

async function evaluateCase<TRequest, TExpectation, TOutcome>(
	definition: AnonymousSuiteDefinition<TRequest, TExpectation, TOutcome>,
	suiteCase: AnonymousCase<TRequest, TExpectation>,
	execute: AnonymousExecutor<TRequest>,
): Promise<AnonymousCaseResult> {
	let raw: JsonValue;
	try {
		raw = await execute(suiteCase.request);
	} catch (error) {
		if (error instanceof UnsupportedCheckError) {
			return {
				caseId: suiteCase.id,
				check: suiteCase.check,
				outcome: "unknown",
				detail: `executor cannot exercise this case: ${error.message}`,
				failureCode: "check.unsupported",
			};
		}
		return {
			caseId: suiteCase.id,
			check: suiteCase.check,
			outcome: "fail",
			detail: `executor threw: ${messageOf(error)}`,
			failureCode: "executor.threw",
		};
	}

	let parsed: TOutcome;
	try {
		parsed = definition.parse(raw, suiteCase.id);
	} catch (error) {
		return {
			caseId: suiteCase.id,
			check: suiteCase.check,
			outcome: "fail",
			detail:
				error instanceof AnonymousConformanceError
					? error.message
					: `outcome did not parse: ${messageOf(error)}`,
			failureCode: "executor.unparseable-outcome",
		};
	}

	const judgement = definition.judge(suiteCase, parsed);
	return {
		caseId: suiteCase.id,
		check: suiteCase.check,
		outcome: judgement.outcome,
		detail: judgement.detail,
		...(judgement.outcome === "fail"
			? { failureCode: "expectation.unmet" as const }
			: undefined),
	};
}

/**
 * Fold case results into per-check outcomes.
 *
 * A declared check with no results is `unknown` rather than absent, so a caller
 * cannot mistake "we never wrote a case for this" for "nothing went wrong".
 */
export function aggregateChecks(
	declaredChecks: readonly string[],
	results: readonly AnonymousCaseResult[],
): CaseOutcomeBag {
	const folded = new Map<string, AnonymousCaseOutcome>();
	for (const result of results) {
		const current = folded.get(result.check);
		folded.set(
			result.check,
			current === undefined ? result.outcome : worst(current, result.outcome),
		);
	}

	// Declared checks come first and in sorted order, so the map a caller
	// digests does not depend on which cases happened to run.
	const checks: CaseOutcomeBag = {};
	for (const check of [...declaredChecks].sort()) {
		checks[check] = folded.get(check) ?? "unknown";
	}
	for (const [check, outcome] of [...folded.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (!(check in checks)) {
			checks[check] = outcome;
		}
	}
	return checks;
}

export function worst(
	left: AnonymousCaseOutcome,
	right: AnonymousCaseOutcome,
): AnonymousCaseOutcome {
	return OUTCOME_SEVERITY[left] >= OUTCOME_SEVERITY[right] ? left : right;
}

function messageOf<T>(error: T): string {
	return error instanceof Error ? error.message : String(error);
}

/** Shared parse helpers. Kept here so every suite rejects the same way. */
export function requireRecord<T>(
	value: T,
	caseId: string,
	field: string,
): JsonObject {
	if (value === null || !isJsonObject(value) || Array.isArray(value)) {
		throw new AnonymousConformanceError(caseId, `${field} must be an object`);
	}
	// SAFETY: assertion to `value as JsonObject` is required at this boundary.
	return value as JsonObject;
}

export function requireBoolean<T>(
	value: T,
	caseId: string,
	field: string,
): boolean {
	if (!isJsonBoolean(value)) {
		throw new AnonymousConformanceError(caseId, `${field} must be a boolean`);
	}
	return value;
}

export function optionalBoolean<T>(
	value: T,
	caseId: string,
	field: string,
): boolean | undefined {
	return value === undefined ? undefined : requireBoolean(value, caseId, field);
}

export function requireText<T>(
	value: T,
	caseId: string,
	field: string,
): string {
	if (!isJsonString(value) || value.trim().length === 0) {
		throw new AnonymousConformanceError(
			caseId,
			`${field} must be a non-empty string`,
		);
	}
	return value;
}

export function optionalText<T>(
	value: T,
	caseId: string,
	field: string,
): string | undefined {
	return value === undefined ? undefined : requireText(value, caseId, field);
}

export function requireInstant<T>(
	value: T,
	caseId: string,
	field: string,
): number {
	if (!isJsonNumber(value) || !Number.isInteger(value)) {
		throw new AnonymousConformanceError(
			caseId,
			`${field} must be an integer epoch-millisecond instant`,
		);
	}
	return value;
}

export function optionalInstant<T>(
	value: T,
	caseId: string,
	field: string,
): number | undefined {
	return value === undefined ? undefined : requireInstant(value, caseId, field);
}

export function requireMember<TValue, T extends string>(
	value: TValue,
	caseId: string,
	field: string,
	allowed: readonly T[],
): T {
	if (
		!isJsonString(value) ||
		// SAFETY: assertion to `allowed as readonly string[]` is required at this boundary.
		!(allowed as readonly string[]).includes(value)
	) {
		throw new AnonymousConformanceError(
			caseId,
			`${field} must be one of ${allowed.join(", ")}`,
		);
	}
	// SAFETY: allowed-member parse restores the closed string union.
	return value as never;
}

export function optionalMember<TValue, T extends string>(
	value: TValue,
	caseId: string,
	field: string,
	allowed: readonly T[],
): T | undefined {
	return value === undefined
		? undefined
		: requireMember(value, caseId, field, allowed);
}

export function requireTextArray<T>(
	value: T,
	caseId: string,
	field: string,
): readonly string[] {
	if (!Array.isArray(value)) {
		throw new AnonymousConformanceError(caseId, `${field} must be an array`);
	}
	return value.map((entry, index) =>
		requireText(entry, caseId, `${field}[${index}]`),
	);
}
