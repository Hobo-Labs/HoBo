import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import {
	type CommandModule,
	type CommandResult,
	createPlanCommand,
	type YardRuntime,
} from "@hobo/cli";
import { createRegistryFromProviders } from "@hobo/cloud";
import type { TrustedVault } from "@hobo/core";
import { withoutSecretEnv } from "@hobo/hobo-ci";

import { relayYardRegistryProvider } from "./ci-relay-delivery.js";
import { runCiRelayDeploy } from "./ci-relay-deploy.js";
import { loadRelayJoinedYards, loadRelayYard } from "./ci-relay-yard.js";

// `hobo ci up|plan` place the CI project through the relay's own Yards
// (`packages/ci-vercel/deploy/yard.ts`): the Vercel Yard that runs the relay as
// the Vercel project `hobo-ci`, and the Yards its junction joins (the config
// service, the non-Vercel caches). Those Yards are the catalog: their binding
// rows say which offering serves each resource (Vercel Functions, Queues,
// Cron Jobs and the Marketplace cache; the config service's secret
// projection), so the plan is the relay's real placement and not whatever
// providers happen to be registered on this machine.
//
// `up` then delivers that placement the way `hobo ci deploy` does: a git
// deployment of the current branch to the project's preview, through
// @hobo/cd, with the Vercel token `hobo cd up` keeps in the owner's secret
// store (read into the run's vault by the prepare step). Production stays an
// explicit promotion: `hobo ci deploy --target production --sha <commit>`.

/** The relay project for a CI project: itself when it declares the relay Yard, else the bundled ci-vercel beside it. */
export function relayProjectDirFor(projectDir: string): string | undefined {
	for (const candidate of [
		projectDir,
		path.join(projectDir, "..", "ci-vercel"),
	])
		if (existsSync(path.join(candidate, "deploy", "yard.ts")))
			return path.resolve(candidate);
	return undefined;
}

function refused(
	code: string,
	message: string,
	remediation: readonly string[],
): CommandResult {
	return {
		ok: false,
		status: "rejected",
		code,
		message,
		remediation,
		data: { command: "ci" },
	};
}

function projectOf(input: Parameters<CommandModule["run"]>[0]): string {
	return input.context.projectDir ?? input.flags.cwd ?? input.context.cwd;
}

/** `plan` (and `--what-if`) against the relay's Yards. */
export function createCiRelayPlanCommand(
	runtime: YardRuntime,
	fallback: CommandModule,
): CommandModule {
	return {
		implemented: true,
		async run(input) {
			const relayDir = relayProjectDirFor(projectOf(input));
			if (relayDir === undefined) return fallback.run(input);
			const relay = await loadRelayYard(relayDir);
			if (relay === undefined) return fallback.run(input);
			const joined = await loadRelayJoinedYards(relayDir, relay);
			const registry = createRegistryFromProviders([
				relayYardRegistryProvider(relay),
				...joined.map((yard) => relayYardRegistryProvider(yard, true)),
			]);
			input.emitProgress(
				`placing on the relay's Yards: ${[relay, ...joined].map((yard) => yard.name).join(", ")}`,
			);
			return createPlanCommand({ runtime: { ...runtime, registry } }).run(
				input,
			);
		},
	};
}

/** The current branch and commit of the repository holding `dir`. */
function gitHead(
	dir: string,
): Promise<{ ref: string; sha: string } | undefined> {
	const git = (args: readonly string[]) =>
		new Promise<string | undefined>((resolve) =>
			execFile(
				"git",
				[...args],
				{ cwd: dir, env: withoutSecretEnv(process.env) },
				(error, stdout) => resolve(error ? undefined : String(stdout).trim()),
			),
		);
	return Promise.all([
		git(["rev-parse", "--abbrev-ref", "HEAD"]),
		git(["rev-parse", "HEAD"]),
	]).then(([ref, sha]) =>
		ref && sha && ref !== "HEAD" ? { ref, sha } : undefined,
	);
}

export interface CiRelayUpDeps {
	readonly deploy?: typeof runCiRelayDeploy;
	readonly head?: typeof gitHead;
	readonly env?: NodeJS.ProcessEnv;
}

/** `up`: deliver the current branch to the relay's Vercel preview. */
export function createCiRelayUpCommand(
	credentials: TrustedVault,
	fallback: CommandModule,
	deps: CiRelayUpDeps = {},
): CommandModule {
	return {
		implemented: true,
		async run(input) {
			const relayDir = relayProjectDirFor(projectOf(input));
			if (relayDir === undefined) return fallback.run(input);
			if (!credentials.has("VERCEL_TOKEN"))
				return refused(
					"HOBO_CI_UP_VERCEL_NOT_CONNECTED",
					"The relay deploys to the Vercel project hobo-ci, and no Vercel connection is in your secret store.",
					[
						"Run hobo cd up once: it connects HoBo's Vercel account and keeps the token in your secret store, where hobo ci up reads it.",
					],
				);
			const head = await (deps.head ?? gitHead)(relayDir);
			if (head === undefined)
				return refused(
					"HOBO_CI_UP_NO_BRANCH",
					"hobo ci up deploys the current branch, and this checkout is not on one.",
					[
						"Check out the branch to deploy (pushed to GitHub), or use hobo ci deploy --ref <ref>.",
					],
				);
			input.emitProgress(
				`delivering ${head.ref}@${head.sha.slice(0, 12)} to the relay's preview on Vercel`,
			);
			return (deps.deploy ?? runCiRelayDeploy)({
				cwd: relayDir,
				values: { ref: head.ref, sha: head.sha, target: "preview" },
				env: deps.env ?? process.env,
				credentials,
				emitProgress: input.emitProgress,
			});
		},
	};
}
