import type { JsonObject, JsonValue } from "@hobo/core";
import {
	deepFreeze,
	requireNonEmptyString,
	requireRecord,
	SdkDeclarationError,
} from "./errors.js";
import { RUNBOOK_SCHEMA } from "./schema.js";

// domain-view: authored runbook trigger; wire form is RunbookTrigger in data-models/sdk.proto.
export interface RunbookTrigger {
	readonly alert: string;
	readonly severity?: string;
}

// domain-view: authored gated fix step; wire form is RunbookFixStep in data-models/sdk.proto.
export interface RunbookFixStep {
	readonly when: string;
	readonly do: string;
	readonly gate: "auto" | "require-approval";
	readonly args: JsonObject;
}

// domain-view: authored runbook; wire form is RunbookDeclaration in data-models/sdk.proto.
export interface RunbookDeclaration {
	readonly schema: string;
	readonly name: string;
	readonly on: RunbookTrigger;
	readonly diagnose: readonly string[];
	readonly fix: readonly RunbookFixStep[];
}

export interface RunbookFixSpec {
	when: string;
	do: string;
	gate?: "auto" | "require-approval";
	[argument: string]: JsonValue | undefined;
}

export interface RunbookSpec {
	on: { alert: string; severity?: string };
	diagnose: string[];
	fix: RunbookFixSpec[];
}

function parseArgument(
	value: JsonValue | undefined,
	path: string,
	ancestors: Set<object>,
): JsonValue {
	if (value === null || value === true || value === false) return value;
	const tag = Object.prototype.toString.call(value);
	if (tag === "[object String]") return String(value);
	if (tag === "[object Number]" && Number.isFinite(value)) return Number(value);
	if (
		value !== undefined &&
		(Array.isArray(value) || tag === "[object Object]")
	) {
		const container = value as JsonValue[] | JsonObject;
		if (ancestors.has(container))
			throw new SdkDeclarationError("runbook", path, "must be acyclic JSON");
		ancestors.add(container);
		try {
			if (Array.isArray(container))
				return Array.from(container, (item, index) =>
					parseArgument(item, `${path}[${index}]`, ancestors),
				);
			if (
				Object.getPrototypeOf(container) !== Object.prototype &&
				Object.getPrototypeOf(container) !== null
			)
				throw new SdkDeclarationError(
					"runbook",
					path,
					"must contain plain JSON objects",
				);
			return Object.fromEntries(
				Object.entries(container).map(([key, item]) => [
					key,
					parseArgument(item, `${path}.${key}`, ancestors),
				]),
			);
		} finally {
			ancestors.delete(container);
		}
	}
	throw new SdkDeclarationError(
		"runbook",
		path,
		"must contain JSON values, without undefined, functions, or non-finite numbers",
	);
}

function parseFixStep(step: RunbookFixSpec, index: number): RunbookFixStep {
	requireRecord("runbook", `fix[${index}]`, step);
	const record = step;
	const when = requireNonEmptyString(
		"runbook",
		`fix[${index}].when`,
		record.when,
	);
	const verb = requireNonEmptyString("runbook", `fix[${index}].do`, record.do);
	const gate = record.gate ?? "require-approval";
	if (gate !== "auto" && gate !== "require-approval") {
		throw new SdkDeclarationError(
			"runbook",
			`fix[${index}].gate`,
			'must be "auto" or "require-approval"',
		);
	}
	const args: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === "when" || key === "do" || key === "gate") continue;
		args[key] = parseArgument(value, `fix[${index}].${key}`, new Set());
	}
	return { when, do: verb, gate, args };
}

export function runbook(name: string, spec: RunbookSpec): RunbookDeclaration {
	requireNonEmptyString("runbook", "name", name);
	const record = requireRecord("runbook", "spec", spec);
	const trigger = requireRecord("runbook", "on", record.on);
	const alert = requireNonEmptyString("runbook", "on.alert", trigger.alert);
	const severity =
		trigger.severity === undefined
			? undefined
			: requireNonEmptyString("runbook", "on.severity", trigger.severity);
	if (!Array.isArray(record.diagnose) || record.diagnose.length === 0) {
		throw new SdkDeclarationError(
			"runbook",
			"diagnose",
			"must be a non-empty array of read-only diagnosis queries",
		);
	}
	const diagnose = record.diagnose.map((query, index) =>
		requireNonEmptyString("runbook", `diagnose[${index}]`, query),
	);
	if (!Array.isArray(record.fix) || record.fix.length === 0) {
		throw new SdkDeclarationError(
			"runbook",
			"fix",
			"must be a non-empty array of gated fix steps",
		);
	}
	const fix = record.fix.map((step, index) => parseFixStep(step, index));

	const on: RunbookSpec["on"] = { alert };
	if (severity !== undefined) on.severity = severity;
	return deepFreeze({
		schema: RUNBOOK_SCHEMA,
		name,
		on,
		diagnose,
		fix,
	});
}
