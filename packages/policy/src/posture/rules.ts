// Observe-phase posture rules (plan 0024 D25): a policy-IR rule profile. A
// pack is a JSON document (`hobo.policy-ir/v1`, profile `hobo.posture/v1`)
// of rules that match observed resources by kind and classification and
// assert `require`/`forbid` clauses over declared attributes with a fixed
// operator set. There is no expression language. `parsePosturePack` is the
// one boundary: everything downstream works on the frozen, typed pack.
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "../json.js";
import { POLICY_IR_SCHEMA_VERSION } from "../policy-ir.js";
import { parseSemver } from "./semver.js";

// public-contract: the policy-IR profile id of a posture rule pack.
export const POSTURE_PROFILE = "hobo.posture/v1";

// public-contract: the fixed posture operator set (D25). Never extended by data.
export const POSTURE_OPERATORS = Object.freeze([
	"eq",
	"neq",
	"in",
	"not-in",
	"exists",
	"absent",
	"lt",
	"lte",
	"gt",
	"gte",
	"semver-gte",
] as const);

// public-contract: posture finding severities.
export const POSTURE_SEVERITIES = Object.freeze([
	"info",
	"low",
	"medium",
	"high",
	"critical",
] as const);

// public-contract: remediation modes of a Rail posture binding (D25).
export const REMEDIATION_MODES = Object.freeze([
	"inform",
	"inform-only",
	"enforce",
] as const);

// public-contract: policy-IR effects a posture rule may carry: `warn` informs, `mutate` is repairable.
export const POSTURE_EFFECTS = Object.freeze(["warn", "mutate"] as const);

export type PostureOperator = (typeof POSTURE_OPERATORS)[number];
export type PostureSeverity = (typeof POSTURE_SEVERITIES)[number];
export type RemediationMode = (typeof REMEDIATION_MODES)[number];
export type PostureEffect = (typeof POSTURE_EFFECTS)[number];

export type PostureClause =
	| Readonly<{ field: string; op: "exists" | "absent" }>
	| Readonly<{ field: string; op: "in" | "not-in"; values: readonly string[] }>
	| Readonly<{
			field: string;
			op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "semver-gte";
			value: string;
	  }>;

/** A literal value a repair Delta sets; only `mutate` rules carry fixes. */
export type PostureFix = Readonly<{ field: string; value: string }>;

export type PostureRule = Readonly<{
	id: string;
	pack: string;
	phase: "observe";
	effect: PostureEffect;
	kinds: readonly string[];
	classifications: readonly string[];
	require: readonly PostureClause[];
	forbid: readonly PostureClause[];
	severity: PostureSeverity;
	controls: readonly string[];
	/** Only `inform-only` may be pinned by a pack or rule; enforcement comes from the Rail binding alone. */
	remediation?: "inform-only";
	fix: readonly PostureFix[];
}>;

export type PosturePack = Readonly<{
	schemaVersion: typeof POLICY_IR_SCHEMA_VERSION;
	profile: typeof POSTURE_PROFILE;
	pack: string;
	remediation?: "inform-only";
	/** Attribute paths reconcilers must report for this pack (and only these). */
	observeFields: readonly string[];
	rules: readonly PostureRule[];
}>;

/** A typed refusal at the pack boundary: what failed, where, and how to fix it. */
export class PosturePackError extends Error {
	readonly code: string;
	readonly path: string;
	readonly remediation: string;

	constructor(
		code: string,
		message: string,
		path: string,
		remediation: string,
	) {
		super(`${code} at ${path}: ${message}`);
		this.name = "PosturePackError";
		this.code = code;
		this.path = path;
		this.remediation = remediation;
	}
}

const ID = /^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$/u;
const FIELD = /^[A-Za-z0-9_]([A-Za-z0-9_./-]{0,126}[A-Za-z0-9_])?$/u;
const TOKEN = /^[A-Za-z0-9]([A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$/u;
const CONTROL = /^[A-Za-z][A-Za-z0-9]*([.-][A-Za-z0-9]+)*$/u;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/u;
const MAX_RULES = 512;
const MAX_CLAUSES = 32;
const MAX_VALUE = 1024;

const OPERATOR_SET: ReadonlySet<string> = new Set(POSTURE_OPERATORS);
const SEVERITY_SET: ReadonlySet<string> = new Set(POSTURE_SEVERITIES);
const EFFECT_SET: ReadonlySet<string> = new Set(POSTURE_EFFECTS);

const FIX_DOC =
	"See packages/policy/src/posture/README.md for the rule profile.";

function fail(
	code: string,
	message: string,
	path: string,
	remediation = FIX_DOC,
): never {
	throw new PosturePackError(code, message, path, remediation);
}

function object<T>(value: T, path: string) {
	if (!isJsonObject(value))
		fail("posture-expected-object", "expected a JSON object", path);
	return value;
}

function text<T>(value: T, path: string, pattern?: RegExp): string {
	if (!isJsonString(value) || value === "")
		fail("posture-expected-string", "expected a non-empty string", path);
	if (pattern && !pattern.test(value))
		fail(
			"posture-string-invalid",
			`${JSON.stringify(value)} does not match ${pattern.source}`,
			path,
		);
	return value;
}

function list<T>(value: T, path: string): readonly unknown[] {
	if (value === undefined) return [];
	if (!isJsonArray(value))
		fail("posture-expected-array", "expected an array", path);
	return value;
}

/** A scalar operand canonicalised to its string form (attributes are strings on the wire). */
function scalar<T>(value: T, path: string): string {
	let out: string;
	if (isJsonString(value)) out = value;
	else if (isJsonNumber(value) && Number.isFinite(value)) out = String(value);
	else if (isJsonBoolean(value)) out = value ? "true" : "false";
	else
		fail(
			"posture-value-invalid",
			"expected a string, finite number or boolean",
			path,
		);
	if (out.length > MAX_VALUE)
		fail("posture-value-too-long", `longer than ${MAX_VALUE} characters`, path);
	return out;
}

function sortedUnique(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values)].sort());
}

function parseClause<T>(
	input: T,
	path: string,
	declared: ReadonlySet<string>,
): PostureClause {
	const source = object(input, path);
	const field = text(source.field, `${path}.field`, FIELD);
	if (!declared.has(field))
		fail(
			"posture-field-undeclared",
			`${field} is not in the pack's observeFields`,
			`${path}.field`,
			"Add the field to observeFields so reconcilers report it, or drop the clause.",
		);
	const op = text(source.op, `${path}.op`);
	if (!OPERATOR_SET.has(op))
		fail(
			"posture-operator-unknown",
			`${op} is not one of ${POSTURE_OPERATORS.join(", ")}`,
			`${path}.op`,
			"Use one operator from the fixed set; there is no expression language.",
		);
	if (op === "exists" || op === "absent") {
		if (source.value !== undefined || source.values !== undefined)
			fail("posture-value-unexpected", `${op} takes no operand`, path);
		return Object.freeze({ field, op });
	}
	if (op === "in" || op === "not-in") {
		const values = list(source.values, `${path}.values`).map((v, i) =>
			scalar(v, `${path}.values[${i}]`),
		);
		if (values.length === 0)
			fail(
				"posture-values-missing",
				`${op} needs a non-empty values list`,
				`${path}.values`,
			);
		return Object.freeze({ field, op, values: sortedUnique(values) });
	}
	if (source.value === undefined)
		fail("posture-value-missing", `${op} needs a value`, `${path}.value`);
	const value = scalar(source.value, `${path}.value`);
	if (
		(op === "lt" || op === "lte" || op === "gt" || op === "gte") &&
		!NUMBER.test(value)
	)
		fail(
			"posture-value-not-numeric",
			`${op} needs a decimal number`,
			`${path}.value`,
		);
	if (op === "semver-gte" && parseSemver(value) === undefined)
		fail(
			"posture-value-not-semver",
			"semver-gte needs a semantic version",
			`${path}.value`,
		);
	// SAFETY: op was checked against the operator set and every other branch returned above.
	return Object.freeze({ field, op: op as "eq", value });
}

function parsePin<T>(value: T, path: string): "inform-only" | undefined {
	if (value === undefined) return undefined;
	if (value !== "inform-only")
		fail(
			"posture-remediation-invalid",
			"a pack or rule may only pin remediation to inform-only",
			path,
			"Enforcement comes from the Rail's delivery.posture binding; remove the field or set inform-only.",
		);
	return "inform-only";
}

function parseRule<T>(
	input: T,
	path: string,
	pack: string,
	declared: ReadonlySet<string>,
): PostureRule {
	const source = object(input, path);
	const id = text(source.id, `${path}.id`, ID);
	if (source.phase !== "observe")
		fail(
			"posture-phase-invalid",
			"posture rules live in the policy-IR observe phase",
			`${path}.phase`,
			"Set phase to observe.",
		);
	const effect = text(source.effect, `${path}.effect`);
	if (!EFFECT_SET.has(effect))
		fail(
			"posture-effect-invalid",
			"effect must be warn or mutate",
			`${path}.effect`,
		);
	const match =
		source.match === undefined ? {} : object(source.match, `${path}.match`);
	const kinds = sortedUnique(
		list(match.kinds, `${path}.match.kinds`).map((k, i) =>
			text(k, `${path}.match.kinds[${i}]`, TOKEN),
		),
	);
	const classifications = sortedUnique(
		list(match.classifications, `${path}.match.classifications`).map((c, i) =>
			text(c, `${path}.match.classifications[${i}]`, TOKEN),
		),
	);
	const require = list(source.require, `${path}.require`).map((c, i) =>
		parseClause(c, `${path}.require[${i}]`, declared),
	);
	const forbid = list(source.forbid, `${path}.forbid`).map((c, i) =>
		parseClause(c, `${path}.forbid[${i}]`, declared),
	);
	if (require.length + forbid.length === 0)
		fail(
			"posture-clauses-missing",
			"a rule needs at least one require or forbid clause",
			path,
		);
	if (require.length + forbid.length > MAX_CLAUSES)
		fail("posture-clauses-too-many", `at most ${MAX_CLAUSES} clauses`, path);
	const severity = text(source.severity, `${path}.severity`);
	if (!SEVERITY_SET.has(severity))
		fail(
			"posture-severity-invalid",
			`severity must be one of ${POSTURE_SEVERITIES.join(", ")}`,
			`${path}.severity`,
		);
	const controls = sortedUnique(
		list(source.controls, `${path}.controls`).map((c, i) =>
			text(c, `${path}.controls[${i}]`, CONTROL),
		),
	);
	const fix = list(source.fix, `${path}.fix`).map((f, i) => {
		const entry = object(f, `${path}.fix[${i}]`);
		const field = text(entry.field, `${path}.fix[${i}].field`, FIELD);
		if (!declared.has(field))
			fail(
				"posture-field-undeclared",
				`${field} is not in observeFields`,
				`${path}.fix[${i}].field`,
			);
		return Object.freeze({
			field,
			value: scalar(entry.value, `${path}.fix[${i}].value`),
		});
	});
	if (effect === "mutate" && fix.length === 0)
		fail(
			"posture-fix-missing",
			"a mutate rule needs literal fix values",
			`${path}.fix`,
			"Declare fix entries, or make the rule effect warn.",
		);
	if (effect === "warn" && fix.length > 0)
		fail(
			"posture-fix-unexpected",
			"only mutate rules carry fixes",
			`${path}.fix`,
		);
	const remediation = parsePin(source.remediation, `${path}.remediation`);
	return Object.freeze({
		id,
		pack,
		phase: "observe" as const,
		// SAFETY: checked against POSTURE_EFFECTS above.
		effect: effect as PostureEffect,
		kinds,
		classifications,
		require: Object.freeze(require),
		forbid: Object.freeze(forbid),
		// SAFETY: checked against POSTURE_SEVERITIES above.
		severity: severity as PostureSeverity,
		controls,
		...(remediation ? { remediation } : {}),
		fix: Object.freeze(
			[...fix].sort((a, b) =>
				a.field < b.field ? -1 : a.field > b.field ? 1 : 0,
			),
		),
	});
}

/** Parse one posture pack document (a policy-IR observe-phase rule profile). Throws `PosturePackError`. */
export function parsePosturePack<T>(input: T): PosturePack {
	const source = object(input, "$");
	if (source.schemaVersion !== POLICY_IR_SCHEMA_VERSION)
		fail(
			"posture-schema-version",
			`expected ${POLICY_IR_SCHEMA_VERSION}`,
			"$.schemaVersion",
		);
	if (source.profile !== POSTURE_PROFILE)
		fail("posture-profile", `expected profile ${POSTURE_PROFILE}`, "$.profile");
	const pack = text(source.pack, "$.pack", ID);
	const observeFieldsList = list(source.observeFields, "$.observeFields").map(
		(f, i) => text(f, `$.observeFields[${i}]`, FIELD),
	);
	const declared = new Set(observeFieldsList);
	const rawRules = list(source.rules, "$.rules");
	if (rawRules.length > MAX_RULES)
		fail("posture-rules-too-many", `at most ${MAX_RULES} rules`, "$.rules");
	const rules = rawRules.map((r, i) =>
		parseRule(r, `$.rules[${i}]`, pack, declared),
	);
	const ids = new Set<string>();
	for (const rule of rules) {
		if (ids.has(rule.id))
			fail(
				"posture-rule-duplicate",
				`rule ${rule.id} is declared twice`,
				"$.rules",
			);
		ids.add(rule.id);
	}
	const remediation = parsePin(source.remediation, "$.remediation");
	return Object.freeze({
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		profile: POSTURE_PROFILE,
		pack,
		...(remediation ? { remediation } : {}),
		observeFields: sortedUnique(observeFieldsList),
		rules: Object.freeze(
			[...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
		),
	});
}

/** The attribute paths reconcilers must report for these packs: the sorted union of their `observeFields`. */
export function observeFields(
	packs: readonly PosturePack[],
): readonly string[] {
	return sortedUnique(packs.flatMap((pack) => pack.observeFields));
}
