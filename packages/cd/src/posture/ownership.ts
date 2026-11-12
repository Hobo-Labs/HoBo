// Ownership checks for posture enforcement (plan 0024 D25, I22). Posture
// never fights delivery: before a noncompliant finding is remediated, the
// fields its rule reads and sets are compared with what the Camp's current
// Set declares.
//
//   conflict   the Set declares a value the rule rejects, or the fix would
//              overwrite a Set-owned value: `ownership-conflict`, nothing
//              mutates, and the gate refuses Deltas that keep it;
//   drift      the Set declares a compliant value but the target differs:
//              the reconciler re-applies the Set (drift), posture does not;
//   unowned    no failing field or fix field is Set-owned: a gated
//              `posture-remediate` Delta sets the fix values;
//   retained   a fix field is owned by a controller on the target side;
//   no-fix     the rule declares no fix (it can only inform);
//   set-unavailable  the current Set could not be read (fail closed).
//
// Pure: no clock, no I/O.
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import type { JsonValue } from "@hobo/core";
import {
	evaluateClause,
	type PostureFinding,
	type PostureFix,
	type PostureRule,
} from "@hobo/policy/posture";
import type { DeltaRecord, PostureFindingRecord } from "../_generated/cd_pb.js";
import { canonicalJson, isJsonObject, jsonOf } from "./journal.js";

export type Ownership =
	| "conflict"
	| "drift"
	| "unowned"
	| "retained"
	| "no-fix"
	| "set-unavailable";

export type OwnershipVerdict = Readonly<{
	ownership: Ownership;
	/** Clause or fix fields whose Set-declared value the rule contradicts. */
	conflicting: readonly string[];
}>;

/** Plan fields a posture rule may name directly; everything else is a realization parameter path. */
const PLAN_FIELDS = [
	"provider",
	"port",
	"region",
	"strategy",
	"productId",
	"deploymentId",
] as const;

function scalarText(value: JsonValue | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return canonicalJson(value);
}

type PlanResource = ResolvedDeploymentSet["plan"]["resources"][number];
type Parameters = NonNullable<PlanResource["realizationParameters"]>;

/** The value a Set declares for `resource.field`, as the string a reconciler would report; undefined when unowned. */
export function setValue(
	resolved: ResolvedDeploymentSet,
	resource: string,
	field: string,
): string | undefined {
	const plan = jsonOf(resolved.plan.resources.find((r) => r.name === resource));
	if (!isJsonObject(plan)) return undefined;
	if ((PLAN_FIELDS as readonly string[]).includes(field)) {
		const value = scalarText(plan[field]);
		return value === "" ? undefined : value;
	}
	let cursor: JsonValue | undefined = plan.realizationParameters;
	for (const segment of field.split(".")) {
		if (!isJsonObject(cursor)) return undefined;
		cursor = cursor[segment];
	}
	return scalarText(cursor);
}

/** Classify one noncompliant finding against the Camp's current Set. */
export function classifyOwnership(
	input: Readonly<{
		rule: PostureRule;
		finding: PostureFinding;
		resolved: ResolvedDeploymentSet | undefined;
		retained: readonly string[];
	}>,
): OwnershipVerdict {
	const { rule, finding, resolved } = input;
	if (!resolved) return { ownership: "set-unavailable", conflicting: [] };
	const declared: Record<string, string> = {};
	const fields = new Set([...rule.require, ...rule.forbid].map((c) => c.field));
	for (const fix of rule.fix) fields.add(fix.field);
	for (const field of fields) {
		const value = setValue(resolved, finding.resource, field);
		if (value !== undefined) declared[field] = value;
	}
	const conflicting = new Set<string>();
	for (const clause of rule.require) {
		if (
			Object.hasOwn(declared, clause.field) &&
			evaluateClause(clause, declared) === false
		)
			conflicting.add(clause.field);
	}
	for (const clause of rule.forbid) {
		if (
			Object.hasOwn(declared, clause.field) &&
			evaluateClause(clause, declared) === true
		)
			conflicting.add(clause.field);
	}
	const failing = finding.clauses
		.filter((c) => c.outcome !== "pass")
		.map((c) => c.field);
	const ownedFailing = failing.some((field) => Object.hasOwn(declared, field));
	// A fix that would overwrite a Set-owned value fights the Set even when that value looks compliant.
	for (const fix of rule.fix) {
		if (
			Object.hasOwn(declared, fix.field) &&
			declared[fix.field] !== fix.value &&
			!ownedFailing
		)
			conflicting.add(fix.field);
	}
	if (conflicting.size > 0)
		return { ownership: "conflict", conflicting: [...conflicting].sort() };
	if (ownedFailing) return { ownership: "drift", conflicting: [] };
	if (rule.fix.length === 0) return { ownership: "no-fix", conflicting: [] };
	if (rule.fix.some((fix) => input.retained.includes(fix.field)))
		return { ownership: "retained", conflicting: [] };
	return { ownership: "unowned", conflicting: [] };
}

/**
 * The open ownership conflicts a Delta keeps: the resource stays in the
 * resolved Set and the Delta does not change it (I22). The gate refuses such a
 * Delta until the declaration changes.
 */
export function keptConflicts(
	input: Readonly<{
		conflicts: readonly PostureFindingRecord[];
		delta: DeltaRecord;
		resolved: ResolvedDeploymentSet;
	}>,
): readonly PostureFindingRecord[] {
	const present = new Set(input.resolved.plan.resources.map((r) => r.name));
	const changed = new Set(input.delta.changes.map((c) => c.resource));
	return input.conflicts.filter(
		(f) =>
			f.ownershipConflict &&
			present.has(f.resource) &&
			!changed.has(f.resource),
	);
}

function setPath(
	target: Record<string, JsonValue>,
	path: readonly string[],
	value: string,
): Record<string, JsonValue> {
	const [head, ...rest] = path;
	if (head === undefined) return target;
	if (rest.length === 0) return { ...target, [head]: value };
	const child = target[head];
	const next: Record<string, JsonValue> = isJsonObject(child)
		? Object.fromEntries(Object.entries(child))
		: {};
	return { ...target, [head]: setPath(next, rest, value) };
}

/**
 * The resolved plan a `posture-remediate` Delta proposes: the fix values
 * written into the resource's realization parameters. Used by the planning
 * adapter that resolves the Delta; posture itself never applies it.
 */
export function applyPostureFixes(
	resolved: ResolvedDeploymentSet,
	resource: string,
	fixes: readonly PostureFix[],
): ResolvedDeploymentSet["plan"] {
	return {
		...resolved.plan,
		resources: resolved.plan.resources.map((r) => {
			if (r.name !== resource) return r;
			const current = jsonOf(r.realizationParameters);
			let parameters: Record<string, JsonValue> = isJsonObject(current)
				? Object.fromEntries(Object.entries(current))
				: {};
			for (const fix of fixes)
				parameters = setPath(parameters, fix.field.split("."), fix.value);
			// SAFETY: a JSON object built from JSON scalars and objects is a plan realization-parameter object.
			return { ...r, realizationParameters: parameters as Parameters };
		}),
	};
}
