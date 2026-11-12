import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CommandModule, HoboCli, YardRuntime } from "@hobo/cli";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export interface RunbookCommandDeps {
	// The shared Yard runtime the runbook's steps operate against — the same live
	// deployment state `up`/`inspect`/`drift` use. Injected by the composed CLI.
	readonly runtime?: YardRuntime;
	// Factory for the CLI the steps are dispatched through, sharing `runtime`.
	// Defaults to the composed HoBo CLI. Injectable for tests.
	readonly cliFactory?: (runtime: YardRuntime) => HoboCli;
}

interface RunbookStep {
	readonly verb: string;
	readonly args: readonly string[];
}

interface StepResult {
	readonly verb: string;
	readonly ok: boolean;
	readonly status: string;
}

// A runbook step must not re-enter `runbook` (no nesting) and should be a
// read-only diagnostic — the safe, replayable surface for incident response.
const NESTING_VERB = "runbook";

// Parse a runbook document (parse-don't-validate): a named, ordered list of
// steps, each a HoBo verb with optional args. Throws on a malformed shape.
function parseRunbook(raw: JsonValue | undefined) {
	if (!isJsonObject(raw) || raw === null) {
		throw new Error("runbook must be a JSON object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const doc = raw as { name?: unknown; steps?: unknown };
	const name = isJsonString(doc.name) ? doc.name : "runbook";
	if (!Array.isArray(doc.steps)) {
		throw new Error("runbook.steps must be an array");
	}
	const steps: RunbookStep[] = doc.steps.map((entry, i) => {
		if (!isJsonObject(entry) || entry === null) {
			throw new Error(`runbook.steps[${i}] must be an object`);
		}
		// SAFETY: assertion required at this I/O or test boundary.
		const step = entry as { verb?: unknown; args?: unknown };
		if (!isJsonString(step.verb) || step.verb.length === 0) {
			throw new Error(`runbook.steps[${i}].verb must be a non-empty string`);
		}
		const args = Array.isArray(step.args)
			? step.args.map((a) => String(a))
			: [];
		return { verb: step.verb, args };
	});
	return { name, steps };
}

// The composed CLI, sharing this runtime, is how steps run against the live
// deployment. A dynamic import defers the CLI module so the runbook <-> cli
// import cycle resolves at call time, not load time.
async function cliFor(
	deps: RunbookCommandDeps,
	runtime: YardRuntime,
): Promise<HoboCli> {
	if (deps.cliFactory) return deps.cliFactory(runtime);
	const { createComposedHoboCli } = await import("./cli.js");
	return createComposedHoboCli({ yardRuntime: runtime });
}

// Run each step through the CLI in order; a nested `runbook` step is refused.
async function runSteps(
	cli: HoboCli,
	steps: readonly RunbookStep[],
	cwd: string,
	emitProgress: (line: string) => void,
): Promise<StepResult[]> {
	const results: StepResult[] = [];
	for (const step of steps) {
		if (step.verb === NESTING_VERB) {
			results.push({ verb: step.verb, ok: false, status: "nesting_rejected" });
			emitProgress(`${step.verb}: nesting_rejected`);
			continue;
		}
		const run = await cli.run([step.verb, ...step.args, "--json"], { cwd });
		let ok = false;
		let status = "error";
		try {
			// SAFETY: assertion required at this I/O or test boundary.
			const env = JSON.parse(run.stdout) as { ok?: boolean; status?: string };
			ok = env.ok === true;
			status = env.status ?? "error";
		} catch {
			// Non-JSON output (e.g. a usage error) counts as a failed step.
		}
		results.push({ verb: step.verb, ok, status });
		emitProgress(`${step.verb}: ${status}`);
	}
	return results;
}

// `hobo runbook <file>` — execute (or replay) an incident runbook: a named,
// ordered sequence of HoBo diagnostic steps run in order against the live
// deployment. Each step is dispatched through the composed CLI sharing the same
// runtime, so a runbook of `inspect` -> `drift` -> `verify` reflects the real
// deployment state. Read-only steps make replay idempotent. Nesting (`runbook`
// as a step) is rejected. Reads/writes only the local runtime — no credential.
export function createRunbookCommand(
	deps: RunbookCommandDeps = {},
): CommandModule {
	return {
		run: async ({ context, flags, args, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_NO_RUNTIME",
					message:
						"hobo runbook has no Yard runtime wired — run it from the composed `hobo` binary.",
					data: { command: "runbook" },
				};
			}

			const file = args[0];
			if (!file) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_RUNBOOK_NO_FILE",
					message: "hobo runbook needs a runbook file: `hobo runbook <file>`.",
					remediation: ["Pass the path to a runbook JSON file."],
					data: { command: "runbook" },
				};
			}

			const projectDir = context.projectDir ?? flags.cwd ?? context.cwd;
			const filePath = path.isAbsolute(file)
				? file
				: path.join(projectDir, file);

			let runbook: { name: string; steps: RunbookStep[] };
			try {
				runbook = parseRunbook(JSON.parse(await readFile(filePath, "utf8")));
			} catch (error) {
				return {
					ok: false,
					status: "invalid",
					code: "HOBO_RUNBOOK_INVALID",
					// SAFETY: assertion required at this I/O or test boundary.
					message: `hobo runbook: could not load "${file}": ${(error as Error).message}`,
					data: { command: "runbook", file },
				};
			}

			const cli = await cliFor(deps, runtime);
			const results = await runSteps(
				cli,
				runbook.steps,
				projectDir,
				emitProgress,
			);

			const failed = results.filter((r) => !r.ok);
			const passed = failed.length === 0;
			return {
				ok: passed,
				status: passed ? "completed" : "failed",
				code: passed ? "HOBO_OK" : "HOBO_RUNBOOK_FAILED",
				message: passed
					? `hobo runbook "${runbook.name}": ${results.length}/${results.length} step(s) ok`
					: `hobo runbook "${runbook.name}": ${failed.length} of ${results.length} step(s) failed (${failed.map((r) => r.verb).join(", ")})`,
				...(passed
					? undefined
					: {
							remediation: failed.map((r) => `${r.verb}: ${r.status}`),
						}),
				data: {
					command: "runbook",
					name: runbook.name,
					steps: results,
				},
			};
		},
	};
}

// public-contract: refusal codes of the CD RunbookExecutor (RUNBOOK hooks).
export const RUNBOOK_EXECUTOR_REASON = Object.freeze({
	noRuntime: "runbook-no-runtime",
	pathOutsideProject: "runbook-path-outside-project",
	invalid: "runbook-invalid",
	failed: "runbook-failed",
} as const);

/**
 * Structural mirror of `@hobo/cd` `ReasonRecord` (hobo.cd.v1.ReasonRecord):
 * `@hobo/hobo` composes `@hobo/cd` (WP18) without this module importing it.
 */
export type RunbookReason = {
	readonly $typeName: "hobo.cd.v1.ReasonRecord";
	readonly code: string;
	readonly message: string;
	readonly remediation: string;
	readonly subject: string;
};

export type RunbookOutcome =
	| { readonly ok: true; readonly value: JsonObject }
	| { readonly ok: false; readonly reasons: readonly RunbookReason[] };

export interface RunbookExecutorDeps extends RunbookCommandDeps {
	/** Project directory runbook paths resolve against; a path may not leave it. */
	readonly projectDir: string;
}

/** The `RunbookExecutor` port `@hobo/cd` promotion hooks call (RUNBOOK hooks). */
export interface CdRunbookExecutor {
	run(
		input: Readonly<{ path: string; args: JsonObject }>,
		ctx: unknown,
	): Promise<RunbookOutcome>;
}

function runbookReason(
	code: string,
	message: string,
	remediation: string,
	subject: string,
): RunbookReason {
	return {
		$typeName: "hobo.cd.v1.ReasonRecord",
		code,
		message,
		remediation,
		subject,
	};
}

/**
 * `RunbookExecutor` for CD hooks (D4, R2): runs the same runbook documents
 * `hobo runbook <file>` runs, through the same composed CLI and runtime, with
 * no shell escape hatch. `hobo runbook` is unchanged. The hook's `args`
 * (promotion, Camp, Freight, point) are echoed into the result for the audit
 * trail; runbook steps take no templated input.
 */
export function createRunbookExecutor(
	deps: RunbookExecutorDeps,
): CdRunbookExecutor {
	return {
		async run(input) {
			const { runtime } = deps;
			if (!runtime)
				return {
					ok: false,
					reasons: [
						runbookReason(
							RUNBOOK_EXECUTOR_REASON.noRuntime,
							"no Yard runtime is wired for runbook hooks",
							"Compose the executor from the `hobo` binary with its Yard runtime.",
							input.path,
						),
					],
				};
			const root = path.resolve(deps.projectDir);
			const filePath = path.resolve(root, input.path);
			const relative = path.relative(root, filePath);
			if (
				path.isAbsolute(input.path) ||
				relative.startsWith("..") ||
				path.isAbsolute(relative)
			)
				return {
					ok: false,
					reasons: [
						runbookReason(
							RUNBOOK_EXECUTOR_REASON.pathOutsideProject,
							`runbook ${input.path} is outside the project`,
							"Reference runbooks by a path inside the project directory.",
							input.path,
						),
					],
				};
			let runbook: { name: string; steps: RunbookStep[] };
			try {
				runbook = parseRunbook(JSON.parse(await readFile(filePath, "utf8")));
			} catch (error) {
				return {
					ok: false,
					reasons: [
						runbookReason(
							RUNBOOK_EXECUTOR_REASON.invalid,
							`runbook ${input.path} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
							"Fix the runbook JSON: { name, steps: [{ verb, args? }] }.",
							input.path,
						),
					],
				};
			}
			const cli = await cliFor(deps, runtime);
			const results = await runSteps(cli, runbook.steps, root, () => undefined);
			const failed = results.filter((r) => !r.ok);
			if (failed.length > 0)
				return {
					ok: false,
					reasons: failed.map((r) =>
						runbookReason(
							RUNBOOK_EXECUTOR_REASON.failed,
							`runbook "${runbook.name}" step ${r.verb} ended ${r.status}`,
							`Run "hobo ${r.verb}" to see why, fix the cause, and let the promotion retry.`,
							input.path,
						),
					),
				};
			return {
				ok: true,
				value: {
					name: runbook.name,
					steps: results.map((r) => ({
						verb: r.verb,
						ok: r.ok,
						status: r.status,
					})),
					args: input.args,
				},
			};
		},
	};
}
