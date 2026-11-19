import type { ResolvedDeploymentSet } from "@hobo/cloud";
import type { JsonObject, JsonValue } from "@hobo/core";
import {
	evaluateClause,
	type PostureFinding,
	type PostureFix,
	type PostureRule,
} from "@hobo/policy/posture";
import type { DeltaRecord, PostureFindingRecord } from "../_generated/cd_pb.js";
import {
	canonicalJson,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	jsonOf,
} from "./journal.js";

export type Ownership =
	| "conflict"
	| "drift"
	| "unowned"
	| "retained"
	| "no-fix"
	| "set-unavailable";

export type OwnershipVerdict = Readonly<{
	ownership: Ownership;
	conflicting: readonly string[];
}>;

const PLAN_FIELDS = [
	"provider",
	"port",
	"region",
	"strategy",
	"productId",
	"deploymentId",
] as const;
const PLAN_FIELD_SET: ReadonlySet<string> = new Set(PLAN_FIELDS);

function scalarText(value: JsonValue | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (isJsonString(value)) return value;
	if (isJsonNumber(value) || isJsonBoolean(value)) return String(value);
	return canonicalJson(value);
}

type PlanResource = ResolvedDeploymentSet["plan"]["resources"][number];
type Parameters = NonNullable<PlanResource["realizationParameters"]>;

export function setValue(
	resolved: ResolvedDeploymentSet,
	resource: string,
	field: string,
): string | undefined {
	const plan = jsonOf(resolved.plan.resources.find((r) => r.name === resource));
	if (!isJsonObject(plan)) return undefined;
	if (PLAN_FIELD_SET.has(field)) {
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
	target: JsonObject,
	path: readonly string[],
	value: string,
): JsonObject {
	const [head, ...rest] = path;
	if (head === undefined) return target;
	if (rest.length === 0) return { ...target, [head]: value };
	const child = target[head];
	const next: JsonObject = isJsonObject(child) ? child : {};
	return { ...target, [head]: setPath(next, rest, value) };
}

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
			let parameters: JsonObject = isJsonObject(current) ? current : {};
			for (const fix of fixes)
				parameters = setPath(parameters, fix.field.split("."), fix.value);
			return { ...r, realizationParameters: parameters as Parameters };
		}),
	};
}
