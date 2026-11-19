import { describe, expect, it } from "vitest";
import {
	ACTION_STEP_PREFIX,
	BUILD_PATTERNS,
	BUILD_STEP_PATTERNS,
	CONFIG_PATTERNS,
	CONFIG_PATTERNS_IN_SETUP_STEPS,
	diagnoseFailure,
	type FailureDiagnosis,
	FLAKE_HINT_PATTERNS,
	INFRA_PATTERNS,
	INFRA_PATTERNS_AFTER_RUNNER_FAILURE,
	LINT_PATTERNS,
	LINT_STEP_PATTERNS,
	logExcerpt,
	MAX_EVIDENCE_LENGTH,
	MAX_EXCERPT_BYTES,
	MAX_EXCERPT_LINES,
	RUNNER_FAILED_EVIDENCE,
	summarizeDiagnosis,
	TEST_PATTERNS,
	TEST_STEP_PATTERNS,
	TIMED_OUT_EVIDENCE,
} from "../src/insights/failure-diagnosis.js";
import type {
	InsightConclusion,
	InsightJob,
	InsightStep,
} from "../src/insights/types.js";

const SETUP: InsightStep = {
	name: "Set up job",
	number: 1,
	conclusion: "success",
};

const PLAIN_STEP = "Run script";

function step(
	name: string,
	conclusion: InsightConclusion = "success",
	number = 2,
): InsightStep {
	return { name, number, conclusion };
}

function job(partial: Partial<InsightJob> = {}): InsightJob {
	return {
		id: 1,
		name: "check",
		labels: ["ubuntu-latest"],
		conclusion: "failure",
		queuedAtMs: 0,
		startedAtMs: 0,
		completedAtMs: 60_000,
		steps: [SETUP, step(PLAIN_STEP, "failure")],
		billed: false,
		...partial,
	};
}

function failedAt(stepName: string): InsightJob {
	return job({ steps: [SETUP, step(stepName, "failure")] });
}

function diagnoseLog(logTail: string, stepName = PLAIN_STEP): FailureDiagnosis {
	return diagnoseFailure({ job: failedAt(stepName), logTail });
}

function utf8Length(text: string): number {
	return new TextEncoder().encode(text).length;
}

describe("logExcerpt", () => {
	it("strips colour codes, the byte-order mark and GitHub's timestamps", () => {
		const log = [
			"﻿2026-01-01T00:00:00.0000000Z starting",
			"2026-01-01T00:00:01.1234567Z \u001b[31m##[error]boom\u001b[0m",
			"\u001b[1;32m2026-01-01T00:00:02Z plain error\u001b[0m   ",
		].join("\n");
		expect(logExcerpt(log)).toEqual([
			"starting",
			"##[error]boom",
			"plain error",
		]);
	});

	it("ends at the last line that looks like an error", () => {
		const log = ["a", "Error: one", "b", "Error: two", "c", "d"].join("\n");
		expect(logExcerpt(log)).toEqual(["a", "Error: one", "b", "Error: two"]);
	});

	it.each([
		"##[error]",
		"it failed",
		"1 failure",
		"3 failures",
		"fatal: not a git repository",
		"thread 'main' panicked: panic in worker",
		"unhandled exception",
		"TypeError: x is not a function",
		"java.io.IOException: closed",
		"2 errors, 0 failed",
		"ERROR in ./src/index.ts",
	])("takes %j for an error line", (line) => {
		expect(logExcerpt([line, "after"].join("\n"))).toEqual([line]);
	});

	it.each([
		"Found 0 errors",
		"0 failed, 12 passed",
		"0 failures",
		"no errors",
		"No failures",
		"0 error(s)",
		"all good",
		"terrorist",
	])("does not take %j for an error line", (line) => {
		expect(logExcerpt(["error: real", line].join("\n"))).toEqual([
			"error: real",
		]);
	});

	it("gives the end of the log when no line looks like an error", () => {
		const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
		const excerpt = logExcerpt(lines.join("\n"));
		expect(excerpt).toHaveLength(MAX_EXCERPT_LINES);
		expect(excerpt[0]).toBe("line 11");
		expect(excerpt.at(-1)).toBe("line 60");
	});

	it("gives at most fifty lines up to the error", () => {
		const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
		lines[54] = "line 55 failed";
		const excerpt = logExcerpt(lines.join("\n"));
		expect(MAX_EXCERPT_LINES).toBe(50);
		expect(excerpt).toHaveLength(50);
		expect(excerpt[0]).toBe("line 6");
		expect(excerpt.at(-1)).toBe("line 55 failed");
	});

	it("gives a short log whole", () => {
		expect(logExcerpt("one\r\ntwo\r\n\r\nthree")).toEqual([
			"one",
			"two",
			"",
			"three",
		]);
	});

	it("drops blank lines at the end of the log", () => {
		expect(logExcerpt("one\ntwo\n\n  \n")).toEqual(["one", "two"]);
	});

	it("gives nothing for an empty log", () => {
		expect(logExcerpt("")).toEqual([]);
		expect(logExcerpt("\n\n")).toEqual([]);
	});

	it("drops lines from the top to stay within the byte cap", () => {
		expect(MAX_EXCERPT_BYTES).toBe(8192);
		const lines = Array.from(
			{ length: 50 },
			(_, index) => `${String(index).padStart(2, "0")}${"é".repeat(99)}`,
		);
		const excerpt = logExcerpt(lines.join("\n"));

		expect(excerpt).toHaveLength(40);
		expect(excerpt[0]?.slice(0, 2)).toBe("10");
		expect(excerpt.at(-1)?.slice(0, 2)).toBe("49");
		expect(utf8Length(excerpt.join("\n"))).toBeLessThanOrEqual(8192);
	});

	it("keeps a last line that exactly fills the cap, and nothing above it", () => {
		const full = "x".repeat(MAX_EXCERPT_BYTES);
		expect(logExcerpt(["above", full].join("\n"))).toEqual([full]);
	});

	it("keeps the start of a last line that is longer than the cap", () => {
		const [ascii] = logExcerpt(`${"x".repeat(MAX_EXCERPT_BYTES + 1)}`);
		expect(ascii).toBe("x".repeat(MAX_EXCERPT_BYTES));

		const [wide] = logExcerpt(["above", "€".repeat(3_000)].join("\n"));
		expect(wide).toBe("€".repeat(2_730));

		const [mixed] = logExcerpt(`${"x".repeat(MAX_EXCERPT_BYTES - 1)}😀`);
		expect(mixed).toBe("x".repeat(MAX_EXCERPT_BYTES - 1));
	});

	it("counts half of a surrogate pair as the three bytes it is written in", () => {
		const half = "\uD83D";
		const room = MAX_EXCERPT_BYTES - "above\n".length;
		expect(utf8Length(half)).toBe(3);
		const filled = `${"x".repeat(room - 3)}${half}`;
		expect(logExcerpt(["above", filled].join("\n"))).toHaveLength(2);
		expect(logExcerpt(["above", `${filled}x`].join("\n"))).toHaveLength(1);
	});

	it("counts two, three and four byte characters", () => {
		const fits = (line: string): boolean =>
			logExcerpt(["above", line].join("\n")).length === 2;
		const room = MAX_EXCERPT_BYTES - "above\n".length;
		expect(fits("é".repeat(room / 2))).toBe(true);
		expect(fits(`${"é".repeat(room / 2)}x`)).toBe(false);
		expect(fits(`${"€".repeat((room - 2) / 3)}xx`)).toBe(true);
		expect(fits(`${"€".repeat((room - 2) / 3)}xxx`)).toBe(false);
		expect(fits(`${"😀".repeat((room - 2) / 4)}xx`)).toBe(true);
		expect(fits(`${"😀".repeat((room - 2) / 4)}xxx`)).toBe(false);
	});
});

describe("diagnoseFailure: what failed", () => {
	it("names the first step, by number, that failed or timed out", () => {
		const diagnosis = diagnoseFailure({
			job: job({
				steps: [
					step("Run later", "failure", 4),
					step("Run earlier", "timed_out", 3),
					step("Run fine", "success", 2),
					SETUP,
				],
			}),
		});
		expect(diagnosis.failedStep).toEqual({ name: "Run earlier", number: 3 });
		expect(diagnosis.timedOut).toBe(true);
		expect(diagnosis.runnerFailed).toBe(false);
	});

	it("names no step when none failed", () => {
		const diagnosis = diagnoseFailure({
			job: job({ steps: [SETUP, step(PLAIN_STEP)] }),
		});
		expect("failedStep" in diagnosis).toBe(false);
		expect(diagnosis).toEqual<FailureDiagnosis>({
			runnerFailed: false,
			timedOut: false,
			excerpt: [],
			kind: "unclear",
			rerun: "unknown",
			evidence: [],
		});
	});

	it("reports a runner failure when the job failed without running a step", () => {
		const atSetup = diagnoseFailure({
			job: job({ steps: [{ ...SETUP, conclusion: "failure" }] }),
		});
		expect(atSetup).toMatchObject({
			failedStep: { name: "Set up job", number: 1 },
			runnerFailed: true,
			kind: "infra",
			rerun: "likely-passes",
			evidence: [RUNNER_FAILED_EVIDENCE],
		});
		expect(diagnoseFailure({ job: job({ steps: [] }) }).runnerFailed).toBe(
			true,
		);
	});

	it("reports no runner failure for a job that did not fail", () => {
		const cancelled = diagnoseFailure({
			job: job({ conclusion: "cancelled", steps: [] }),
		});
		expect(cancelled.runnerFailed).toBe(false);
		expect(cancelled.kind).toBe("unclear");
	});

	it("reports a job that ran out of time", () => {
		const diagnosis = diagnoseFailure({
			job: job({
				conclusion: "timed_out",
				steps: [SETUP, step(PLAIN_STEP, "cancelled")],
			}),
		});
		expect(diagnosis).toMatchObject({
			timedOut: true,
			kind: "unclear",
			rerun: "unknown",
			evidence: [TIMED_OUT_EVIDENCE],
		});
	});

	it("still sorts a timed-out job by what its log and step show", () => {
		const diagnosis = diagnoseFailure({
			job: job({
				conclusion: "timed_out",
				steps: [SETUP, step("Run pnpm test", "timed_out")],
			}),
		});
		expect(diagnosis).toMatchObject({ timedOut: true, kind: "test" });
	});
});

describe("diagnoseFailure: runner and network failures", () => {
	it.each([
		"The hosted runner lost communication with the server.",
		"The runner has received a shutdown signal.",
		"write /tmp/cache: No space left on device",
		"read ECONNRESET",
		"connect ETIMEDOUT 140.82.112.3:443",
		"getaddrinfo EAI_AGAIN registry.npmjs.org",
		"request failed: socket hang up",
		"net/http: TLS handshake timeout",
		"HTTP 503 Service Unavailable",
		"HTTP 502 Bad Gateway",
		"API rate limit exceeded for installation",
		"toomanyrequests: pull rate limit reached",
		"Failed to download action 'https://api.github.com/repos/a/b/tarball/v1'",
		"Unable to pull image ghcr.io/acme/app:latest",
		"error pulling image configuration",
		"curl: (6) Could not resolve host: github.com",
		"Job was cancelled because the runner was lost",
		"Job was canceled because the runner was lost",
	])("takes %j for an infrastructure failure", (line) => {
		expect(diagnoseLog(["before", line, "after"].join("\n"))).toMatchObject({
			runnerFailed: false,
			kind: "infra",
			rerun: "likely-passes",
			evidence: [line],
		});
	});

	it("takes a cancelled operation for one only when the runner failed", () => {
		const log = "Error: The operation was canceled.";
		const withRunnerFailure = diagnoseFailure({
			job: job({ steps: [SETUP] }),
			logTail: ["read ECONNRESET", log].join("\n"),
		});
		expect(withRunnerFailure).toMatchObject({
			kind: "infra",
			evidence: [RUNNER_FAILED_EVIDENCE, log, "read ECONNRESET"],
		});
		expect(diagnoseLog(log)).toMatchObject({ kind: "unclear", evidence: [] });
	});

	it("records a line once when two patterns match it", () => {
		const line = "read ECONNRESET: socket hang up";
		expect(diagnoseLog(line).evidence).toEqual([line]);
	});
});

describe("diagnoseFailure: workflow configuration", () => {
	it.each([
		"Invalid workflow file: .github/workflows/ci.yml#L10",
		"Unrecognized named-value: 'secretz'",
		"Resource not accessible by integration",
		"Input required and not supplied: token",
		"Secret DEPLOY_KEY not found",
		"not found: secrets.DEPLOY_KEY",
	])("takes %j for a configuration error", (line) => {
		expect(diagnoseLog(line)).toMatchObject({
			kind: "config",
			rerun: "likely-fails",
			evidence: [line],
		});
	});

	it("takes a missing file for one in a step that runs an action", () => {
		const log = "cp: cannot stat 'dist': No such file or directory";
		expect(ACTION_STEP_PREFIX).toBe("Run actions/");
		expect(diagnoseLog(log, "Run actions/upload-artifact@v4")).toMatchObject({
			kind: "config",
			evidence: [log],
		});
		expect(diagnoseLog(log)).toMatchObject({ kind: "unclear" });
	});

	it("takes a missing file for one when the set-up step failed", () => {
		const diagnosis = diagnoseFailure({
			job: job({
				steps: [
					{ ...SETUP, conclusion: "failure" },
					step(PLAIN_STEP, "cancelled"),
				],
			}),
			logTail: "No such file or directory",
		});
		expect(diagnosis).toMatchObject({ runnerFailed: false, kind: "config" });
	});

	it("needs the secret and the not-found on one line", () => {
		const log = ["reading secret", "module not found"].join("\n");
		expect(diagnoseLog(log).kind).toBe("unclear");
	});
});

describe("diagnoseFailure: lint", () => {
	it.each([
		"> eslint .",
		"oxlint found 2 problems",
		"biome check failed",
		"ruff check .",
		"[warn] Code style issues found. Run Prettier to fix.",
		"rubocop",
		"golangci-lint run",
		"cargo clippy -- -D warnings",
		"shellcheck scripts/*.sh",
		"actionlint",
		"stylelint",
		"flake8",
		"pylint",
	])("takes the log line %j for a lint failure", (line) => {
		expect(diagnoseLog(line)).toMatchObject({
			kind: "lint",
			rerun: "likely-fails",
			evidence: [line],
		});
	});

	it.each([
		"Run ruff check",
		"Lint",
		"Run pnpm run lint:ci",
		"Check formatting",
		"Format",
	])("takes the step name %j for a lint failure", (stepName) => {
		expect(diagnoseLog("", stepName)).toMatchObject({
			kind: "lint",
			rerun: "likely-fails",
			evidence: [`step "${stepName}"`],
		});
	});

	it("does not take a word that merely contains format for a format check", () => {
		expect(diagnoseLog("", "Show information").kind).toBe("unclear");
	});
});

describe("diagnoseFailure: build", () => {
	it.each([
		"src/a.ts(1,2): error TS2322: Type 'string' is not assignable",
		"Type error: Property 'x' does not exist",
		"Error: Cannot find module './missing.js'",
		"javac: compilation failed",
		"Build failed with 2 errors",
		"error[E0308]: mismatched types",
		"main.o: undefined reference to `start'",
		"SyntaxError: Unexpected token '}'",
	])("takes the log line %j for a build failure", (line) => {
		expect(diagnoseLog(line)).toMatchObject({
			kind: "build",
			rerun: "likely-fails",
			evidence: [line],
		});
	});

	it.each([
		"Run pnpm build",
		"Compile",
		"Typecheck",
		"Type-check",
		"Type check",
	])("takes the step name %j for a build failure", (stepName) => {
		expect(diagnoseLog("", stepName)).toMatchObject({
			kind: "build",
			evidence: [`step "${stepName}"`],
		});
	});

	it("does not take a lower-case type error for a compiler's", () => {
		expect(diagnoseLog("a type error occurred").kind).toBe("unclear");
	});
});

describe("diagnoseFailure: tests", () => {
	it.each([
		" Tests  3 failed | 10 passed",
		"1 test failed",
		"12 tests failed",
		"10 failed",
		"AssertionError: values differ",
		" FAIL  src/a.spec.ts > adds",
		"FAIL src/a.spec.ts",
		"--- FAIL: TestAdd (0.01s)",
	])("takes the log line %j for a test failure", (line) => {
		expect(diagnoseLog(line)).toMatchObject({
			kind: "test",
			rerun: "likely-fails",
			evidence: [line.trim()],
		});
	});

	it("takes expected and received together for a test failure", () => {
		const log = ["Expected: 1", "Received: 2"].join("\n");
		expect(diagnoseLog(log)).toMatchObject({
			kind: "test",
			evidence: ["Expected: 1", "Received: 2"],
		});
		expect(diagnoseLog("Expected: 1").kind).toBe("unclear");
		expect(diagnoseLog("Received: 2").kind).toBe("unclear");
	});

	it.each([
		"0 failed",
		"0 tests failed",
		"PREFAIL x",
		"fail fast",
	])("does not take the log line %j for a test failure", (line) => {
		expect(diagnoseLog(line).kind).toBe("unclear");
	});

	it.each([
		"Run pnpm test",
		"Tests",
		"Run pytest",
		"Run vitest",
		"e2e-test",
	])("takes the step name %j for a test failure", (stepName) => {
		expect(diagnoseLog("", stepName)).toMatchObject({
			kind: "test",
			rerun: "likely-fails",
			evidence: [`step "${stepName}"`],
		});
	});

	it("does not take a word that merely contains test for a test run", () => {
		expect(diagnoseLog("", "Install latest deps").kind).toBe("unclear");
	});

	it.each([
		"Error: Timeout of 5000ms exceeded",
		"Test timed out in 5000ms",
		"marked flaky",
		"Retry #1",
		"connect ECONNREFUSED 127.0.0.1:5432",
		"Target closed",
		"Navigation timeout of 30000 ms exceeded",
	])("takes a failed test with the hint %j for a flaky one", (hint) => {
		const diagnosis = diagnoseLog([hint, "2 failed"].join("\n"));
		expect(diagnosis).toMatchObject({ kind: "flaky", rerun: "unknown" });
		expect(diagnosis.evidence).toEqual(["2 failed", hint]);
	});

	it("reads no further than the excerpt, which ends at the last error", () => {
		const diagnosis = diagnoseLog(["2 failed", "Retry #1"].join("\n"));
		expect(diagnosis).toMatchObject({
			excerpt: ["2 failed"],
			kind: "test",
			rerun: "likely-fails",
		});
	});

	it("does not call a failure flaky on a hint alone", () => {
		expect(diagnoseLog("Retry #1").kind).toBe("unclear");
	});

	it("does not treat any mention of retrying as flake evidence", () => {
		expect(
			diagnoseLog(["Do not retry this request", "2 failed"].join("\n")),
		).toMatchObject({
			kind: "test",
			rerun: "likely-fails",
		});
	});

	it("does not treat an unrelated operation timeout as flake evidence", () => {
		expect(
			diagnoseLog(["The operation timed out", "2 failed"].join("\n")).kind,
		).toBe("test");
	});
});

describe("diagnoseFailure: order and evidence", () => {
	it("tries the rules in order and stops at the first that matches", () => {
		const kindOf = (lines: readonly string[], stepName = PLAIN_STEP) =>
			diagnoseLog(lines.join("\n"), stepName).kind;
		expect(kindOf(["read ECONNRESET", "Invalid workflow file"])).toBe("infra");
		expect(kindOf(["Invalid workflow file", "eslint ."])).toBe("config");
		expect(kindOf(["Resource not accessible by integration"], "Lint")).toBe(
			"config",
		);
		expect(kindOf(["eslint .", "error TS2322"])).toBe("lint");
		expect(kindOf(["error TS2322", "3 failed"])).toBe("build");
		expect(kindOf(["3 failed"], "Build and test")).toBe("build");
		expect(kindOf(["3 failed"])).toBe("test");
	});

	it("reads annotations as well as the log", () => {
		const diagnosis = diagnoseFailure({
			job: failedAt(PLAIN_STEP),
			annotations: [
				"Process completed with exit code 1.",
				"2026-01-01T00:00:00.0000000Z first\n\u001b[31msrc/a.ts: error TS2322\u001b[0m",
			],
		});
		expect(diagnosis).toMatchObject({
			excerpt: [],
			kind: "build",
			evidence: ["src/a.ts: error TS2322"],
		});
	});

	it("quotes at most two hundred characters of a line", () => {
		const line = `   error TS2322: ${"x".repeat(300)}`;
		const [evidence] = diagnoseLog(line).evidence;
		expect(MAX_EVIDENCE_LENGTH).toBe(200);
		expect(evidence).toHaveLength(200);
		expect(evidence?.startsWith("error TS2322: xxx")).toBe(true);
	});

	it("gives the same answer every time", () => {
		const log = ["2 failed", "Retry #1", "read ECONNRESET"].join("\n");
		expect(diagnoseLog(log)).toEqual(diagnoseLog(log));
	});
});

describe("pattern tables", () => {
	const tables = [
		INFRA_PATTERNS,
		INFRA_PATTERNS_AFTER_RUNNER_FAILURE,
		CONFIG_PATTERNS,
		CONFIG_PATTERNS_IN_SETUP_STEPS,
		LINT_PATTERNS,
		LINT_STEP_PATTERNS,
		BUILD_PATTERNS,
		BUILD_STEP_PATTERNS,
		TEST_PATTERNS,
		TEST_STEP_PATTERNS,
		FLAKE_HINT_PATTERNS,
	];

	it("describe every pattern and keep no state between matches", () => {
		for (const table of tables) {
			expect(table.length).toBeGreaterThan(0);
			for (const entry of table) {
				expect(entry.label.trim()).not.toBe("");
				expect(entry.pattern.global).toBe(false);
				expect(entry.pattern.sticky).toBe(false);
				expect(entry.alongside?.global ?? false).toBe(false);
			}
		}
	});
});

describe("summarizeDiagnosis", () => {
	const base: FailureDiagnosis = {
		runnerFailed: false,
		timedOut: false,
		excerpt: [],
		kind: "unclear",
		rerun: "unknown",
		evidence: [],
	};

	it("says where it failed, what it looks like and what a re-run will do", () => {
		const diagnosis = diagnoseLog(
			"src/a.ts(1,1): error TS2322: nope",
			"Run pnpm check",
		);
		expect(summarizeDiagnosis(diagnosis)).toBe(
			'Failed at "Run pnpm check": looks like a build error; a re-run will likely fail the same way.',
		);
	});

	it("says when the runner failed before any step", () => {
		const diagnosis = diagnoseFailure({ job: job({ steps: [] }) });
		expect(summarizeDiagnosis(diagnosis)).toBe(
			"Failed before any step ran: looks like a runner or network problem; a re-run will likely pass.",
		);
	});

	it("says when the job timed out, with or without a step", () => {
		expect(
			summarizeDiagnosis({
				...base,
				timedOut: true,
				failedStep: { name: "Run script", number: 2 },
			}),
		).toBe(
			'Timed out at "Run script": the cause is unclear; a re-run may or may not pass.',
		);
		expect(summarizeDiagnosis({ ...base, timedOut: true })).toBe(
			"Timed out: the cause is unclear; a re-run may or may not pass.",
		);
	});

	it("says plainly when nothing is known", () => {
		expect(summarizeDiagnosis(base)).toBe(
			"Failed: the cause is unclear; a re-run may or may not pass.",
		);
	});

	it.each([
		["flaky", "looks like a flaky test"],
		["lint", "looks like a lint or formatting error"],
		["test", "looks like a test failure"],
		["config", "looks like a workflow configuration error"],
	] as const)("describes the kind %s", (kind, phrase) => {
		expect(summarizeDiagnosis({ ...base, kind })).toContain(`: ${phrase}; `);
	});
});
