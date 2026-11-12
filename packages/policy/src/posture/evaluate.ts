// The pure posture evaluator (plan 0024 D25). Same rules and observation in,
// same findings out, in any input order. No clock, RNG, network or model:
// the Station-side posture service in @hobo/cd calls this; agents never do.
import type {
	PostureClause,
	PosturePack,
	PostureRule,
	RemediationMode,
} from "./rules.js";
import { compareSemver } from "./semver.js";

// public-contract: posture finding and compliance states.
export const POSTURE_STATES = Object.freeze([
	"compliant",
	"noncompliant",
	"unknown",
	"not-applicable",
] as const);
export type PostureState = (typeof POSTURE_STATES)[number];

/** One observed resource as the reconciler reports it: only declared observe_fields, secret-free. */
export type PostureResource = Readonly<{
	resource: string;
	kind: string;
	classification: string;
	attributes: Readonly<Record<string, string>>;
}>;

export type PostureObservation = Readonly<{
	resources: readonly PostureResource[];
}>;

export type ClauseOutcome = "pass" | "fail" | "unknown";

export type ClauseResult = Readonly<{
	field: string;
	op: PostureClause["op"];
	assertion: "require" | "forbid";
	outcome: ClauseOutcome;
}>;

export type PostureFinding = Readonly<{
	rule: string;
	pack: string;
	/** Empty for a rule no observed resource matched (state not-applicable). */
	resource: string;
	state: PostureState;
	severity: PostureRule["severity"];
	controls: readonly string[];
	/** Secret-free `field=value` summary of the attributes the rule read, at most 256 characters. */
	observed: string;
	clauses: readonly ClauseResult[];
}>;

export type PostureEvaluation = Readonly<{
	state: PostureState;
	/** (noncompliant + unknown) / applicable findings; 0 when nothing applies. Unknown counts against (fail closed). */
	noncompliantRatio: number;
	findings: readonly PostureFinding[];
}>;

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/u;
const OBSERVED_LIMIT = 256;

function numeric(value: string): number | undefined {
	if (!NUMBER.test(value)) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * One clause against a resource's attributes: true when the assertion holds,
 * false when it does not, undefined when it cannot be decided (the attribute
 * was not reported, or does not parse for the operator).
 */
export function evaluateClause(
	clause: PostureClause,
	attributes: Readonly<Record<string, string>>,
): boolean | undefined {
	const present = Object.hasOwn(attributes, clause.field);
	if (clause.op === "exists") return present;
	if (clause.op === "absent") return !present;
	if (!present) return undefined;
	const observed = attributes[clause.field] ?? "";
	switch (clause.op) {
		case "in":
			return clause.values.includes(observed);
		case "not-in":
			return !clause.values.includes(observed);
		case "eq":
			return observed === clause.value;
		case "neq":
			return observed !== clause.value;
		case "semver-gte": {
			const order = compareSemver(observed, clause.value);
			return order === undefined ? undefined : order >= 0;
		}
		case "lt":
		case "lte":
		case "gt":
		case "gte": {
			const left = numeric(observed);
			const right = numeric(clause.value);
			if (left === undefined || right === undefined) return undefined;
			if (clause.op === "lt") return left < right;
			if (clause.op === "lte") return left <= right;
			if (clause.op === "gt") return left > right;
			return left >= right;
		}
		default:
			return undefined;
	}
}

function matches(rule: PostureRule, resource: PostureResource): boolean {
	return (
		(rule.kinds.length === 0 || rule.kinds.includes(resource.kind)) &&
		(rule.classifications.length === 0 ||
			rule.classifications.includes(resource.classification))
	);
}

function summary(
	rule: PostureRule,
	attributes: Readonly<Record<string, string>>,
): string {
	const fields = [
		...new Set([...rule.require, ...rule.forbid].map((c) => c.field)),
	].sort();
	const text = fields
		.filter((field) => Object.hasOwn(attributes, field))
		.map((field) => `${field}=${attributes[field]}`)
		.join(",");
	return text.length <= OBSERVED_LIMIT
		? text
		: `${text.slice(0, OBSERVED_LIMIT - 1)}…`;
}

function judge(rule: PostureRule, resource: PostureResource): PostureFinding {
	const clauses: ClauseResult[] = [];
	for (const [assertion, list] of [
		["require", rule.require],
		["forbid", rule.forbid],
	] as const) {
		for (const clause of list) {
			const holds = evaluateClause(clause, resource.attributes);
			const outcome: ClauseOutcome =
				holds === undefined
					? "unknown"
					: holds === (assertion === "require")
						? "pass"
						: "fail";
			clauses.push({ field: clause.field, op: clause.op, assertion, outcome });
		}
	}
	const state: PostureState = clauses.some((c) => c.outcome === "fail")
		? "noncompliant"
		: clauses.some((c) => c.outcome === "unknown")
			? "unknown"
			: "compliant";
	return Object.freeze({
		rule: rule.id,
		pack: rule.pack,
		resource: resource.resource,
		state,
		severity: rule.severity,
		controls: rule.controls,
		observed: summary(rule, resource.attributes),
		clauses: Object.freeze(clauses),
	});
}

function byKey(a: PostureFinding, b: PostureFinding): number {
	const left = `${a.rule}\u0000${a.pack}\u0000${a.resource}`;
	const right = `${b.rule}\u0000${b.pack}\u0000${b.resource}`;
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Evaluate posture rules against one Camp observation: per-rule, per-resource findings plus a summary. */
export function evaluatePosture(
	rules: readonly PostureRule[],
	observation: PostureObservation,
): PostureEvaluation {
	const findings: PostureFinding[] = [];
	for (const rule of rules) {
		const matched = observation.resources.filter((resource) =>
			matches(rule, resource),
		);
		if (matched.length === 0) {
			findings.push(
				Object.freeze({
					rule: rule.id,
					pack: rule.pack,
					resource: "",
					state: "not-applicable" as const,
					severity: rule.severity,
					controls: rule.controls,
					observed: "",
					clauses: Object.freeze([]),
				}),
			);
			continue;
		}
		for (const resource of matched) findings.push(judge(rule, resource));
	}
	findings.sort(byKey);
	const applicable = findings.filter((f) => f.state !== "not-applicable");
	const failing = applicable.filter(
		(f) => f.state === "noncompliant" || f.state === "unknown",
	).length;
	const state: PostureState = applicable.some((f) => f.state === "noncompliant")
		? "noncompliant"
		: applicable.some((f) => f.state === "unknown")
			? "unknown"
			: applicable.length > 0
				? "compliant"
				: "not-applicable";
	return Object.freeze({
		state,
		noncompliantRatio:
			applicable.length === 0 ? 0 : failing / applicable.length,
		findings: Object.freeze(findings),
	});
}

const CONSERVATIVE: Readonly<Record<RemediationMode, number>> = {
	"inform-only": 2,
	inform: 1,
	enforce: 0,
};

/**
 * The remediation a rule actually gets. The Rail binding (the parent) is the
 * only source of `enforce`; a pack or rule pinned `inform-only` can never be
 * raised by it, and `warn` rules only ever inform.
 */
export function effectiveRemediation(
	input: Readonly<{
		binding: RemediationMode;
		pack: PosturePack;
		rule: PostureRule;
	}>,
): RemediationMode {
	if (
		input.binding === "inform-only" ||
		input.pack.remediation === "inform-only" ||
		input.rule.remediation === "inform-only"
	)
		return "inform-only";
	if (input.binding === "enforce" && input.rule.effect === "mutate")
		return "enforce";
	return "inform";
}

/** Merge a Rail's posture bindings: a pack bound more than once gets its most conservative mode. */
export function resolvePostureBindings(
	bindings: readonly Readonly<{ pack: string; remediation: RemediationMode }>[],
): ReadonlyMap<string, RemediationMode> {
	const out = new Map<string, RemediationMode>();
	for (const binding of bindings) {
		const prior = out.get(binding.pack);
		if (
			prior === undefined ||
			CONSERVATIVE[binding.remediation] > CONSERVATIVE[prior]
		)
			out.set(binding.pack, binding.remediation);
	}
	return out;
}
