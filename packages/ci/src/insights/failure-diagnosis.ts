/**
 * A first read of why a job failed, from what GitHub already has: the job's
 * steps, the end of its log and its annotations.
 *
 * The diagnosis names the step that failed, cuts the log down to the lines
 * around the last error, sorts the failure into a kind and says whether
 * running the job again is likely to help. The sorting is a fixed list of
 * text patterns tried in a fixed order, so the same failure always gets the
 * same answer and every answer comes with the lines it was based on. Nothing
 * is guessed: a failure no pattern recognises is `unclear`.
 *
 * Pure functions. The pattern tables are exported so documentation can print
 * exactly what is matched.
 */

import { type InsightJob, ranSteps, SETUP_STEP_NAME } from "./types.js";

export type FailureKind =
	| "infra"
	| "flaky"
	| "lint"
	| "test"
	| "build"
	| "config"
	| "unclear";

export type RerunOutlook = "likely-passes" | "likely-fails" | "unknown";

export type FailureDiagnosisInput = Readonly<{
	job: InsightJob;
	/** The end of the job's log, as downloaded. */
	logTail?: string;
	/** The messages of the job's check-run annotations. */
	annotations?: readonly string[];
}>;

export type FailedStep = Readonly<{ name: string; number: number }>;

export type FailureDiagnosis = Readonly<{
	/** The first step that failed or timed out. Absent when no step did. */
	failedStep?: FailedStep;
	/** The job failed without running any step of its own. */
	runnerFailed: boolean;
	/** The job, or the step that failed, ran out of time. */
	timedOut: boolean;
	/** The log lines leading up to the last error, cleaned. */
	excerpt: readonly string[];
	kind: FailureKind;
	rerun: RerunOutlook;
	/** The lines and step names the kind was decided on. */
	evidence: readonly string[];
}>;

/**
 * One thing looked for. It is found when some line matches `pattern` and,
 * where `alongside` is given, some line (the same or another) matches that
 * too.
 */
export type DiagnosisPattern = Readonly<{
	/** What is looked for, in words, for documentation. */
	label: string;
	pattern: RegExp;
	alongside?: RegExp;
}>;

// public-contract: the most log lines a diagnosis quotes.
export const MAX_EXCERPT_LINES = 50;

// public-contract: the most UTF-8 bytes of log a diagnosis quotes.
export const MAX_EXCERPT_BYTES = 8192;

// public-contract: the longest a single piece of evidence is quoted.
export const MAX_EVIDENCE_LENGTH = 200;

// public-contract: evidence recorded when the job failed before running a step.
export const RUNNER_FAILED_EVIDENCE = "the job failed before any step ran";

// public-contract: evidence recorded when a job ran out of time and nothing else explains it.
export const TIMED_OUT_EVIDENCE = "the job ran out of time";

// public-contract: log text that means the runner or the network failed, not the code.
export const INFRA_PATTERNS: readonly DiagnosisPattern[] = [
	{
		label: "lost communication with the server",
		pattern: /lost communication with the server/i,
	},
	{
		label: "received a shutdown signal",
		pattern: /received a shutdown signal/i,
	},
	{ label: "No space left on device", pattern: /no space left on device/i },
	{ label: "ECONNRESET", pattern: /ECONNRESET/ },
	{ label: "ETIMEDOUT", pattern: /ETIMEDOUT/ },
	{ label: "EAI_AGAIN", pattern: /EAI_AGAIN/ },
	{ label: "socket hang up", pattern: /socket hang up/i },
	{ label: "TLS handshake timeout", pattern: /TLS handshake timeout/i },
	{ label: "503 Service Unavailable", pattern: /503 Service Unavailable/i },
	{ label: "502 Bad Gateway", pattern: /502 Bad Gateway/i },
	{ label: "rate limit exceeded", pattern: /rate limit exceeded/i },
	{ label: "toomanyrequests", pattern: /toomanyrequests/i },
	{ label: "Failed to download action", pattern: /failed to download action/i },
	{
		label: "Unable to pull image / error pulling image",
		pattern: /unable to pull image|error pulling image/i,
	},
	{ label: "Could not resolve host", pattern: /could not resolve host/i },
	{
		label: "Job was cancelled because the runner",
		pattern: /job was cancell?ed because the runner/i,
	},
];

// public-contract: log text that counts as a runner failure only when the job ran no step.
export const INFRA_PATTERNS_AFTER_RUNNER_FAILURE: readonly DiagnosisPattern[] =
	[
		{
			label: "The operation was canceled",
			pattern: /the operation was cancell?ed/i,
		},
	];

// public-contract: log text that means the workflow itself is set up wrongly.
export const CONFIG_PATTERNS: readonly DiagnosisPattern[] = [
	{ label: "Invalid workflow file", pattern: /invalid workflow file/i },
	{ label: "Unrecognized named-value", pattern: /unrecognized named-value/i },
	{
		label: "Resource not accessible by integration",
		pattern: /resource not accessible by integration/i,
	},
	{
		label: "Input required and not supplied",
		pattern: /input required and not supplied/i,
	},
	{
		label: '"secret" and "not found" on one line',
		pattern: /\bsecrets?\b.*\bnot found\b|\bnot found\b.*\bsecrets?\b/i,
	},
];

// public-contract: log text that means a set-up error when the failed step is "Set up job" or runs an action.
export const CONFIG_PATTERNS_IN_SETUP_STEPS: readonly DiagnosisPattern[] = [
	{
		label: "No such file or directory",
		pattern: /no such file or directory/i,
	},
];

// public-contract: the start of the name GitHub gives a step that runs an action.
export const ACTION_STEP_PREFIX = "Run actions/";

// public-contract: linter and formatter names; found in the log or the failed step's name.
export const LINT_PATTERNS: readonly DiagnosisPattern[] = [
	{
		label: "a linter or formatter by name",
		pattern:
			/\b(?:eslint|oxlint|biome|ruff|prettier|rubocop|golangci-lint|clippy|shellcheck|actionlint|stylelint|flake8|pylint)\b/i,
	},
];

// public-contract: failed-step names that mean a lint or format check.
export const LINT_STEP_PATTERNS: readonly DiagnosisPattern[] = [
	{ label: 'step name contains "lint"', pattern: /lint/i },
	{
		label: 'step name has a word starting with "format"',
		pattern: /(?<![a-z])format/i,
	},
];

// public-contract: log text that means the code did not compile or type-check.
export const BUILD_PATTERNS: readonly DiagnosisPattern[] = [
	{ label: "error TS<number>", pattern: /error TS\d+/ },
	{ label: "Type error", pattern: /\bType error\b/ },
	{ label: "cannot find module", pattern: /cannot find module/i },
	{ label: "compilation failed", pattern: /compilation failed/i },
	{ label: "Build failed", pattern: /build failed/i },
	{ label: "error[E<number>]", pattern: /error\[E\d+\]/ },
	{ label: "undefined reference", pattern: /undefined reference/i },
	{ label: "SyntaxError", pattern: /SyntaxError/ },
];

// public-contract: failed-step names that mean a build or type-check.
export const BUILD_STEP_PATTERNS: readonly DiagnosisPattern[] = [
	{ label: 'step name contains "build"', pattern: /build/i },
	{ label: 'step name contains "compile"', pattern: /compile/i },
	{ label: 'step name contains "typecheck"', pattern: /type[- ]?check/i },
];

// public-contract: log text that means a test failed.
export const TEST_PATTERNS: readonly DiagnosisPattern[] = [
	{
		label: "<count> failed / <count> tests failed, count above zero",
		pattern: /\b0*[1-9]\d* (?:tests? )?failed\b/i,
	},
	{ label: "AssertionError", pattern: /AssertionError/ },
	{ label: '"FAIL " before a test name', pattern: /(?:^|[^A-Za-z])FAIL / },
	{ label: "--- FAIL:", pattern: /--- FAIL:/ },
	{
		label: '"expected" and "received"',
		pattern: /\bexpected\b/i,
		alongside: /\breceived\b/i,
	},
];

// public-contract: failed-step names that mean a test run.
export const TEST_STEP_PATTERNS: readonly DiagnosisPattern[] = [
	{
		label: 'step name has a word starting with "test", or names a test runner',
		pattern: /(?<![a-z])test|pytest|unittest|vitest|nextest/i,
	},
];

// public-contract: log text that makes a failed test look timing-dependent rather than wrong.
export const FLAKE_HINT_PATTERNS: readonly DiagnosisPattern[] = [
	{ label: "Timeout", pattern: /timeout/i },
	{ label: "timed out", pattern: /timed out/i },
	{ label: "flaky", pattern: /flaky/i },
	{ label: "retry", pattern: /retry/i },
	{ label: "ECONNREFUSED", pattern: /ECONNREFUSED/ },
	{ label: "Target closed", pattern: /target closed/i },
	{ label: "Navigation timeout", pattern: /navigation timeout/i },
];

const ESCAPE = String.fromCharCode(27);

/** A terminal colour or cursor sequence. Built from the escape character so the source holds no control character. */
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, "g");

const BYTE_ORDER_MARK = /^﻿/;

/** The timestamp GitHub puts before each log line, e.g. `2026-01-01T00:00:00.0000000Z `. */
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

const ERROR_MARKER = "##[error]";

/**
 * A word that announces a problem. Besides the bare words this takes their
 * plurals and names ending in them, such as `TypeError` or `IOException`.
 */
const ERROR_WORD =
	/\b(?:\w*errors?|failed|failures?|fatal|panic|\w*exceptions?)\b/i;

/** A count of no problems, which is not a problem: "0 errors", "0 failed", "no failures". */
const ZERO_PROBLEMS = /\b(?:0|no)\s+(?:errors?|failed|failures?)\b/gi;

/** One log line without colour codes, a byte-order mark, GitHub's timestamp or trailing space. */
function cleanLine(line: string): string {
	return line
		.replace(ANSI_SEQUENCE, "")
		.replace(BYTE_ORDER_MARK, "")
		.replace(TIMESTAMP_PREFIX, "")
		.trimEnd();
}

function cleanLines(text: string): readonly string[] {
	return text.split(/\r?\n/).map(cleanLine);
}

function looksLikeError(line: string): boolean {
	if (line.includes(ERROR_MARKER)) return true;
	return ERROR_WORD.test(line.replace(ZERO_PROBLEMS, ""));
}

/**
 * The number of bytes a text takes in UTF-8. A character outside the basic
 * plane is two code units and four bytes; half of such a pair on its own is
 * written as the three-byte replacement character.
 */
function utf8Bytes(text: string): number {
	let bytes = 0;
	for (const character of text) {
		const codeUnit = character.charCodeAt(0);
		if (character.length > 1) bytes += 4;
		else if (codeUnit < 0x80) bytes += 1;
		else if (codeUnit < 0x800) bytes += 2;
		else bytes += 3;
	}
	return bytes;
}

/** The start of a text, as much as fits in `maxBytes` of UTF-8 without splitting a character. */
function startWithinBytes(text: string, maxBytes: number): string {
	let kept = "";
	let bytes = 0;
	for (const character of text) {
		bytes += utf8Bytes(character);
		if (bytes > maxBytes) break;
		kept += character;
	}
	return kept;
}

/**
 * The part of a log worth reading: up to `MAX_EXCERPT_LINES` lines ending at
 * the last line that looks like an error, or the last lines of the log when
 * none does. Lines are cleaned of colour codes and GitHub's timestamps, and
 * blank lines at the very end of the log are dropped.
 *
 * The excerpt, joined with newlines, never exceeds `MAX_EXCERPT_BYTES`: lines
 * are dropped from the top until it fits, and if the last line alone is too
 * long, its start is kept.
 */
export function logExcerpt(logTail: string): readonly string[] {
	const lines = [...cleanLines(logTail)];
	while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
	const lastError = lines.map(looksLikeError).lastIndexOf(true);
	const end = lastError === -1 ? lines.length : lastError + 1;
	const newestFirst = lines
		.slice(Math.max(0, end - MAX_EXCERPT_LINES), end)
		.reverse();
	const excerpt: string[] = [];
	let bytes = 0;
	for (const line of newestFirst) {
		const separator = excerpt.length === 0 ? 0 : 1;
		const lineBytes = utf8Bytes(line);
		if (bytes + separator + lineBytes > MAX_EXCERPT_BYTES) {
			if (excerpt.length === 0) {
				excerpt.push(startWithinBytes(line, MAX_EXCERPT_BYTES));
			}
			break;
		}
		bytes += separator + lineBytes;
		excerpt.push(line);
	}
	return excerpt.reverse();
}

function quoted(text: string): string {
	return text.trim().slice(0, MAX_EVIDENCE_LENGTH);
}

/** The first line each found pattern matched, in table order. */
function linesMatching(
	lines: readonly string[],
	patterns: readonly DiagnosisPattern[],
): readonly string[] {
	const found: string[] = [];
	for (const { pattern, alongside } of patterns) {
		const line = lines.find((candidate) => pattern.test(candidate));
		if (line === undefined) continue;
		if (alongside === undefined) {
			found.push(quoted(line));
			continue;
		}
		const partner = lines.find((candidate) => alongside.test(candidate));
		if (partner !== undefined) found.push(quoted(line), quoted(partner));
	}
	return found;
}

/** The failed step's name as evidence, when any of the patterns matches it. */
function stepMatching(
	stepName: string | undefined,
	patterns: readonly DiagnosisPattern[],
): readonly string[] {
	if (stepName === undefined) return [];
	const matches = patterns.some(({ pattern }) => pattern.test(stepName));
	return matches ? [quoted(`step "${stepName}"`)] : [];
}

type Verdict = Readonly<{
	kind: FailureKind;
	rerun: RerunOutlook;
	evidence: readonly string[];
}>;

type Clues = Readonly<{
	lines: readonly string[];
	stepName: string | undefined;
	runnerFailed: boolean;
	jobTimedOut: boolean;
}>;

/**
 * The rules, tried in order; the first that finds anything decides.
 *
 * 1. infra: the runner failed, or the log shows the runner or network failing.
 * 2. config: the workflow is set up wrongly.
 * 3. lint, 4. build, 5. test: by log text, or failing that by the step's name.
 *    A failed test with a timing hint in the log is `flaky` instead.
 * 6. Nothing matched: `unclear`, noting a time-out when there was one.
 */
function classify(clues: Clues): Verdict {
	const { lines, stepName } = clues;

	const infra = linesMatching(lines, INFRA_PATTERNS);
	if (clues.runnerFailed) {
		return {
			kind: "infra",
			rerun: "likely-passes",
			evidence: [
				RUNNER_FAILED_EVIDENCE,
				...linesMatching(lines, INFRA_PATTERNS_AFTER_RUNNER_FAILURE),
				...infra,
			],
		};
	}
	if (infra.length > 0) {
		return { kind: "infra", rerun: "likely-passes", evidence: infra };
	}

	const inSetupStep =
		stepName === SETUP_STEP_NAME ||
		(stepName?.startsWith(ACTION_STEP_PREFIX) ?? false);
	const config = [
		...linesMatching(lines, CONFIG_PATTERNS),
		...(inSetupStep
			? linesMatching(lines, CONFIG_PATTERNS_IN_SETUP_STEPS)
			: []),
	];
	if (config.length > 0) {
		return { kind: "config", rerun: "likely-fails", evidence: config };
	}

	const lint = [
		...linesMatching(lines, LINT_PATTERNS),
		...stepMatching(stepName, [...LINT_PATTERNS, ...LINT_STEP_PATTERNS]),
	];
	if (lint.length > 0) {
		return { kind: "lint", rerun: "likely-fails", evidence: lint };
	}

	const build = [
		...linesMatching(lines, BUILD_PATTERNS),
		...stepMatching(stepName, BUILD_STEP_PATTERNS),
	];
	if (build.length > 0) {
		return { kind: "build", rerun: "likely-fails", evidence: build };
	}

	const test = [
		...linesMatching(lines, TEST_PATTERNS),
		...stepMatching(stepName, TEST_STEP_PATTERNS),
	];
	if (test.length > 0) {
		const hints = linesMatching(lines, FLAKE_HINT_PATTERNS);
		return hints.length > 0
			? { kind: "flaky", rerun: "unknown", evidence: [...test, ...hints] }
			: { kind: "test", rerun: "likely-fails", evidence: test };
	}

	return {
		kind: "unclear",
		rerun: "unknown",
		evidence: clues.jobTimedOut ? [TIMED_OUT_EVIDENCE] : [],
	};
}

/**
 * Why a job failed, as far as its steps, log and annotations show.
 *
 * `failedStep` is the first step, by number, that failed or timed out. The
 * kind is decided over the annotations, the excerpt and that step's name; see
 * the pattern tables for what is looked for and in which order. A re-run is
 * only ever called likely to pass for a runner or network failure: a failed
 * test with a timing hint is `flaky` with the outlook left `unknown`.
 */
export function diagnoseFailure(
	input: FailureDiagnosisInput,
): FailureDiagnosis {
	const { job } = input;
	const failed = [...job.steps]
		.sort((left, right) => left.number - right.number)
		.find(
			(step) =>
				step.conclusion === "failure" || step.conclusion === "timed_out",
		);
	const runnerFailed = job.conclusion === "failure" && !ranSteps(job);
	const jobTimedOut = job.conclusion === "timed_out";
	const excerpt = logExcerpt(input.logTail ?? "");
	const verdict = classify({
		lines: [...(input.annotations ?? []).flatMap(cleanLines), ...excerpt],
		stepName: failed?.name,
		runnerFailed,
		jobTimedOut,
	});
	const diagnosis = {
		runnerFailed,
		timedOut: jobTimedOut || failed?.conclusion === "timed_out",
		excerpt,
		kind: verdict.kind,
		rerun: verdict.rerun,
		evidence: [...new Set(verdict.evidence)],
	};
	if (failed === undefined) return diagnosis;
	return {
		failedStep: { name: failed.name, number: failed.number },
		...diagnosis,
	};
}

function kindPhrase(kind: FailureKind): string {
	switch (kind) {
		case "infra":
			return "looks like a runner or network problem";
		case "flaky":
			return "looks like a flaky test";
		case "lint":
			return "looks like a lint or formatting error";
		case "test":
			return "looks like a test failure";
		case "build":
			return "looks like a build error";
		case "config":
			return "looks like a workflow configuration error";
		case "unclear":
			return "the cause is unclear";
	}
}

function rerunPhrase(rerun: RerunOutlook): string {
	switch (rerun) {
		case "likely-passes":
			return "a re-run will likely pass";
		case "likely-fails":
			return "a re-run will likely fail the same way";
		case "unknown":
			return "a re-run may or may not pass";
	}
}

/**
 * The diagnosis as one plain sentence for a terminal, e.g.
 * `Failed at "Run pnpm check": looks like a build error; a re-run will likely fail the same way.`
 */
export function summarizeDiagnosis(diagnosis: FailureDiagnosis): string {
	const verb = diagnosis.timedOut ? "Timed out" : "Failed";
	let lead = verb;
	if (diagnosis.failedStep !== undefined) {
		lead = `${verb} at "${diagnosis.failedStep.name}"`;
	} else if (diagnosis.runnerFailed) {
		lead = "Failed before any step ran";
	}
	return `${lead}: ${kindPhrase(diagnosis.kind)}; ${rerunPhrase(diagnosis.rerun)}.`;
}
