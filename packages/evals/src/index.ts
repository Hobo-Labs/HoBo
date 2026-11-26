import type { ResidencyGateVerdict } from "@hobo/contracts";

// Rubric + promotion-gate engine (design PLAN-23).
// Rubrics are schema-versioned records; scoring is a deterministic pure
// function producing a frozen report that mirrors the @hobo/conformance
// suite/report vocabulary (schema id, ok, failures with machine-readable
// codes); the promotion verdict is shaped as a Gatekeeper precomputed
// dimension ({ok, reasons}) so callers hand it to Gatekeeper composition as
// the evals dimension. Parse, don't validate: raw definitions and
// observations lower onto parsed derived types or throw typed errors — no
// unchecked shapes escape this boundary. Evaluators are ports; this package
// hosts no models.

// public-contract: rubric record schema id promotion tooling pins.
export const EVALS_RUBRIC_SCHEMA = "hobo.evals.rubric/v1";
// public-contract: rubric report schema id scored-run evidence pins.
export const EVALS_RUBRIC_REPORT_SCHEMA = "hobo.evals.rubric-report/v1";
// public-contract: promotion verdict schema id the Gatekeeper evals dimension pins.
export const EVALS_PROMOTION_VERDICT_SCHEMA = "hobo.evals.promotion-verdict/v1";
// public-contract: default golden suite for trainable code (exact-match)
export const GOLDEN_DEFAULT_SUITE_ID =
	"hobo.evals.trainable-golden/v1" as const;
// public-contract: default silver suite for trainable code (property/fuzz)
export const SILVER_DEFAULT_SUITE_ID =
	"hobo.evals.trainable-silver/v1" as const;

export type ScoringKind = "boolean" | "scale" | "golden-match";

type EvaluationValue =
	| undefined
	| null
	| boolean
	| number
	| string
	| bigint
	| symbol
	| object
	| ((...args: never[]) => EvaluationValue);
type ValueKind =
	| "undefined"
	| "null"
	| "boolean"
	| "number"
	| "string"
	| "bigint"
	| "symbol"
	| "function"
	| "object";

function valueKind<T>(value: T): ValueKind {
	const tag = Object.prototype.toString.call(value);
	if (tag === "[object Undefined]") return "undefined";
	if (tag === "[object Null]") return "null";
	if (tag === "[object Boolean]") return "boolean";
	if (tag === "[object Number]") return "number";
	if (tag === "[object String]") return "string";
	if (tag === "[object BigInt]") return "bigint";
	if (tag === "[object Symbol]") return "symbol";
	if (tag === "[object Function]") return "function";
	return "object";
}

function isNumber<T>(value: T): value is T & number {
	return valueKind(value) === "number";
}

function isBoolean<T>(value: T): value is T & boolean {
	return valueKind(value) === "boolean";
}

export type EvalsFailureCode =
	| "criterion.below-threshold"
	| "criterion.required-failed"
	| "rubric.total-below-threshold";

/** Typed parse failure raised at the rubric authoring boundary. */
export class RubricParseError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "RubricParseError";
	}
}

/** Typed parse failure raised at the observation ingestion boundary. */
export class ObservationParseError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "ObservationParseError";
	}
}

/** Typed parse failure raised at the promotion-gate boundary. */
export class PromotionGateParseError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "PromotionGateParseError";
	}
}

export interface RubricCriterionDefinition {
	id: string;
	description?: string;
	/** Relative weight in the weighted total; finite and > 0. */
	weight: number;
	kind: ScoringKind;
	/** Scale criteria only: score floor in [0,1]; boolean/golden-match imply 1. */
	passThreshold?: number;
	/** Golden-match criteria only: the blessed expected value (JSON data). */
	expected?: EvaluationValue;
	/** Hard gate: a failing required criterion fails the rubric outright. */
	required?: boolean;
}

export interface RubricDefinition {
	id: string;
	/** Weighted-total floor in [0,1] the rubric as a whole must reach. */
	passThreshold: number;
	criteria: RubricCriterionDefinition[];
}

// domain-view: parse-produced criterion (unknown golden payload, literal kind union); wire form is RubricCriterion in data-models/evals.proto.
export interface RubricCriterion {
	readonly id: string;
	readonly description: string;
	readonly weight: number;
	readonly kind: ScoringKind;
	readonly passThreshold: number;
	readonly expected?: EvaluationValue;
	readonly required: boolean;
}

// domain-view: parse-produced rubric record; wire form is Rubric in data-models/evals.proto.
export interface Rubric {
	readonly schema: typeof EVALS_RUBRIC_SCHEMA;
	readonly id: string;
	readonly passThreshold: number;
	readonly criteria: readonly RubricCriterion[];
}

/** One raw observation per criterion; scoreRubric parses it by criterion kind. */
export interface RubricObservationInput {
	criterionId: string;
	/** Boolean criteria. */
	passed?: boolean;
	/** Scale criteria: score in [0,1]. */
	score?: number;
	/** Golden-match criteria: the actual value to compare canonically. */
	actual?: EvaluationValue;
}

// domain-view: first-divergence record over unknown values; wire form is ValueDiff (JSON-encoded sides) in data-models/evals.proto.
export interface ValueDiff {
	readonly path: string;
	readonly expected: EvaluationValue;
	readonly actual: EvaluationValue;
}

// domain-view: scored criterion with literal kind union and optional structured diff; wire form is CriterionScore in data-models/evals.proto.
export interface CriterionScore {
	readonly criterionId: string;
	readonly kind: ScoringKind;
	readonly weight: number;
	readonly passThreshold: number;
	readonly score: number;
	readonly passed: boolean;
	readonly diff?: ValueDiff;
}

// domain-view: machine-readable failure with literal code union; wire form is EvalsFailure in data-models/evals.proto.
export interface EvalsFailure {
	readonly code: EvalsFailureCode;
	readonly criterionId?: string;
	readonly message: string;
}

// domain-view: frozen scored-run report (literal schema type); wire form is RubricReport in data-models/evals.proto.
export interface RubricReport {
	readonly schema: typeof EVALS_RUBRIC_REPORT_SCHEMA;
	readonly ok: boolean;
	readonly rubricId: string;
	readonly passThreshold: number;
	readonly weightedTotal: number;
	readonly scores: readonly CriterionScore[];
	readonly failures: readonly EvalsFailure[];
}

// domain-view: machine-readable gate reason; wire form is GateReason in data-models/evals.proto.
export interface GateReason {
	readonly code: string;
	readonly message: string;
}

// domain-view: Gatekeeper-dimension-shaped verdict ({ok, reasons}); wire form is PromotionGateVerdict in data-models/evals.proto.
export interface PromotionGateVerdict {
	readonly ok: boolean;
	readonly reasons: ReadonlyArray<GateReason>;
}

export interface PromotionGateThresholds {
	/** Extra weighted-total floor in [0,1] beyond the rubric's own passThreshold. */
	minWeightedTotal?: number;
	/** Require report.ok itself (default true). */
	requireRubricPass?: boolean;
}

/**
 * Parse a raw rubric definition into the schema-versioned, deeply frozen
 * rubric record. Parse, don't validate: every constraint (non-empty ids,
 * positive finite weights, [0,1] thresholds, kind-specific fields,
 * duplicate-free criteria) is enforced here so scoring never re-checks.
 */
export function defineRubric(definition: RubricDefinition): Rubric {
	if (!definition || valueKind(definition) !== "object") {
		throw new RubricParseError("rubric definition is required");
	}
	if (valueKind(definition.id) !== "string" || definition.id.length === 0) {
		throw new RubricParseError("rubric id must be a non-empty string");
	}
	const passThreshold = parseUnitInterval(
		definition.passThreshold,
		`rubric "${definition.id}" passThreshold`,
		RubricParseError,
	);
	if (!Array.isArray(definition.criteria) || definition.criteria.length === 0) {
		throw new RubricParseError(
			`rubric "${definition.id}" must declare at least one criterion`,
		);
	}

	const seen = new Set<string>();
	const criteria = definition.criteria.map((criterion) => {
		const parsed = parseCriterion(definition.id, criterion);
		if (seen.has(parsed.id)) {
			throw new RubricParseError(
				`rubric "${definition.id}" declares criterion "${parsed.id}" twice`,
			);
		}
		seen.add(parsed.id);
		return parsed;
	});

	return deepFreeze({
		schema: EVALS_RUBRIC_SCHEMA,
		id: definition.id,
		passThreshold,
		criteria,
	});
}

function parseCriterion(
	rubricId: string,
	criterion: RubricCriterionDefinition,
): RubricCriterion {
	if (!criterion || valueKind(criterion) !== "object") {
		throw new RubricParseError(`rubric "${rubricId}" criterion is required`);
	}
	if (valueKind(criterion.id) !== "string" || criterion.id.length === 0) {
		throw new RubricParseError(
			`rubric "${rubricId}" criterion id must be a non-empty string`,
		);
	}
	const label = `rubric "${rubricId}" criterion "${criterion.id}"`;
	if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) {
		throw new RubricParseError(`${label} weight must be a finite number > 0`);
	}
	if (
		criterion.kind !== "boolean" &&
		criterion.kind !== "scale" &&
		criterion.kind !== "golden-match"
	) {
		throw new RubricParseError(
			`${label} kind must be boolean, scale, or golden-match`,
		);
	}
	let passThreshold = 1;
	if (criterion.kind === "scale") {
		passThreshold = parseUnitInterval(
			criterion.passThreshold,
			`${label} passThreshold`,
			RubricParseError,
		);
	} else if (criterion.passThreshold !== undefined) {
		throw new RubricParseError(
			`${label} passThreshold is only meaningful for scale criteria`,
		);
	}
	let expected: { expected: EvaluationValue } | undefined;
	if (criterion.kind === "golden-match") {
		if (criterion.expected === undefined) {
			throw new RubricParseError(
				`${label} must bless an expected value for golden-match scoring`,
			);
		}
		try {
			expected = { expected: structuredClone(criterion.expected) };
		} catch {
			throw new RubricParseError(
				`${label} expected value must be structured-cloneable data`,
			);
		}
	} else if (criterion.expected !== undefined) {
		throw new RubricParseError(
			`${label} expected is only meaningful for golden-match criteria`,
		);
	}
	const parsed = {
		id: criterion.id,
		description: criterion.description ?? "",
		weight: criterion.weight,
		kind: criterion.kind,
		passThreshold,
		required: criterion.required === true,
	};
	if (expected) return { ...parsed, expected: expected.expected };
	return parsed;
}

/**
 * Deterministically score a rubric against one observation per criterion,
 * producing the frozen scored-run report. Observations parse by criterion
 * kind (boolean/scale/golden-match) or throw ObservationParseError; the
 * report carries per-criterion scores, the weighted total, and
 * machine-readable failures — same shape discipline as the conformance
 * PortSuiteReport.
 */
export function scoreRubric(
	rubric: Rubric,
	observations: readonly RubricObservationInput[],
): RubricReport {
	if (!rubric || rubric.schema !== EVALS_RUBRIC_SCHEMA) {
		throw new RubricParseError(
			"rubric must be the parsed record defineRubric produces",
		);
	}
	if (!Array.isArray(observations)) {
		throw new ObservationParseError("observations must be an array");
	}

	const byCriterion = new Map<string, RubricObservationInput>();
	const known = new Set(rubric.criteria.map((criterion) => criterion.id));
	for (const observation of observations) {
		if (
			!observation ||
			valueKind(observation) !== "object" ||
			valueKind(observation.criterionId) !== "string"
		) {
			throw new ObservationParseError(
				"every observation must name a criterionId",
			);
		}
		if (!known.has(observation.criterionId)) {
			throw new ObservationParseError(
				`observation names unknown criterion "${observation.criterionId}"`,
			);
		}
		if (byCriterion.has(observation.criterionId)) {
			throw new ObservationParseError(
				`criterion "${observation.criterionId}" is observed twice`,
			);
		}
		byCriterion.set(observation.criterionId, observation);
	}

	const scores = rubric.criteria.map((criterion) => {
		const observation = byCriterion.get(criterion.id);
		if (!observation) {
			throw new ObservationParseError(
				`criterion "${criterion.id}" has no observation`,
			);
		}
		return scoreCriterion(criterion, observation);
	});

	const totalWeight = rubric.criteria.reduce(
		(sum, criterion) => sum + criterion.weight,
		0,
	);
	const weightedTotal =
		scores.reduce((sum, entry) => sum + entry.weight * entry.score, 0) /
		totalWeight;

	const failures: EvalsFailure[] = [];
	for (const [index, entry] of scores.entries()) {
		if (entry.passed) continue;
		const required = rubric.criteria[index]?.required === true;
		failures.push({
			code: required
				? "criterion.required-failed"
				: "criterion.below-threshold",
			criterionId: entry.criterionId,
			message: required
				? `required criterion "${entry.criterionId}" failed (score ${entry.score})`
				: `criterion "${entry.criterionId}" scored ${entry.score}, below its pass threshold ${entry.passThreshold}`,
		});
	}
	const totalOk = weightedTotal >= rubric.passThreshold;
	if (!totalOk) {
		failures.push({
			code: "rubric.total-below-threshold",
			message: `weighted total ${weightedTotal} is below the rubric pass threshold ${rubric.passThreshold}`,
		});
	}
	const requiredOk = failures.every(
		(failure) => failure.code !== "criterion.required-failed",
	);

	return deepFreeze({
		schema: EVALS_RUBRIC_REPORT_SCHEMA,
		ok: totalOk && requiredOk,
		rubricId: rubric.id,
		passThreshold: rubric.passThreshold,
		weightedTotal,
		scores,
		failures,
	});
}

function scoreCriterion(
	criterion: RubricCriterion,
	observation: RubricObservationInput,
): CriterionScore {
	const base = {
		criterionId: criterion.id,
		kind: criterion.kind,
		weight: criterion.weight,
		passThreshold: criterion.passThreshold,
	};
	if (criterion.kind === "boolean") {
		if (!isBoolean(observation.passed)) {
			throw new ObservationParseError(
				`boolean criterion "${criterion.id}" needs a boolean \`passed\` observation`,
			);
		}
		return {
			...base,
			score: observation.passed ? 1 : 0,
			passed: observation.passed,
		};
	}
	if (criterion.kind === "scale") {
		const score = observation.score;
		if (!isNumber(score) || !Number.isFinite(score)) {
			throw new ObservationParseError(
				`scale criterion "${criterion.id}" needs a finite \`score\` observation`,
			);
		}
		if (score < 0 || score > 1) {
			throw new ObservationParseError(
				`scale criterion "${criterion.id}" score ${score} is outside [0,1]`,
			);
		}
		return { ...base, score, passed: score >= criterion.passThreshold };
	}
	if (!Object.hasOwn(observation, "actual")) {
		throw new ObservationParseError(
			`golden-match criterion "${criterion.id}" needs an \`actual\` observation`,
		);
	}
	const match = matchGolden(criterion.expected, observation.actual);
	const score = {
		...base,
		score: match.equal ? 1 : 0,
		passed: match.equal,
	};
	if (match.diff) return { ...score, diff: match.diff };
	return score;
}

/**
 * Golden-match scoring primitive: compare an expected/actual pair by
 * canonical JSON (object key order is irrelevant); on mismatch, report the
 * first diverging path — the same first-diff vocabulary the conformance
 * golden checks use.
 */
export function matchGolden<
	T extends EvaluationValue,
	U extends EvaluationValue,
>(expected: T, actual: U): MatchGoldenResult {
	if (canonicalJson(expected) === canonicalJson(actual)) {
		return { equal: true };
	}
	const diff = firstDiff(expected, actual);
	const result: MutableMatchGoldenResult = { equal: false };
	if (diff) result.diff = diff;
	return result;
}

export interface MatchGoldenResult {
	readonly equal: boolean;
	readonly diff?: ValueDiff;
}

interface MutableMatchGoldenResult {
	equal: boolean;
	diff?: ValueDiff;
}

/** Canonical JSON encoding: recursively key-sorted, so comparison is order-independent. */
export function canonicalJson<T>(
	value: T,
	seen: WeakSet<object> = new WeakSet(),
): string {
	if (value === undefined) return "undefined";
	const kind = valueKind(value);
	if (kind === "bigint") return `${value}n`;
	if (kind === "symbol") return JSON.stringify(String(value));
	if (kind === "function") {
		return JSON.stringify(
			// SAFETY: valueKind(value) is "function", whose optional name is standard.
			`fn:${(value as { name?: string }).name || "anonymous"}`,
		);
	}
	if (kind === "number") {
		// SAFETY: valueKind(value) is "number", so the numeric operations are valid.
		const numberValue = value as number;
		if (Number.isNaN(numberValue)) return "NaN";
		if (Object.is(value, -0)) return "-0";
		if (!Number.isFinite(numberValue)) return String(value);
	}
	if (value === null || kind !== "object") {
		try {
			const text = JSON.stringify(value);
			return text === undefined ? "undefined" : text;
		} catch {
			return kind;
		}
	}
	if (seen.has(value)) return '"[Cycle]"';
	seen.add(value);
	if (value instanceof Date) {
		return JSON.stringify(
			Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString(),
		);
	}
	if (value instanceof RegExp) return JSON.stringify(value.toString());
	if (value instanceof Map) {
		const entries = [...value.entries()].map(
			([key, entry]) =>
				`[${canonicalJson(key, seen)},${canonicalJson(entry, seen)}]`,
		);
		return `[${entries.join(",")}]`;
	}
	if (value instanceof Set) {
		return `[${[...value].map((entry) => canonicalJson(entry, seen)).join(",")}]`;
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
	}
	// SAFETY: valueKind(value) is "object", so property enumeration is valid.
	// SAFETY: valueKind(value) is "object", so property enumeration is valid.
	const entries = Object.entries(value as object);
	return `{${entries
		.sort()
		.map(
			([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, seen)}`,
		)
		.join(",")}}`;
}

/**
 * Evaluate the promotion gate over a scored-run report, producing the
 * verdict Gatekeeper composes as its evals dimension: structurally the same
 * {ok, reasons: [{code, message}]} shape as the contracts package's
 * precomputed ResidencyGateVerdict / CanMigrateGateVerdict dimensions.
 */
export function evaluatePromotionGate(input: {
	rubricReport: RubricReport;
	thresholds?: PromotionGateThresholds;
}): PromotionGateVerdict {
	if (!input || valueKind(input) !== "object") {
		throw new PromotionGateParseError("promotion gate input is required");
	}
	const report = input.rubricReport;
	if (!report || report.schema !== EVALS_RUBRIC_REPORT_SCHEMA) {
		throw new PromotionGateParseError(
			"rubricReport must be the frozen report scoreRubric produces",
		);
	}
	const thresholds = input.thresholds ?? {};
	if (valueKind(thresholds) !== "object") {
		throw new PromotionGateParseError("thresholds must be an object");
	}
	let minWeightedTotal: number | undefined;
	if (thresholds.minWeightedTotal !== undefined) {
		minWeightedTotal = parseUnitInterval(
			thresholds.minWeightedTotal,
			"thresholds.minWeightedTotal",
			PromotionGateParseError,
		);
	}
	const requireRubricPass = thresholds.requireRubricPass !== false;

	const reasons: GateReason[] = [];
	if (requireRubricPass && !report.ok) {
		reasons.push({
			code: "evals.rubric-failed",
			message: `rubric "${report.rubricId}" report is not ok (weighted total ${report.weightedTotal}, pass threshold ${report.passThreshold})`,
		});
		for (const failure of report.failures) {
			reasons.push({
				code: `evals.${failure.code}`,
				message: failure.message,
			});
		}
	}
	if (
		minWeightedTotal !== undefined &&
		report.weightedTotal < minWeightedTotal
	) {
		reasons.push({
			code: "evals.total-below-threshold",
			message: `weighted total ${report.weightedTotal} is below the promotion floor ${minWeightedTotal}`,
		});
	}

	return deepFreeze({ ok: reasons.length === 0, reasons });
}

/**
 * Compile-time proof (and zero-cost upcast) that the evals verdict slots
 * into Gatekeeper's precomputed-dimension shape: assignability to the
 * contracts package's ResidencyGateVerdict is checked by tsc, so a caller
 * can hand the verdict straight to Gatekeeper composition.
 */
export function asGateDimension(
	verdict: PromotionGateVerdict,
): ResidencyGateVerdict {
	return verdict;
}

function parseUnitInterval<T>(
	value: T,
	label: string,
	ErrorClass: new (message: string) => TypeError,
): number {
	if (!isNumber(value) || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new ErrorClass(`${label} must be a finite number in [0,1]`);
	}
	return value;
}

function firstDiff<T extends EvaluationValue, U extends EvaluationValue>(
	expected: T,
	actual: U,
	path = "$",
	seen: WeakSet<object> = new WeakSet(),
): ValueDiff | null {
	if (Object.is(expected, actual)) {
		return null;
	}
	if (
		valueKind(expected) !== valueKind(actual) ||
		expected === null ||
		actual === null
	) {
		return { path, expected, actual };
	}
	if (Array.isArray(expected) || Array.isArray(actual)) {
		if (!Array.isArray(expected) || !Array.isArray(actual)) {
			return { path, expected, actual };
		}
		if (seen.has(expected) || seen.has(actual)) {
			return { path, expected: "[Cycle]", actual: "[Cycle]" };
		}
		seen.add(expected);
		seen.add(actual);
		const length = Math.max(expected.length, actual.length);
		for (let index = 0; index < length; index += 1) {
			if (index >= expected.length || index >= actual.length) {
				return {
					path: `${path}[${index}]`,
					expected: expected[index],
					actual: actual[index],
				};
			}
			const diff = firstDiff(
				expected[index],
				actual[index],
				`${path}[${index}]`,
				seen,
			);
			if (diff) {
				return diff;
			}
		}
		return null;
	}
	if (valueKind(expected) === "object") {
		// SAFETY: the object kind branch guarantees both values are objects here.
		const expectedObject = expected as object;
		// SAFETY: differing value kinds returned above; this branch makes actual an object too.
		const actualObject = actual as object;
		if (seen.has(expectedObject) || seen.has(actualObject)) {
			return { path, expected: "[Cycle]", actual: "[Cycle]" };
		}
		seen.add(expectedObject);
		if (actual && valueKind(actual) === "object") seen.add(actualObject);
		const expectedEntries = new Map(Object.entries(expectedObject));
		const actualEntries = new Map(Object.entries(actualObject));
		const keys = new Set([...expectedEntries.keys(), ...actualEntries.keys()]);
		for (const key of keys) {
			const diff = firstDiff(
				expectedEntries.get(key),
				actualEntries.get(key),
				joinPath(path, key),
				seen,
			);
			if (diff) {
				return diff;
			}
		}
		return null;
	}
	return { path, expected, actual };
}

function joinPath(path: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key)
		? `${path}.${key}`
		: `${path}[${JSON.stringify(key)}]`;
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
	if (value === null || valueKind(value) !== "object") return value;
	// SAFETY: valueKind(value) is "object", so the object operations are valid.
	const objectValue = value as object;
	if (seen.has(objectValue)) return value;
	seen.add(objectValue);
	if (!Object.isFrozen(objectValue)) {
		Object.freeze(objectValue);
		for (const entry of Object.values(objectValue)) {
			deepFreeze(entry, seen);
		}
	}
	return value;
}

export interface TrainableGoldenCase {
	readonly id: string;
	readonly expected: EvaluationValue;
	readonly actual?: EvaluationValue;
}

export interface TrainableGoldenRegion {
	readonly methodRef: string;
	readonly grounded: boolean;
	readonly cases: readonly TrainableGoldenCase[];
}

/**
 * Default golden suite for one trainable region: exact-match over
 * contract examples and recorded traces (ADR-0025). Not occupancy state.
 */
export function defineTrainableGoldenRubric(
	region: TrainableGoldenRegion,
): Rubric {
	if (
		valueKind(region.methodRef) !== "string" ||
		region.methodRef.length === 0
	) {
		throw new RubricParseError(
			"trainable region methodRef must be a non-empty string",
		);
	}
	const scored = region.cases.filter((row) => Object.hasOwn(row, "actual"));
	return defineRubric({
		id: `${GOLDEN_DEFAULT_SUITE_ID}:${region.methodRef}`,
		passThreshold: 1,
		criteria: [
			{
				id: "spec.examples",
				description:
					"trainable region has contract examples or traces to train against",
				weight: 1,
				kind: "boolean",
				required: true,
			},
			{
				id: "training.grounded",
				description:
					"trainable region has intent + shaped contract so the engine can rewrite it",
				weight: 1,
				kind: "boolean",
				required: true,
			},
			...scored.map((row) => ({
				id: row.id,
				description: `exact-match blessed output for ${row.id}`,
				weight: 1,
				kind: "golden-match" as const,
				expected: row.expected,
			})),
		],
	});
}

export function observeTrainableGolden(
	region: TrainableGoldenRegion,
): RubricObservationInput[] {
	const scored = region.cases.filter((row) => Object.hasOwn(row, "actual"));
	return [
		{ criterionId: "spec.examples", passed: region.cases.length > 0 },
		{ criterionId: "training.grounded", passed: region.grounded },
		...scored.map((row) => ({
			criterionId: row.id,
			actual: row.actual,
		})),
	];
}

export function scoreTrainableGoldenSuite(
	regions: readonly TrainableGoldenRegion[],
): TrainableSuiteScore {
	const reports = regions.map((region) =>
		scoreRubric(
			defineTrainableGoldenRubric(region),
			observeTrainableGolden(region),
		),
	);
	return {
		ok: reports.every((report) => report.ok),
		reports,
	};
}

export interface TrainableSilverEvidence {
	readonly methodRef: string;
	readonly grounded: boolean;
	readonly hasExamples: boolean;
	readonly deterministic: boolean;
	readonly failClosed: boolean;
	readonly noPollution: boolean;
	readonly seedHolds: boolean;
	readonly bounded: boolean;
}

export interface TrainableSuiteScore {
	readonly ok: boolean;
	readonly reports: readonly RubricReport[];
}

/**
 * Silver suite for one trainable region: property/fuzz oracles over the
 * same gold seeds. Exact-match stays on the gold suite.
 */
export function defineTrainableSilverRubric(
	evidence: TrainableSilverEvidence,
): Rubric {
	if (
		valueKind(evidence.methodRef) !== "string" ||
		evidence.methodRef.length === 0
	) {
		throw new RubricParseError(
			"trainable region methodRef must be a non-empty string",
		);
	}
	return defineRubric({
		id: `${SILVER_DEFAULT_SUITE_ID}:${evidence.methodRef}`,
		passThreshold: 1,
		criteria: [
			{
				id: "spec.examples",
				description:
					"silver fuzz has gold seeds (examples or traces) to mutate",
				weight: 1,
				kind: "boolean",
				required: true,
			},
			{
				id: "training.grounded",
				description: "trainable region is grounded so fuzz hits real code",
				weight: 1,
				kind: "boolean",
				required: true,
			},
			{
				id: "fuzz.seed-holds",
				description: "blessed gold seeds still hold under the trainable",
				weight: 1,
				kind: "boolean",
				required: true,
			},
			{
				id: "fuzz.deterministic",
				description: "same input produces the same output",
				weight: 1,
				kind: "boolean",
				required: true,
			},
			{
				id: "fuzz.no-pollution",
				description: "seeds and outputs have no prototype injection",
				weight: 1,
				kind: "boolean",
				required: true,
			},
			{
				id: "fuzz.fail-closed",
				description: "malformed input does not pollute or explode",
				weight: 1,
				kind: "boolean",
				required: true,
			},
			{
				id: "fuzz.bounded",
				description: "outputs stay under the silver size bound",
				weight: 1,
				kind: "boolean",
				required: true,
			},
		],
	});
}

export function observeTrainableSilver(
	evidence: TrainableSilverEvidence,
): RubricObservationInput[] {
	return [
		{ criterionId: "spec.examples", passed: evidence.hasExamples },
		{ criterionId: "training.grounded", passed: evidence.grounded },
		{ criterionId: "fuzz.seed-holds", passed: evidence.seedHolds },
		{ criterionId: "fuzz.deterministic", passed: evidence.deterministic },
		{ criterionId: "fuzz.no-pollution", passed: evidence.noPollution },
		{ criterionId: "fuzz.fail-closed", passed: evidence.failClosed },
		{ criterionId: "fuzz.bounded", passed: evidence.bounded },
	];
}

export function scoreTrainableSilverSuite(
	evidence: readonly TrainableSilverEvidence[],
): TrainableSuiteScore {
	const reports = evidence.map((row) =>
		scoreRubric(defineTrainableSilverRubric(row), observeTrainableSilver(row)),
	);
	return {
		ok: reports.every((report) => report.ok),
		reports,
	};
}

export function silverEvidenceFromRegion(
	region: TrainableGoldenRegion,
	fuzz?: {
		readonly deterministic: boolean;
		readonly failClosed: boolean;
		readonly noPollution: boolean;
		readonly seedHolds: boolean;
		readonly bounded: boolean;
	},
): TrainableSilverEvidence {
	const scored = region.cases.filter((row) => Object.hasOwn(row, "actual"));
	const corpusClean = region.cases.every(
		(row) => !isPolluted(row.expected) && !isPolluted(row.actual),
	);
	const matches = scored.every(
		(row) => canonicalJson(row.expected) === canonicalJson(row.actual),
	);
	const observed = fuzz !== undefined || scored.length === region.cases.length;
	const seedHolds =
		region.cases.length === 0
			? true
			: observed && matches && (fuzz?.seedHolds ?? true);
	return {
		methodRef: region.methodRef,
		grounded: region.grounded,
		hasExamples: region.cases.length > 0,
		deterministic: fuzz?.deterministic ?? true,
		failClosed: fuzz?.failClosed ?? true,
		noPollution: fuzz?.noPollution ?? corpusClean,
		seedHolds,
		bounded: fuzz?.bounded ?? true,
	};
}

export function scoreTrainableGoldSilverSuites(input: {
	readonly regions: readonly TrainableGoldenRegion[];
	readonly silver?: readonly TrainableSilverEvidence[];
}): TrainableGoldSilverScore {
	const gold = scoreTrainableGoldenSuite(input.regions);
	const silver = scoreTrainableSilverSuite(
		input.silver ??
			input.regions.map((region) => silverEvidenceFromRegion(region)),
	);
	return { ok: gold.ok && silver.ok, gold, silver };
}

export interface TrainableGoldSilverScore {
	readonly ok: boolean;
	readonly gold: TrainableSuiteScore;
	readonly silver: TrainableSuiteScore;
}

function isPolluted<T>(
	value: T,
	seen: WeakSet<object> = new WeakSet(),
): boolean {
	if (!value || valueKind(value) !== "object") return false;
	// SAFETY: the object kind branch guarantees value is an object here.
	const objectValue = value as object;
	if (seen.has(objectValue)) return false;
	seen.add(objectValue);
	if (
		Object.hasOwn(value, "__proto__") ||
		Object.hasOwn(value, "constructor")
	) {
		return true;
	}
	// SAFETY: valueKind(value) is "object", so Object.values accepts it.
	return Object.values(objectValue).some((entry) => isPolluted(entry, seen));
}
