import type { RelayJobAnnotation } from "@hobo/ci";

export const LINT_TOOLS = [
	"actionlint",
	"shellcheck",
	"oxlint",
	"ruff",
	"typos",
] as const;
export type LintTool = (typeof LINT_TOOLS)[number];

export const LINT_TOOL_TIMEOUT_MS = 5 * 60_000;
export const LINT_CHECK_BUDGET_MS = 8 * 60_000;
export const LINT_MAX_ANNOTATIONS = 50;
export const LINT_MAX_OUTPUT_BYTES = 1024 * 1024;

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

export type LintRun = Readonly<{
	tool: LintTool;
	argv: readonly string[];
	archive: Uint8Array;
	timeoutMs: number;
	network: "none";
}>;

export type LintRunResult = Readonly<{
	exitCode: number;
	output: string;
	timedOut: boolean;
}>;

export interface LintSandbox {
	run(request: LintRun): Promise<LintRunResult>;
}

export type LintFinding = Readonly<{
	tool: LintTool;
	file: string;
	line: number;
	column: number;
	message: string;
}>;

export type LintToolResult = Readonly<{
	tool: LintTool;
	passed: boolean;
	summary: string;
	findings: readonly LintFinding[];
}>;

const FINDING = /^(.+?):(\d+):(\d+):\s*(.+)$/u;
const NOT_INSTALLED = 127;

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

export function lintSpan(ms: number): string {
	if (ms >= 60_000 && ms % 60_000 === 0) {
		const minutes = ms / 60_000;
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000} seconds`;
	return `${ms} ms`;
}

export const LINT_STOPPED_BY_BUDGET = "stopped when the check's time ran out";
export const LINT_NOT_RUN_BY_BUDGET = "not run: the check's time ran out";

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
