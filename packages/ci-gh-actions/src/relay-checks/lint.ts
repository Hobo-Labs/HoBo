/**
 * The lint check's tools and how their results become annotations
 * (ADR-0183, gauntlet case C02).
 *
 * Each tool runs once in a sandbox with no network, on the commit's archive,
 * for five minutes at most, and the whole check, archive included, for eight
 * minutes at most (`LINT_CHECK_BUDGET_MS`). Every tool is asked for one finding per line in
 * the `file:line:column: message` form, so one reader turns any of them into
 * annotations. A job carries one result line per tool, then findings, 50
 * annotations at most in all.
 *
 * The rules here are pure: the sandbox is a port (`LintSandbox`), and
 * `./docker-sandbox.ts` holds the one that runs Docker.
 */
import type { RelayJobAnnotation } from "@hobo/ci";

// public-contract: the tools the lint check runs, in the order it runs them.
export const LINT_TOOLS = [
	"actionlint",
	"shellcheck",
	"oxlint",
	"ruff",
	"typos",
] as const;
export type LintTool = (typeof LINT_TOOLS)[number];

/** How long one tool may run: five minutes. */
export const LINT_TOOL_TIMEOUT_MS = 5 * 60_000;
/**
 * How long one whole lint check may take, the archive read and every tool
 * together: eight minutes. A relay holds the job from `acquirejob` to
 * `completejob` and renews no job lock (`runner-protocol/client.ts`), so the
 * check must finish well inside the lock the service grants. The runner renews
 * that lock every 60 seconds (`Runner.Listener/JobDispatcher.cs` in
 * `actions/runner`, `RenewJobRequestAsync`) and the service sets its length
 * (`lockedUntil`), which the runner source does not state. This package
 * takes it as about ten minutes after the last renewal, not yet measured
 * against GitHub, so eight minutes leaves two minutes over. See RELAY-CHECKS.md.
 */
export const LINT_CHECK_BUDGET_MS = 8 * 60_000;
/** The most annotations a lint check puts on a job, result lines included. */
export const LINT_MAX_ANNOTATIONS = 50;
/** How much of a tool's output is read; the rest is left out. */
export const LINT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * The command each tool runs at the root of the unpacked commit, written so it
 * prints `file:line:column: message` lines. Each tool's own flags:
 * actionlint `-oneline`, shellcheck `-f gcc`, oxlint `--format unix`,
 * ruff `--output-format concise`, typos `--format brief`.
 */
export const LINT_TOOL_COMMANDS: ReadonlyMap<LintTool, readonly string[]> =
	new Map<LintTool, readonly string[]>([
		["actionlint", ["actionlint", "-oneline", "-no-color"]],
		[
			"shellcheck",
			[
				"sh",
				"-c",
				"find . -type f -name '*.sh' -not -path '*/node_modules/*' -exec shellcheck -f gcc {} +",
			],
		],
		["oxlint", ["oxlint", "--format", "unix"]],
		[
			"ruff",
			["ruff", "check", "--no-cache", "--output-format", "concise", "."],
		],
		["typos", ["typos", "--format", "brief"]],
	]);

/** One tool run in the sandbox. */
export type LintRun = Readonly<{
	tool: LintTool;
	argv: readonly string[];
	/** The commit as GitHub's gzipped tarball, one top-level folder inside. */
	archive: Uint8Array;
	timeoutMs: number;
	/** Always `none`: a lint run reaches no network. */
	network: "none";
}>;

export type LintRunResult = Readonly<{
	exitCode: number;
	/** Standard output and error together, at most `LINT_MAX_OUTPUT_BYTES`. */
	output: string;
	timedOut: boolean;
}>;

/** Where the lint tools run: a HoBo sandbox with no network. */
export interface LintSandbox {
	run(request: LintRun): Promise<LintRunResult>;
}

/** One finding a tool printed. */
export type LintFinding = Readonly<{
	tool: LintTool;
	file: string;
	line: number;
	column: number;
	message: string;
}>;

/** One tool's result. */
export type LintToolResult = Readonly<{
	tool: LintTool;
	passed: boolean;
	/** `passed`, or what went wrong, in a few words. */
	summary: string;
	findings: readonly LintFinding[];
}>;

const FINDING = /^(.+?):(\d+):(\d+):\s*(.+)$/u;
const NOT_INSTALLED = 127;

/** The tools a step's `tools` input names, or why it cannot be read. */
export function lintToolsOf(
	text: string | undefined,
):
	| Readonly<{ ok: true; tools: readonly LintTool[] }>
	| Readonly<{ ok: false; problem: string }> {
	if (text === undefined || text.trim() === "")
		return { ok: true, tools: LINT_TOOLS };
	const named = [
		...new Set(
			text
				.split(/[,\s]+/u)
				.map((entry) => entry.trim())
				.filter((entry) => entry !== ""),
		),
	];
	const tools: LintTool[] = [];
	for (const name of named) {
		const tool = LINT_TOOLS.find((known) => known === name);
		if (tool === undefined)
			return {
				ok: false,
				problem: `the lint check runs ${LINT_TOOLS.join(", ")}, not "${name}"`,
			};
		tools.push(tool);
	}
	return {
		ok: true,
		tools: LINT_TOOLS.filter((tool) => tools.includes(tool)),
	};
}

/** The findings in a tool's output: every `file:line:column: message` line. */
export function lintFindings(
	tool: LintTool,
	output: string,
): readonly LintFinding[] {
	const findings: LintFinding[] = [];
	for (const raw of output.split(/\r?\n/u)) {
		const match = FINDING.exec(raw.trim());
		if (!match) continue;
		findings.push({
			tool,
			file: (match[1] ?? "").replace(/^\.\//u, ""),
			line: Number(match[2]),
			column: Number(match[3]),
			message: (match[4] ?? "").trim(),
		});
	}
	return findings;
}

function lastLine(output: string): string {
	const lines = output
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return (lines.at(-1) ?? "").slice(0, 300);
}

/** What one run says about its tool. */
export function lintToolResult(
	tool: LintTool,
	run: LintRunResult,
	timeoutMs: number,
): LintToolResult {
	if (run.timedOut)
		return {
			tool,
			passed: false,
			summary: `stopped after ${Math.round(timeoutMs / 60_000)} minutes`,
			findings: [],
		};
	if (run.exitCode === NOT_INSTALLED)
		return {
			tool,
			passed: false,
			summary: "is not installed in the sandbox image",
			findings: [],
		};
	const findings = lintFindings(tool, run.output);
	if (run.exitCode === 0 && findings.length === 0)
		return { tool, passed: true, summary: "passed", findings };
	if (findings.length > 0)
		return {
			tool,
			passed: false,
			summary: `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
			findings,
		};
	const said = lastLine(run.output);
	return {
		tool,
		passed: false,
		summary: `exited ${run.exitCode}${said === "" ? "" : `: ${said}`}`,
		findings,
	};
}

/** A span of time in words: minutes, seconds or milliseconds. */
export function lintSpan(ms: number): string {
	if (ms >= 60_000 && ms % 60_000 === 0) {
		const minutes = ms / 60_000;
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000} seconds`;
	return `${ms} ms`;
}

/** What a tool says when the check's budget ran out while it ran. */
// public-contract: the result line a lint tool shows when the check's time ran out.
export const LINT_STOPPED_BY_BUDGET = "stopped when the check's time ran out";
/** What a tool says when the check's budget ran out before it started. */
// public-contract: the result line a lint tool not started for lack of time shows.
export const LINT_NOT_RUN_BY_BUDGET = "not run: the check's time ran out";

/**
 * One line for the whole check: each tool and its result. With
 * `budgetMs`, the check's time ran out and the line says so first.
 */
export function lintSummary(
	results: readonly LintToolResult[],
	budgetMs?: number,
): string {
	const failed = results.filter((result) => !result.passed).length;
	const parts = results.map((result) =>
		result.passed
			? `${result.tool} passed`
			: `${result.tool} ${result.summary}`,
	);
	if (budgetMs !== undefined)
		return `Lint timed out: the check's ${lintSpan(budgetMs)} ran out. ${parts.join("; ")}.`;
	return `Lint ${failed === 0 ? "passed" : "failed"}: ${parts.join("; ")}.`;
}

/**
 * The annotations for a lint check: one result per tool, then findings, then
 * a line saying how many were left out, `max` at most (`LINT_MAX_ANNOTATIONS`
 * when absent). The result lines are always kept.
 */
export function lintAnnotations(
	results: readonly LintToolResult[],
	max: number = LINT_MAX_ANNOTATIONS,
): readonly Pick<RelayJobAnnotation, "level" | "message">[] {
	const annotations: Pick<RelayJobAnnotation, "level" | "message">[] =
		results.map((result) => ({
			level: result.passed ? "notice" : "error",
			message: `${result.tool}: ${result.summary}`,
		}));
	const findings = results.flatMap((result) => result.findings);
	const room = Math.max(0, max - annotations.length);
	const shown =
		findings.length <= room
			? findings
			: findings.slice(0, Math.max(0, room - 1));
	for (const finding of shown)
		annotations.push({
			level: "error",
			message: `${finding.tool}: ${finding.file}:${finding.line}:${finding.column}: ${finding.message}`,
		});
	if (shown.length < findings.length)
		annotations.push({
			level: "warning",
			message: `${findings.length - shown.length} more findings are not shown; run the tools locally to see them all.`,
		});
	return annotations;
}
