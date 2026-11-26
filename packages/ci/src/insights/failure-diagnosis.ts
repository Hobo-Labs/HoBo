import { stripVTControlCharacters } from "node:util";
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
	logTail?: string;
	annotations?: readonly string[];
}>;

export type FailedStep = Readonly<{ name: string; number: number }>;

export type FailureDiagnosis = Readonly<{
	failedStep?: FailedStep;
	runnerFailed: boolean;
	timedOut: boolean;
	excerpt: readonly string[];
	kind: FailureKind;
	rerun: RerunOutlook;
	evidence: readonly string[];
}>;

export type DiagnosisPattern = Readonly<{
	label: string;
	pattern: RegExp;
	alongside?: RegExp;
}>;

export const MAX_EXCERPT_LINES = 50;

export const MAX_EXCERPT_BYTES = 8192;

export const MAX_EVIDENCE_LENGTH = 200;

export const RUNNER_FAILED_EVIDENCE = "the job failed before any step ran";

export const TIMED_OUT_EVIDENCE = "the job ran out of time";

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

export const INFRA_PATTERNS_AFTER_RUNNER_FAILURE: readonly DiagnosisPattern[] =
	[
		{
			label: "The operation was canceled",
			pattern: /the operation was cancell?ed/i,
		},
	];

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

export const CONFIG_PATTERNS_IN_SETUP_STEPS: readonly DiagnosisPattern[] = [
	{
		label: "No such file or directory",
		pattern: /no such file or directory/i,
	},
];

export const ACTION_STEP_PREFIX = "Run actions/";

export const LINT_PATTERNS: readonly DiagnosisPattern[] = [
	{
		label: "a linter or formatter by name",
		pattern:
			/\b(?:eslint|oxlint|biome|ruff|prettier|rubocop|golangci-lint|clippy|shellcheck|actionlint|stylelint|flake8|pylint)\b/i,
	},
];

export const LINT_STEP_PATTERNS: readonly DiagnosisPattern[] = [
	{ label: 'step name contains "lint"', pattern: /lint/i },
	{
		label: 'step name has a word starting with "format"',
		pattern: /(?<![a-z])format/i,
	},
];

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

export const BUILD_STEP_PATTERNS: readonly DiagnosisPattern[] = [
	{ label: 'step name contains "build"', pattern: /build/i },
	{ label: 'step name contains "compile"', pattern: /compile/i },
	{ label: 'step name contains "typecheck"', pattern: /type[- ]?check/i },
];

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

export const TEST_STEP_PATTERNS: readonly DiagnosisPattern[] = [
	{
		label: 'step name has a word starting with "test", or names a test runner',
		pattern: /(?<![a-z])test|pytest|unittest|vitest|nextest/i,
	},
];

export const FLAKE_HINT_PATTERNS: readonly DiagnosisPattern[] = [
	{
		label: "Timeout of <duration>",
		pattern: /\btimeout of \d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?)\b/i,
	},
	{ label: "Test timed out", pattern: /\btests? timed out\b/i },
	{ label: "flaky", pattern: /flaky/i },
	{ label: "Retry #<number>", pattern: /\bretry #\d+\b/i },
	{ label: "ECONNREFUSED", pattern: /ECONNREFUSED/ },
	{ label: "Target closed", pattern: /target closed/i },
	{ label: "Navigation timeout", pattern: /navigation timeout/i },
];

const BYTE_ORDER_MARK = /^﻿/;

const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

const ERROR_MARKER = "##[error]";

const ERROR_WORD =
	/\b(?:\w*errors?|failed|failures?|fatal|panic|\w*exceptions?)\b/i;

const ZERO_PROBLEMS = /\b(?:0|no)\s+(?:errors?|failed|failures?)\b/gi;

function cleanLine(line: string): string {
	return stripVTControlCharacters(line)
		.replace(BYTE_ORDER_MARK, "")
		.replace(TIMESTAMP_PREFIX, "")
		.replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
		.replace(/\p{Cc}/gu, " ")
		.trimEnd();
}

function cleanLines(text: string): readonly string[] {
	return text.split(/\r?\n/).map(cleanLine);
}

function looksLikeError(line: string): boolean {
	if (line.includes(ERROR_MARKER)) return true;
	return ERROR_WORD.test(line.replace(ZERO_PROBLEMS, ""));
}

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
	return cleanLine(text).trim().slice(0, MAX_EVIDENCE_LENGTH);
}

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
		stepName: failed === undefined ? undefined : cleanLine(failed.name).trim(),
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
		failedStep: {
			name: cleanLine(failed.name).trim(),
			number: failed.number,
		},
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

export function summarizeDiagnosis(diagnosis: FailureDiagnosis): string {
	const verb = diagnosis.timedOut ? "Timed out" : "Failed";
	let lead = verb;
	if (diagnosis.failedStep !== undefined) {
		lead = `${verb} at "${cleanLine(diagnosis.failedStep.name).trim()}"`;
	} else if (diagnosis.runnerFailed) {
		lead = "Failed before any step ran";
	}
	return `${lead}: ${kindPhrase(diagnosis.kind)}; ${rerunPhrase(diagnosis.rerun)}.`;
}
