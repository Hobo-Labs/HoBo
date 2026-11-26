/**
 * The run-level sections of an ai-bdd RunReport v1 the release gate holds to
 * replay-only (ADR-0172): `options` (frozen, no agent, recordings not
 * rewritten) and `usage` (no model call and no token anywhere: the run, each
 * purpose, each scenario and each step). Each object is closed to its schema
 * key set.
 */
import { isJsonBoolean, isJsonNumber, type JsonObject } from "./json.js";
import { RUN_REPORT_KEYS } from "./report-keys.js";
import {
	closedKeys,
	countOf,
	fieldOf,
	objectOf,
	pathOf,
} from "./report-read.js";

const MODEL_PURPOSES = ["extract", "act", "checkgen", "judge"] as const;
const USAGE_FIELDS = ["modelCalls", "inputTokens", "outputTokens"] as const;

/** The run's own usage, against which a scenario's or a step's is held. */
export interface RunUsage {
	readonly modelCalls: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

function requireFlag(
	options: JsonObject,
	key: string,
	expected: boolean,
	why: string,
	issues: string[],
): void {
	const value = fieldOf(options, key);
	if (!isJsonBoolean(value)) {
		issues.push(`options.${key}: expected a boolean`);
	} else if (value !== expected) {
		issues.push(`options.${key} is ${String(value)}: ${why}`);
	}
}

export function readOptions(report: JsonObject, issues: string[]): void {
	const options = objectOf(report, "options", "", issues);
	closedKeys(options, "options", RUN_REPORT_KEYS.Options, issues);
	requireFlag(
		options,
		"frozen",
		true,
		"the run did not replay the committed plans as they are",
		issues,
	);
	requireFlag(
		options,
		"noAgent",
		true,
		"a step could have fallen back to the agent",
		issues,
	);
	requireFlag(
		options,
		"updateRecordings",
		false,
		"the run rewrote recordings instead of replaying them",
		issues,
	);
}

/** Calls and tokens of a Usage-shaped object; any token is refused (calls are refused by the caller, with its reason). */
function spentNothing(
	usage: JsonObject,
	path: string,
	issues: string[],
): RunUsage {
	const calls = countOf(usage, "modelCalls", path, issues);
	const input = countOf(usage, "inputTokens", path, issues);
	const output = countOf(usage, "outputTokens", path, issues);
	for (const [field, tokens] of [
		["inputTokens", input],
		["outputTokens", output],
	] as const) {
		if (tokens > 0) {
			issues.push(
				`${path}.${field} is ${tokens}: a replay-only run spends no tokens`,
			);
		}
	}
	return { modelCalls: calls, inputTokens: input, outputTokens: output };
}

/** `usage` and `usage.byPurpose`: zero model calls and zero tokens. */
export function readUsage(report: JsonObject, issues: string[]): RunUsage {
	const usage = objectOf(report, "usage", "", issues);
	closedKeys(usage, "usage", RUN_REPORT_KEYS.RunUsage, issues);
	const run = spentNothing(usage, "usage", issues);
	if (run.modelCalls > 0) {
		issues.push(
			`usage.modelCalls is ${run.modelCalls}: a replay-only run makes no model call`,
		);
	}
	const cost = fieldOf(usage, "estimatedCostUsd");
	if (cost !== undefined && !(isJsonNumber(cost) && cost === 0)) {
		issues.push(
			`usage.estimatedCostUsd is ${JSON.stringify(cost)}: a replay-only run costs nothing`,
		);
	}
	const byPurpose = objectOf(usage, "byPurpose", "usage", issues);
	closedKeys(byPurpose, "usage.byPurpose", RUN_REPORT_KEYS.ByPurpose, issues);
	for (const purpose of MODEL_PURPOSES) {
		const path = `usage.byPurpose.${purpose}`;
		const each = objectOf(byPurpose, purpose, "usage.byPurpose", issues);
		closedKeys(each, path, RUN_REPORT_KEYS.Usage, issues);
		const calls = spentNothing(each, path, issues).modelCalls;
		if (calls === 0) continue;
		issues.push(
			purpose === "judge"
				? `${path}.modelCalls is ${calls}: the judge was asked because the verdict cache (.ai-bdd/cache/) did not hold its verdict; a zero-model-call replay needs that cache present`
				: `${path}.modelCalls is ${calls}: a replay-only run makes no ${purpose} call`,
		);
	}
	return run;
}

/**
 * A scenario's or a step's `usage`, held to the run's: the run spent none
 * (or is refused for it), so any call or token here contradicts the report.
 */
export function readNestedUsage(
	owner: JsonObject,
	path: string,
	run: RunUsage,
	issues: string[],
): void {
	const at = pathOf(path, "usage");
	const usage = objectOf(owner, "usage", path, issues);
	closedKeys(usage, at, RUN_REPORT_KEYS.Usage, issues);
	for (const field of USAGE_FIELDS) {
		const spent = countOf(usage, field, at, issues);
		if (spent === 0) continue;
		issues.push(
			run[field] === 0
				? `${at}.${field} is ${spent}: a replay-only run spends none, and usage.${field} says so`
				: `${at}.${field} is ${spent}: a replay-only run spends none`,
		);
	}
}
