import { existsSync } from "node:fs";
import path from "node:path";

import type { TrustedVault } from "@hobo/core";

import type { CommandModule, CommandRunInput } from "../shell/registry.js";
import type { CommandData, CommandResult } from "../types/envelope.js";

export const LIFECYCLE_ACTIONS = Object.freeze([
	"up",
	"down",
	"plan",
	"status",
] as const);

export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

const LIFECYCLE_ACTION_SET: ReadonlySet<string> = new Set(LIFECYCLE_ACTIONS);

export function isLifecycleAction(word: string): word is LifecycleAction {
	return LIFECYCLE_ACTION_SET.has(word);
}

export interface LifecycleFlags {
	readonly whatIf: boolean;
	readonly mode: string | null;
	readonly project: string | null;
	readonly yes: boolean;
	/** `--hand-off`: an agent runs this and passes the owner's page on. */
	readonly handOff: boolean;
}

export type ProjectResolution =
	| { readonly ok: true; readonly projectDir: string; readonly source: string }
	| {
			readonly ok: false;
			readonly message: string;
			readonly remediation: readonly string[];
	  };

export interface PrepareInput {
	readonly action: "up";
	readonly projectDir: string;
	readonly whatIf: boolean;
	readonly yes: boolean;
	/**
	 * An agent runs this for the owner (`--hand-off`): a page the owner must
	 * see is served even without a terminal, and named on one progress line
	 * for the agent to pass on, instead of the run refusing.
	 */
	readonly handOff?: boolean;
	readonly run: CommandRunInput;
}

export type PrepareOutcome =
	| {
			readonly kind: "ready";
			readonly steps: readonly PreparedStep[];
			readonly credentials?: TrustedVault;
	  }
	| { readonly kind: "refused"; readonly result: CommandResult };

export interface PreparedStep {
	readonly id: string;
	readonly outcome: "created" | "unchanged" | "would-create";
	readonly detail: string;
}

export interface LifecycleFamilySpec {
	readonly family: string;
	readonly resolveProject: (
		input: CommandRunInput,
		flags: LifecycleFlags,
	) => ProjectResolution | Promise<ProjectResolution>;
	readonly up: CommandModule;
	readonly down: CommandModule;
	readonly plan: CommandModule;
	readonly prepare?: (input: PrepareInput) => Promise<PrepareOutcome>;
	readonly upWith?: (credentials: TrustedVault) => CommandModule;
	readonly status?: CommandModule;
	readonly fallback?: CommandModule;
}

const LIFECYCLE_FLAG_NAMES = new Set([
	"--what-if",
	"--dry-run",
	"--preview",
	"--mode",
	"--project",
	"--yes",
	"--hand-off",
	"-y",
]);

export function parseLifecycleArgs(
	args: readonly string[],
):
	| { readonly ok: true; readonly flags: LifecycleFlags }
	| { readonly ok: false; readonly message: string } {
	let whatIf = false;
	let yes = false;
	let handOff = false;
	let mode: string | null = null;
	let project: string | null = null;
	for (let index = 0; index < args.length; index += 1) {
		const raw = args[index] ?? "";
		const [token, inline] =
			raw.startsWith("--") && raw.includes("=")
				? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)]
				: [raw, undefined];
		if (!LIFECYCLE_FLAG_NAMES.has(token))
			return { ok: false, message: `Unknown option or argument "${raw}".` };
		if (
			inline !== undefined &&
			(token === "--what-if" ||
				token === "--dry-run" ||
				token === "--preview" ||
				token === "--yes" ||
				token === "--hand-off")
		)
			return { ok: false, message: `${token} does not take a value.` };
		if (token === "--what-if" || token === "--dry-run" || token === "--preview")
			whatIf = true;
		else if (token === "--yes" || token === "-y") yes = true;
		else if (token === "--hand-off") handOff = true;
		else {
			const value = inline ?? args[index + 1];
			if (value === undefined || value === "" || value.startsWith("-"))
				return { ok: false, message: `${token} requires a value.` };
			if (inline === undefined) index += 1;
			if (token === "--mode") mode = value;
			else project = value;
		}
	}
	if (mode !== null && mode !== "incremental" && mode !== "complete")
		return {
			ok: false,
			message: `--mode must be "incremental" or "complete", got "${mode}".`,
		};
	return { ok: true, flags: { whatIf, mode, project, yes, handOff } };
}

export function resolveFamilyProject(options: {
	readonly family: string;
	readonly flags: LifecycleFlags;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly bundled?: string | undefined;
}): ProjectResolution {
	const envName = `HOBO_${options.family.toUpperCase()}_PROJECT`;
	const candidates: { dir: string | undefined; source: string }[] = [
		{
			dir:
				options.flags.project === null
					? undefined
					: path.resolve(options.cwd, options.flags.project),
			source: "--project",
		},
		{
			dir:
				options.env[envName] === undefined || options.env[envName] === ""
					? undefined
					: path.resolve(options.cwd, options.env[envName] ?? ""),
			source: envName,
		},
		{ dir: options.bundled, source: "bundled" },
	];
	for (const candidate of candidates) {
		if (candidate.dir === undefined) continue;
		if (!existsSync(candidate.dir))
			return {
				ok: false,
				message: `hobo ${options.family}: project ${candidate.dir} (from ${candidate.source}) does not exist`,
				remediation: [
					`Point ${candidate.source} at a HoBo project directory (one with src/bindle.ts or hobo.bindle.json).`,
				],
			};
		return { ok: true, projectDir: candidate.dir, source: candidate.source };
	}
	if (hasBindle(options.cwd))
		return { ok: true, projectDir: options.cwd, source: "cwd" };
	return {
		ok: false,
		message: `hobo ${options.family}: no ${options.family} project found`,
		remediation: [
			`Pass --project <dir>, set ${envName}, or run inside the ${options.family} project.`,
		],
	};
}

function hasBindle(dir: string): boolean {
	return [
		"src/bindle.ts",
		"dist/bindle.js",
		"hobo.bindle.json",
		"bindle.ts",
	].some((file) => existsSync(path.join(dir, file)));
}

function usage(family: string, message: string): CommandResult {
	return {
		ok: false,
		status: "usage_error",
		code: "HOBO_USAGE",
		message: `hobo ${family}: ${message}`,
		remediation: [
			`Lifecycle: hobo ${family} up|down|plan|status [--what-if] [--mode incremental|complete] [--project <dir>] [--yes]`,
		],
		data: { command: family },
	};
}

function withFamily(
	result: CommandResult,
	family: string,
	action: LifecycleAction,
	project: { readonly projectDir: string; readonly source: string },
	extra: CommandData = {},
): CommandResult {
	return {
		...result,
		...(result.message !== undefined
			? {
					message: result.message.replace(
						/^hobo (up|down|plan)\b/,
						`hobo ${family} ${action}`,
					),
				}
			: undefined),
		data: {
			...result.data,
			family,
			action,
			project: project.projectDir,
			projectSource: project.source,
			...extra,
		},
	};
}

export function createLifecycleFamilyCommand(
	spec: LifecycleFamilySpec,
): CommandModule {
	return {
		implemented: true,
		run: async (input) => {
			const [action, ...rest] = input.args;
			if (action === undefined || !isLifecycleAction(action)) {
				if (spec.fallback) return spec.fallback.run(input);
				return usage(
					spec.family,
					action === undefined
						? "a subcommand is required."
						: `unknown subcommand "${action}".`,
				);
			}
			if (action === "status" && spec.status) return spec.status.run(input);
			const parsed = parseLifecycleArgs(rest);
			if (!parsed.ok) return usage(spec.family, parsed.message);
			const flags = parsed.flags;
			const project = await spec.resolveProject(input, flags);
			if (!project.ok)
				return {
					ok: false,
					status: "no_project",
					code: "HOBO_FAMILY_NO_PROJECT",
					message: project.message,
					remediation: [...project.remediation],
					data: { command: spec.family, action },
				};

			const delegated: CommandRunInput = {
				...input,
				verb: action === "status" ? "plan" : action,
				args: [],
				context: { ...input.context, projectDir: project.projectDir },
				flags: {
					...input.flags,
					cwd: project.projectDir,
					whatIf: flags.whatIf,
					mode: flags.mode,
				},
			};

			let prepared: readonly PreparedStep[] = [];
			let credentials: TrustedVault | undefined;
			try {
				if (action === "up" && spec.prepare) {
					const outcome = await spec.prepare({
						action: "up",
						projectDir: project.projectDir,
						whatIf: flags.whatIf,
						yes: flags.yes,
						handOff: flags.handOff,
						run: delegated,
					});
					if (outcome.kind === "refused")
						return withFamily(outcome.result, spec.family, action, project);
					credentials = outcome.credentials;
					prepared = outcome.steps;
					for (const step of prepared)
						input.emitProgress(
							`prepare ${step.id}: ${step.outcome} (${step.detail})`,
						);
				}

				// `status` and every `--what-if` are the read-only plan: the change set,
				// computed, printed, never applied.
				const module =
					action === "status" || (action === "up" && flags.whatIf)
						? spec.plan
						: action === "up"
							? credentials !== undefined && spec.upWith !== undefined
								? spec.upWith(credentials)
								: spec.up
							: action === "down"
								? spec.down
								: spec.plan;
				const result = await module.run(delegated);
				return withFamily(result, spec.family, action, project, {
					whatIf: flags.whatIf || action === "status" || action === "plan",
					...(flags.mode !== null ? { mode: flags.mode } : undefined),
					...(prepared.length > 0 ? { prepared } : undefined),
				});
			} finally {
				// The run's credentials end with the run.
				credentials?.clear();
			}
		},
	};
}
