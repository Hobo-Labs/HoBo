/**
 * Runner-less checks (ADR-0183, decision F9; gauntlet cases C01 and C02).
 *
 * `createRelayChecks` is the `RelayChecks` handler relay mode hands to
 * `answerRelayJob`. A relay job whose steps are HoBo check steps (a `uses:`
 * ending in `/checks/pr-title` or `/checks/lint`) is completed by the relay
 * itself, passed or failed, with annotations; no runner starts and no minute
 * is billed. A job with no check step is left to be routed.
 *
 * Every step of a check job must be a check step whose `with:` inputs are
 * literal text, and no check may appear twice. A job that mixes check steps with anything else, or passes a
 * check an expression, fails with the reason: a relay never runs job code.
 *
 * - The title check needs a pull request event. It checks the pull request's
 *   title with `checkPullRequestTitle`, against the step's `types` or
 *   `checks.prTitle.types` in `.hobo/ci.json`.
 * - The lint check is off unless `.hobo/ci.json` sets `checks.lint`. It runs
 *   the tools in `./lint.ts` in a sandbox with no network, on the commit's
 *   archive, five minutes per tool at most.
 *
 * Each answered check job is reported as one `check.completed` event. The
 * usage report counts the job, a relay job finished with no billed minute,
 * from the run's own facts.
 */
import { create } from "@bufbuild/protobuf";
import {
	isRelayCheckStep,
	type RelayChecks,
	type RelayJobAnnotation,
	type RelayJobAnswer,
	RelayJobAnswerSchema,
	type RelayJobMessage,
	type RelayJobStep,
} from "@hobo/ci";
import { checkPullRequestTitle, parseTitleTypes } from "@hobo/ci/insights";
import { parseRelayChecksConfig, type RelayChecksConfig } from "./config.js";
import {
	LINT_MAX_ANNOTATIONS,
	LINT_TOOL_COMMANDS,
	LINT_TOOL_TIMEOUT_MS,
	type LintSandbox,
	type LintToolResult,
	lintAnnotations,
	lintSummary,
	lintToolResult,
	lintToolsOf,
} from "./lint.js";
import type { RelayCheckSource } from "./source.js";

// public-contract: the checks a relay answers, by the end of their step's `uses:`.
export const RELAY_CHECK_NAMES = ["pr-title", "lint"] as const;
export type RelayCheckName = (typeof RELAY_CHECK_NAMES)[number];

// public-contract: the event a relay emits for each check job it answers.
export const CHECK_COMPLETED_EVENT = "check.completed";

/** The `with:` inputs each check takes. */
const CHECK_INPUTS: ReadonlyMap<RelayCheckName, readonly string[]> = new Map<
	RelayCheckName,
	readonly string[]
>([
	["pr-title", ["types"]],
	["lint", ["tools"]],
]);

const PULL_REQUEST_EVENTS: ReadonlySet<string> = new Set([
	"pull_request",
	"pull_request_target",
]);

/** One check job a relay answered. */
export type RelayCheckCompleted = Readonly<{
	type: typeof CHECK_COMPLETED_EVENT;
	repository: string;
	runId: number;
	runAttempt: number;
	/** The relay job's id at the runner service. */
	jobId: string;
	/** The job's id in its workflow file. */
	job: string;
	checks: readonly Readonly<{ name: RelayCheckName; passed: boolean }>[];
	conclusion: "succeeded" | "failed";
	/** Epoch milliseconds. */
	atMs: number;
	/** The node that answered. */
	node: string;
}>;

export type RelayChecksOptions = Readonly<{
	source: RelayCheckSource;
	/** Where the lint tools run; without one, a lint step fails saying so. */
	sandbox: LintSandbox | undefined;
	/** Told of each check job answered. A failure here never changes the answer. */
	completed: ((event: RelayCheckCompleted) => Promise<void>) | undefined;
	node: string;
	nowMs: () => number;
	/** `LINT_TOOL_TIMEOUT_MS` when absent. */
	toolTimeoutMs?: number | undefined;
}>;

type Note = Pick<RelayJobAnnotation, "level" | "message">;

type CheckResult = Readonly<{
	name: RelayCheckName;
	passed: boolean;
	notes: readonly Note[];
	summary: string;
}>;

type CheckStep = Readonly<{
	name: RelayCheckName;
	inputs: ReadonlyMap<string, string>;
}>;

/** The check a step runs, read from the end of its `uses:` path. */
export function relayCheckOf(uses: string): RelayCheckName | undefined {
	if (!isRelayCheckStep(uses)) return undefined;
	const path = uses.split("@")[0] ?? "";
	return RELAY_CHECK_NAMES.find((name) => path.endsWith(`/checks/${name}`));
}

/**
 * The check steps of a job, or the reason the job cannot be answered as one.
 * Undefined when no step is a check step: the job is routed.
 */
export function checkStepsOf(
	steps: readonly RelayJobStep[],
):
	| Readonly<{ ok: true; steps: readonly CheckStep[] }>
	| Readonly<{ ok: false; problem: string }>
	| undefined {
	if (!steps.some((step) => isRelayCheckStep(step.uses))) return undefined;
	const read: CheckStep[] = [];
	for (const [index, step] of steps.entries()) {
		const name = relayCheckOf(step.uses);
		if (name === undefined)
			return {
				ok: false,
				problem: `Step ${index + 1} (${step.uses === "" ? "a script" : step.uses}) is not a HoBo check step. A relay answers a job made only of check steps and never runs a job's other steps; move the other steps to a job with a runner.`,
			};
		if (read.some((earlier) => earlier.name === name))
			return {
				ok: false,
				problem: `Step ${index + 1} repeats the ${name} check. A job runs each check once; put its inputs on one step.`,
			};
		const allowed = CHECK_INPUTS.get(name) ?? [];
		const inputs = new Map<string, string>();
		for (const input of step.inputs) {
			if (!allowed.includes(input.name))
				return {
					ok: false,
					problem: `The ${name} check takes ${allowed.map((entry) => `"${entry}"`).join(" or ")}, not "${input.name}".`,
				};
			if (input.value.includes("${{"))
				return {
					ok: false,
					problem: `The ${name} check's input "${input.name}" must be literal text, not an expression; a relay evaluates no expression.`,
				};
			inputs.set(input.name, input.value);
		}
		read.push({ name, inputs });
	}
	return { ok: true, steps: read };
}

function answer(
	message: RelayJobMessage,
	passed: boolean,
	reason: string,
	notes: readonly Note[],
): RelayJobAnswer {
	return create(RelayJobAnswerSchema, {
		jobId: message.jobId,
		planId: message.planId,
		conclusion: passed ? "succeeded" : "failed",
		outputs: [
			{ name: "outcome", value: passed ? "passed" : "failed" },
			{ name: "reason", value: reason },
		],
		annotations:
			notes.length > 0 ? [...notes] : [{ level: "notice", message: reason }],
	});
}

function failed(name: RelayCheckName, sentence: string): CheckResult {
	return {
		name,
		passed: false,
		notes: [{ level: "error", message: sentence }],
		summary: sentence,
	};
}

class Checks {
	private readonly timeoutMs: number;

	constructor(private readonly options: RelayChecksOptions) {
		this.timeoutMs = options.toolTimeoutMs ?? LINT_TOOL_TIMEOUT_MS;
	}

	async handle(message: RelayJobMessage): Promise<RelayJobAnswer | undefined> {
		const steps = checkStepsOf(message.steps);
		if (steps === undefined) return undefined;
		if (!steps.ok) {
			const done = answer(message, false, steps.problem, [
				{ level: "error", message: steps.problem },
			]);
			await this.report(message, [], done);
			return done;
		}
		let config: RelayChecksConfig;
		try {
			const read = parseRelayChecksConfig(
				await this.options.source.ciFile(message),
			);
			if (!read.ok) {
				const done = answer(message, false, read.problem, [
					{ level: "error", message: read.problem },
				]);
				await this.report(message, [], done);
				return done;
			}
			config = read.config;
		} catch (error) {
			const sentence = `.hobo/ci.json could not be read: ${error instanceof Error ? error.message : String(error)}. Run the job again.`;
			const done = answer(message, false, sentence, [
				{ level: "error", message: sentence },
			]);
			await this.report(message, [], done);
			return done;
		}
		// Each check runs once (see `checkStepsOf`). The title check carries one
		// annotation, so the lint check gets the rest of the job's 50.
		const lintRoom =
			LINT_MAX_ANNOTATIONS -
			steps.steps.filter((step) => step.name === "pr-title").length;
		const results: CheckResult[] = [];
		for (const step of steps.steps)
			results.push(
				step.name === "pr-title"
					? await this.title(message, step, config)
					: await this.lint(message, step, config, lintRoom),
			);
		const passed = results.every((result) => result.passed);
		const done = answer(
			message,
			passed,
			results.map((result) => result.summary).join(" "),
			results.flatMap((result) => result.notes),
		);
		await this.report(message, results, done);
		return done;
	}

	private async title(
		message: RelayJobMessage,
		step: CheckStep,
		config: RelayChecksConfig,
	): Promise<CheckResult> {
		if (!PULL_REQUEST_EVENTS.has(message.event))
			return failed(
				"pr-title",
				`The pull request title check needs a pull_request or pull_request_target event; this run came from ${message.event}.`,
			);
		const stepTypes = parseTitleTypes(step.inputs.get("types") ?? "");
		const types = stepTypes.length > 0 ? stepTypes : config.titleTypes;
		let pull: Awaited<ReturnType<RelayCheckSource["pullRequest"]>>;
		try {
			pull = await this.options.source.pullRequest(message);
		} catch (error) {
			return failed(
				"pr-title",
				`The pull request could not be read: ${error instanceof Error ? error.message : String(error)}. Run the job again.`,
			);
		}
		if (pull === undefined)
			return failed(
				"pr-title",
				`Run ${message.runId} names no pull request, so there is no title to check.`,
			);
		const check = checkPullRequestTitle(pull.title, { types });
		if (check.ok) {
			const sentence = `The title of pull request #${pull.number} follows the title rule.`;
			return {
				name: "pr-title",
				passed: true,
				notes: [{ level: "notice", message: sentence }],
				summary: sentence,
			};
		}
		return failed(
			"pr-title",
			`The title of pull request #${pull.number}, "${pull.title}", breaks the title rule: ${check.reason}`,
		);
	}

	private async lint(
		message: RelayJobMessage,
		step: CheckStep,
		config: RelayChecksConfig,
		room: number,
	): Promise<CheckResult> {
		if (!config.lint)
			return failed(
				"lint",
				`The lint check is off for ${message.repository}. Set "checks": { "lint": true } in .hobo/ci.json on the default branch to turn it on.`,
			);
		const sandbox = this.options.sandbox;
		if (!sandbox)
			return failed(
				"lint",
				"This relay node has no lint sandbox, so it cannot run the lint check. Run the job again so a node with one can answer it.",
			);
		const tools = lintToolsOf(step.inputs.get("tools"));
		if (!tools.ok)
			return failed("lint", `The lint check failed: ${tools.problem}.`);
		let archive: Uint8Array;
		try {
			const commit = await this.options.source.commit(message);
			archive = await this.options.source.archive(message, commit);
		} catch (error) {
			return failed(
				"lint",
				`The commit could not be read for the lint check: ${error instanceof Error ? error.message : String(error)}. Run the job again.`,
			);
		}
		const results: LintToolResult[] = [];
		for (const tool of tools.tools) {
			try {
				const run = await sandbox.run({
					tool,
					argv: LINT_TOOL_COMMANDS.get(tool) ?? [tool],
					archive,
					timeoutMs: this.timeoutMs,
					network: "none",
				});
				results.push(lintToolResult(tool, run, this.timeoutMs));
			} catch (error) {
				results.push({
					tool,
					passed: false,
					summary: `could not start in the sandbox: ${error instanceof Error ? error.message : String(error)}`,
					findings: [],
				});
			}
		}
		return {
			name: "lint",
			passed: results.every((result) => result.passed),
			notes: lintAnnotations(results, room),
			summary: lintSummary(results),
		};
	}

	private async report(
		message: RelayJobMessage,
		results: readonly CheckResult[],
		done: RelayJobAnswer,
	): Promise<void> {
		const completed = this.options.completed;
		if (!completed) return;
		try {
			await completed({
				type: CHECK_COMPLETED_EVENT,
				repository: message.repository,
				runId: message.runId,
				runAttempt: message.runAttempt,
				jobId: message.jobId,
				job: message.job,
				checks: results.map((result) => ({
					name: result.name,
					passed: result.passed,
				})),
				conclusion: done.conclusion === "succeeded" ? "succeeded" : "failed",
				atMs: this.options.nowMs(),
				node: this.options.node,
			});
		} catch {
			// A missing event never changes the job's answer.
		}
	}
}

/** The `RelayChecks` handler relay mode passes to `answerRelayJob`. */
export function createRelayChecks(options: RelayChecksOptions): RelayChecks {
	const checks = new Checks(options);
	return (message) => checks.handle(message);
}
