/**
 * The key set of every RunReport v1 object the parser walks. Version 1 of the
 * schema closes every object (`additionalProperties: false`), so a key that is
 * not `allowed` makes the report invalid, and so does a `required` key that is
 * absent, whether or not the gate interprets it. Copied from the schema;
 * test/acceptance-fields.test.ts compares each set with the copy of the schema
 * in test/fixtures/ai-bdd/.
 */
export interface ReportObjectKeys {
	readonly name: string;
	readonly allowed: readonly string[];
	readonly required: readonly string[];
}

const USAGE_FIELDS = ["modelCalls", "inputTokens", "outputTokens"] as const;
const STATUSES = [
	"passed",
	"failed",
	"healed",
	"blocked",
	"skipped",
	"inconclusive",
	"error",
] as const;
const RUN_REPORT_FIELDS = [
	"schemaVersion",
	"runId",
	"startedAt",
	"finishedAt",
	"options",
	"scenarios",
	"totals",
	"usage",
	"coverage",
	"warnings",
	"exitCode",
] as const;
const OPTIONS = [
	"frozen",
	"strict",
	"audit",
	"noAgent",
	"updateRecordings",
	"recordingsMode",
	"workers",
] as const;
const PURPOSES = ["extract", "act", "checkgen", "judge"] as const;
const SCENARIO_REQUIRED = [
	"scenarioId",
	"featureId",
	"docUri",
	"title",
	"driver",
	"status",
	"mode",
	"review",
	"steps",
	"recording",
	"usage",
	"durationMs",
] as const;
const STEP_REQUIRED = [
	"stepKey",
	"kind",
	"text",
	"status",
	"path",
	"determinism",
	"fuzzyReasons",
	"actions",
	"usage",
	"durationMs",
	"evidence",
	"sources",
] as const;

export const RUN_REPORT_KEYS = {
	RunReport: {
		name: "RunReport",
		allowed: RUN_REPORT_FIELDS,
		required: RUN_REPORT_FIELDS,
	},
	Options: { name: "Options", allowed: OPTIONS, required: OPTIONS },
	RunUsage: {
		name: "RunUsage",
		allowed: [...USAGE_FIELDS, "byPurpose", "estimatedCostUsd"],
		required: [...USAGE_FIELDS, "byPurpose"],
	},
	ByPurpose: { name: "ByPurpose", allowed: PURPOSES, required: PURPOSES },
	Usage: { name: "Usage", allowed: USAGE_FIELDS, required: USAGE_FIELDS },
	ScenarioResult: {
		name: "ScenarioResult",
		allowed: [...SCENARIO_REQUIRED, "confirm", "error"],
		required: SCENARIO_REQUIRED,
	},
	StepResult: {
		name: "StepResult",
		allowed: [...STEP_REQUIRED, "error", "check", "judge"],
		required: STEP_REQUIRED,
	},
	Totals: { name: "Totals", allowed: STATUSES, required: STATUSES },
} as const satisfies Readonly<Record<string, ReportObjectKeys>>;
