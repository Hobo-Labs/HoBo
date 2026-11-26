/**
 * The release gate's reading of an ai-bdd run report (ADR-0172).
 *
 * `ai-bdd run` writes `.ai-bdd/report/report.json`, a `RunReport` of
 * `schemaVersion` 1 (its JSON Schema ships with `@ai-bdd/sdk`; a copy lives in
 * `test/fixtures/ai-bdd/`). HoBo is a process-boundary consumer: it imports no
 * ai-bdd code, so this module is the one parser boundary that report crosses.
 * Parse, don't validate: the bytes become a frozen `AcceptanceEvidence`, the
 * derived type every later step takes, or an `AcceptanceReportError` that
 * names every reason the report cannot stand as replay-only evidence.
 *
 * Which fields of the schema are read and which are deliberately ignored is
 * declared in `acceptance-fields.ts`, and a test holds this parser to it.
 */
import { createHash } from "node:crypto";

import {
	duplicateKeyIn,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonText,
} from "./json.js";
import { RUN_REPORT_KEYS } from "./report-keys.js";
import {
	arrayOf,
	closedKeys,
	countOf,
	durationOf,
	fieldOf,
	memberOf,
	objectOf,
} from "./report-read.js";
import {
	type RunUsage,
	readNestedUsage,
	readOptions,
	readUsage,
} from "./report-run.js";

const SCENARIO_STATUSES = [
	"passed",
	"failed",
	"healed",
	"blocked",
	"skipped",
	"inconclusive",
	"error",
] as const;
type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

const DETERMINISM = ["deterministic", "fuzzy", "n/a"] as const;
const EXIT_CODES = [0, 1, 2, 3, 4] as const;

/**
 * One path segment: the run id names the directory `.ai-bdd/runs/<runId>/`
 * that `verify-run` is pointed at, so a separator or a leading dot is refused.
 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Exit codes of `ai-bdd run`: 0 passed, 1 a scenario failed, inconclusive or blocked, 2 usage or config, 3 infrastructure, 4 frozen violation. */
export type AiBddExitCode = (typeof EXIT_CODES)[number];

declare const runIdBrand: unique symbol;
/** A run id that is exactly one directory name under `.ai-bdd/runs/`. */
export type AiBddRunId = string & { readonly [runIdBrand]: true };

declare const digestBrand: unique symbol;
/** `sha256:` plus the 64 lowercase hex digits of the exact report bytes read. */
export type ReportDigest = string & { readonly [digestBrand]: true };

// domain-view: frozen parse result of a RunReport v1 that stands as replay-only evidence; data-models/acceptance_evidence.proto + .cue is its schema of record.
// Nothing serializes this type as such: in a stage-gate record it travels as the acceptance-replay check's flat string evidence (run_id, report_digest, scenarios_*, report_*), which stage_gate_record.cue constrains.
export interface AcceptanceEvidence {
	readonly runId: AiBddRunId;
	readonly reportDigest: ReportDigest;
	/** ISO 8601, as the report states it: when ai-bdd says the run began. */
	readonly startedAt: string;
	readonly scenariosTotal: number;
	readonly passed: number;
	readonly healed: number;
	readonly failed: number;
	readonly inconclusive: number;
	readonly blocked: number;
	readonly error: number;
	readonly skipped: number;
	readonly fuzzySteps: number;
	readonly modelCalls: 0;
	readonly frozen: true;
	readonly noAgent: true;
	readonly exitCode: AiBddExitCode;
}

export class AcceptanceReportError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`ai-bdd run report refused: ${issues.join("; ")}`);
		this.name = "AcceptanceReportError";
		this.issues = issues;
	}
}

export function reportDigestOf(bytes: Uint8Array): ReportDigest {
	const hex = createHash("sha256").update(bytes).digest("hex");
	// SAFETY: a sha256 hex digest is 64 lowercase hex digits, the whole ReportDigest invariant.
	return `sha256:${hex}` as ReportDigest;
}

/** Scenarios per status, as `totals` states them and the scenarios confirm. */
export interface ScenarioTotals {
	readonly passed: number;
	readonly failed: number;
	readonly healed: number;
	readonly blocked: number;
	readonly skipped: number;
	readonly inconclusive: number;
	readonly error: number;
}

interface ScenarioTally {
	readonly run: RunUsage;
	readonly byStatus: Map<ScenarioStatus, number>;
	scenarios: number;
	fuzzySteps: number;
}

function tallyStep(
	step: JsonValue,
	path: string,
	tally: ScenarioTally,
	issues: string[],
): void {
	if (!isJsonObject(step)) {
		issues.push(`${path}: expected an object`);
		return;
	}
	closedKeys(step, path, RUN_REPORT_KEYS.StepResult, issues);
	durationOf(step, path, issues);
	readNestedUsage(step, path, tally.run, issues);
	const determinism = memberOf(DETERMINISM, fieldOf(step, "determinism"));
	if (determinism === undefined) {
		issues.push(`${path}.determinism: expected deterministic|fuzzy|n/a`);
	}
	const reasons = arrayOf(step, "fuzzyReasons", path, issues);
	if (!reasons.every((reason) => isJsonString(reason))) {
		issues.push(`${path}.fuzzyReasons: expected strings`);
	}
	// The summary ai-bdd prints counts a step as fuzzy on either signal.
	if (determinism === "fuzzy" || reasons.length > 0) tally.fuzzySteps += 1;
}

function tallyScenario(
	scenario: JsonValue,
	path: string,
	tally: ScenarioTally,
	issues: string[],
): void {
	tally.scenarios += 1;
	if (!isJsonObject(scenario)) {
		issues.push(`${path}: expected an object`);
		return;
	}
	closedKeys(scenario, path, RUN_REPORT_KEYS.ScenarioResult, issues);
	durationOf(scenario, path, issues);
	readNestedUsage(scenario, path, tally.run, issues);
	const status = memberOf(SCENARIO_STATUSES, fieldOf(scenario, "status"));
	if (status === undefined) {
		issues.push(`${path}.status: expected ${SCENARIO_STATUSES.join("|")}`);
	} else {
		tally.byStatus.set(status, (tally.byStatus.get(status) ?? 0) + 1);
	}
	for (const [index, step] of arrayOf(
		scenario,
		"steps",
		path,
		issues,
	).entries()) {
		tallyStep(step, `${path}.steps[${index}]`, tally, issues);
	}
}

/** `totals` must say what the scenarios say; a report that disagrees with itself is not evidence. */
function readTotals(
	report: JsonObject,
	tally: ScenarioTally,
	issues: string[],
): ScenarioTotals {
	const totals = objectOf(report, "totals", "", issues);
	closedKeys(totals, "totals", RUN_REPORT_KEYS.Totals, issues);
	const read = (status: ScenarioStatus): number => {
		const count = countOf(totals, status, "totals", issues);
		const counted = tally.byStatus.get(status) ?? 0;
		if (count !== counted) {
			issues.push(
				`totals.${status} is ${count} but ${counted} scenario(s) have status ${status}`,
			);
		}
		return count;
	};
	return {
		passed: read("passed"),
		failed: read("failed"),
		healed: read("healed"),
		blocked: read("blocked"),
		skipped: read("skipped"),
		inconclusive: read("inconclusive"),
		error: read("error"),
	};
}

/** A run id as the gate uses it: exactly one directory name under the runs directory. */
export function isAiBddRunId(value: string): value is AiBddRunId {
	return RUN_ID_RE.test(value);
}

/** `sha256:` and 64 lowercase hex digits. */
export function isReportDigest(value: string): value is ReportDigest {
	return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function readRunId(report: JsonObject, issues: string[]): string {
	const runId = fieldOf(report, "runId");
	if (isJsonString(runId) && RUN_ID_RE.test(runId)) return runId;
	issues.push("runId: expected one directory name (letters, digits, . _ -)");
	return "";
}

/** The form RunReport v1 pins for startedAt: Date.prototype.toISOString(), UTC with milliseconds. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function readStartedAt(report: JsonObject, issues: string[]): string {
	const startedAt = fieldOf(report, "startedAt");
	if (
		isJsonString(startedAt) &&
		ISO_RE.test(startedAt) &&
		Number.isFinite(Date.parse(startedAt))
	) {
		return startedAt;
	}
	issues.push(
		"startedAt: expected an ISO 8601 timestamp in toISOString form (YYYY-MM-DDTHH:MM:SS.sssZ)",
	);
	return "";
}

function readExitCode(
	report: JsonObject,
	issues: string[],
): AiBddExitCode | undefined {
	const value = fieldOf(report, "exitCode");
	const exitCode = EXIT_CODES.find((code) => code === value);
	if (exitCode === undefined) {
		issues.push("exitCode: expected 0, 1, 2, 3 or 4");
	}
	return exitCode;
}

function documentOf(bytes: Uint8Array): JsonObject {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new AcceptanceReportError(["report.json is not UTF-8 text"]);
	}
	const document = parseJsonText(text);
	if (!isJsonObject(document)) {
		throw new AcceptanceReportError(["report.json is not a JSON object"]);
	}
	const repeated = duplicateKeyIn(text);
	if (repeated !== undefined) {
		throw new AcceptanceReportError([
			`report.json repeats the key ${JSON.stringify(repeated)} in one object`,
		]);
	}
	const version = fieldOf(document, "schemaVersion");
	if (version !== 1) {
		// Every other field of another version may mean something else, so nothing more is read.
		throw new AcceptanceReportError([
			`schemaVersion is ${JSON.stringify(version ?? null)}: this gate reads RunReport version 1 only`,
		]);
	}
	return document;
}

/**
 * Parse the bytes of `.ai-bdd/report/report.json` into frozen replay-only
 * evidence. `reportDigest` is the sha256 of exactly these bytes, so it equals
 * `sha256sum report.json`.
 */
export function parseAiBddRunReport(bytes: Uint8Array): AcceptanceEvidence {
	const report = documentOf(bytes);
	const issues: string[] = [];
	closedKeys(report, "", RUN_REPORT_KEYS.RunReport, issues);
	const runId = readRunId(report, issues);
	const startedAt = readStartedAt(report, issues);
	readOptions(report, issues);
	const tally: ScenarioTally = {
		run: readUsage(report, issues),
		byStatus: new Map(),
		scenarios: 0,
		fuzzySteps: 0,
	};
	for (const [index, scenario] of arrayOf(
		report,
		"scenarios",
		"",
		issues,
	).entries()) {
		tallyScenario(scenario, `scenarios[${index}]`, tally, issues);
	}
	const totals = readTotals(report, tally, issues);
	const exitCode = readExitCode(report, issues);
	const notPassed =
		totals.failed + totals.inconclusive + totals.blocked + totals.error;
	if (exitCode === 0 && notPassed > 0) {
		issues.push(
			`exitCode is 0 but ${notPassed} scenario(s) failed, were inconclusive, blocked or ended in error: the report contradicts itself`,
		);
	}
	// ai-bdd exits 0 for an empty selection (no plans, every scenario rejected): a pass that replayed nothing.
	if (exitCode === 0 && tally.scenarios === 0) {
		issues.push(
			"exitCode is 0 but the run has no scenario: nothing was replayed",
		);
	} else if (exitCode === 0 && totals.passed + totals.healed === 0) {
		issues.push(
			`exitCode is 0 but no scenario passed or healed (${totals.skipped} skipped): nothing was replayed`,
		);
	}
	if (issues.length > 0 || exitCode === undefined) {
		throw new AcceptanceReportError(issues);
	}
	return Object.freeze({
		// SAFETY: readRunId returned it only after RUN_ID_RE matched, the whole AiBddRunId invariant.
		runId: runId as AiBddRunId,
		reportDigest: reportDigestOf(bytes),
		startedAt,
		scenariosTotal: tally.scenarios,
		...totals,
		fuzzySteps: tally.fuzzySteps,
		modelCalls: 0,
		frozen: true,
		noAgent: true,
		exitCode,
	});
}
