/**
 * `hobo deploy` — continuous delivery through `@hobo/cd` (plan 0024, C2).
 *
 * Every CD subcommand (`freight`, `source`, `pipeline`, `window`, `promote`,
 * `status`, `logs`, `rollback`, `reconcile`, `preview`, `verify`, `agent`,
 * `publisher`, `metrics`, `campset`, `camp`, `placement`, `scores`,
 * `fanout`, `failover`, `rebalance`, `compliance`) runs against the one
 * composed CD runtime (`cd-runtime.ts`). `--simulate` is the only path to a
 * fixture, and every simulated result says so. `hosting-*` supervision of a
 * production hosting execution is kept unchanged.
 */

import type { Outcome } from "@hobo/cd";
import type { CommandModule, CommandResult } from "@hobo/cli";
import { HostingTransitionPhase } from "@hobo/cloud";
import {
	type CdDeployHost,
	cdDeployUsage,
	runCdDeploySubcommand,
} from "./cd-deploy.js";
import { cdRefused, parseCdFormat } from "./cd-render.js";
import { defaultHoboHome } from "./hobo-home.js";
import type { createProductionHostingExecution } from "./hosting-execution.js";
import { isJsonString, type JsonObject } from "./json.js";

/** A composed CD host for one command, closed after it runs. */
export type OpenedCdHost = Readonly<{
	host: CdDeployHost;
	close(): Promise<void>;
}>;

export type CdHostOpener = (
	input: Readonly<{
		simulate: boolean;
		cwd: string;
		env: Readonly<Record<string, string | undefined>>;
		home: string;
	}>,
) => Promise<Outcome<OpenedCdHost>>;

export interface DeployCommandDeps {
	readonly hosting?:
		| ReturnType<typeof createProductionHostingExecution>
		| undefined;
	readonly env?: NodeJS.ProcessEnv;
	readonly hoboHome?: string;
	/** Open the composed CD host; default opens `cd-runtime.ts` (SQLite under HOBO_HOME). */
	readonly openCd?: CdHostOpener;
}

/** The default opener: the one composed CD runtime. */
export const openDefaultCdHost: CdHostOpener = async (input) => {
	const { openCdRuntime } = await import("./cd-runtime.js");
	const runtime = await openCdRuntime({
		env: input.env,
		home: input.home,
		cwd: input.cwd,
		simulate: input.simulate,
	});
	if (!runtime.ok) return runtime;
	return {
		ok: true,
		value: { host: runtime.value.host, close: runtime.value.close },
	};
};

export function isSimulate(flags: JsonObject): boolean {
	return flags.simulate === true || flags.simulate === "true";
}

async function hostingSubcommand(
	deps: DeployCommandDeps,
	args: readonly string[],
): Promise<CommandResult> {
	const deploymentId = args[1];
	if (!deps.hosting || !deploymentId)
		return {
			ok: false,
			status: "rejected",
			code: "HOBO_HOSTING_NOT_CONFIGURED",
			message:
				"hosting supervision requires an authenticated configured runtime and deployment ID",
			remediation: [
				"hobo deploy hosting-status <deployment-id> (with a production hosting runtime)",
			],
		};
	const sub = args[0];
	const state =
		sub === "hosting-status"
			? await deps.hosting.status(deploymentId)
			: sub === "hosting-resume"
				? await deps.hosting.resumeDeployment(deploymentId)
				: sub === "hosting-cancel"
					? await deps.hosting.cancel(deploymentId)
					: sub === "hosting-resume-mutation"
						? await deps.hosting.resumeMutation(deploymentId)
						: undefined;
	if (!state)
		return {
			ok: false,
			status: "rejected",
			code: "HOBO_HOSTING_UNKNOWN",
			message: "unknown hosting deployment or subcommand",
			remediation: [
				"hobo deploy hosting-status|hosting-resume|hosting-cancel|hosting-resume-mutation <deployment-id>",
			],
		};
	return {
		ok: true,
		status: "ok",
		code: "HOBO_HOSTING_STATUS",
		message: HostingTransitionPhase[state.phase],
		data: {
			deploymentId,
			transitionId: state.plan?.transitionId,
			phase: HostingTransitionPhase[state.phase],
			version: state.version,
			reservationId: state.reservationId,
			nextObservationAtMs: state.operation?.nextObservationAtMs,
			blockedReason: state.blockedReason,
		},
	};
}

export function createDeployCommand(
	deps: DeployCommandDeps = {},
): CommandModule {
	return {
		run: async ({ args, flags, context }) => {
			if (args[0]?.startsWith("hosting-")) return hostingSubcommand(deps, args);
			// SAFETY: assertion required at this I/O or test boundary.
			const f = flags as unknown as JsonObject;
			if (args.length === 0 || args[0] === "help" || f.help === true)
				return {
					ok: true,
					status: "ok",
					code: "HOBO_DEPLOY_HELP",
					message: [
						"hobo deploy <subcommand> [--format json|text] [--simulate]",
						...cdDeployUsage(),
					].join("\n"),
					remediation: [...cdDeployUsage()],
					data: { command: "deploy", subcommands: [...cdDeployUsage()] },
				};
			const env = deps.env ?? process.env;
			const simulate = isSimulate(f);
			const format = parseCdFormat(f);
			const opened = await (deps.openCd ?? openDefaultCdHost)({
				simulate,
				cwd: (isJsonString(f.cwd) && f.cwd) || context.cwd,
				env,
				home: deps.hoboHome ?? defaultHoboHome(env),
			});
			if (!opened.ok)
				return cdRefused({
					reasons: opened.reasons,
					subcommand: args.join(" "),
					format: format.ok ? format.format : "text",
				});
			try {
				return await runCdDeploySubcommand(opened.value.host, args, f);
			} finally {
				await opened.value.close();
			}
		},
	};
}
