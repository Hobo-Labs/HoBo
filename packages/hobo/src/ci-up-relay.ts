import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
	type CommandModule,
	type CommandResult,
	compileProjectManifest,
	createPlanCommand,
	type YardRuntime,
} from "@hobo/cli";
import { createRegistryFromProviders, lowerManifest } from "@hobo/cloud";
import type { TrustedVault } from "@hobo/core";
import { withoutSecretEnv } from "@hobo/hobo-ci";
import { vercelPlatformDrift } from "@hobo/provider-vercel";

import { relayYardRegistryProvider } from "./ci-relay-delivery.js";
import type { runCiRelayDeploy } from "./ci-relay-deploy.js";
import { runCiRelayManaged } from "./ci-relay-managed.js";
import { relayCommitSnapshot } from "./ci-relay-snapshot.js";

export { relayCommitSnapshot } from "./ci-relay-snapshot.js";

import { loadRelayJoinedYards, loadRelayYard } from "./ci-relay-yard.js";
import { parseJsonValue } from "./json.js";
import { loadOwnerDeployCredentials } from "./owner-deploy-credentials.js";

// `hobo ci up|plan` place the CI project through the relay's own Yards
// (`packages/ci-vercel/deploy/yard.ts`): the Vercel Yard that runs the relay as
// the Vercel project `hobo-ci`, and the Yards its junction joins (the config
// service, the non-Vercel caches). Those Yards are the catalog: their binding
// rows say which offering serves each resource (Vercel Functions, Queues,
// Cron Jobs and the Marketplace cache; the config service's secret
// projection), so the plan is the relay's real placement and not whatever
// providers happen to be registered on this machine.
//

// deployment of the current branch to the project's preview, through
// @hobo/cd, with the Vercel token `hobo cd up` keeps in the owner's secret
// store (read into the run's vault by the prepare step). Production stays an

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

/**
 * How the relay's vercel.json differs from its plan: the Bindle lowered to
 * intents (queues, and the schedule with its cadence), checked against the
 * platform configuration in that directory (`vercelPlatformDrift`).
 */
export async function relayPlatformDrift(
	relayDir: string,
	/** Test seam: the platform configuration's text. */
	readConfig: () => Promise<string> = () =>
		readFile(path.join(relayDir, "vercel.json"), "utf8"),
): Promise<readonly string[]> {
	const manifest = await compileProjectManifest(relayDir);
	if (manifest === null) return ["the relay project has no loadable Bindle"];
	const config = parseJsonValue(await readConfig());
	return vercelPlatformDrift(config, lowerManifest(manifest));
}

/** Check a Git commit's declaration and platform configuration. */
export async function relayCommitPlatformDrift(
	relayDir: string,
	sha: string,
): Promise<readonly string[]> {
	const snapshot = await relayCommitSnapshot(relayDir, sha);
	try {
		return await relayPlatformDrift(snapshot.dir);
	} finally {
		await snapshot.close().catch(() => undefined);
	}
}

export interface CiRelayUpDeps {
	readonly deploy?: typeof runCiRelayDeploy;
	readonly head?: typeof gitHead;
	readonly snapshot?: typeof relayCommitSnapshot;
	readonly platformDrift?: typeof relayPlatformDrift;
	readonly env?: NodeJS.ProcessEnv;
	readonly ownerSession?: TrustedVault;
	readonly ownerSettings?: Parameters<
		typeof loadOwnerDeployCredentials
	>[0]["ownerSettings"];
	readonly openOwnerStore?: Parameters<
		typeof loadOwnerDeployCredentials
	>[0]["open"];
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
			if (deps.ownerSettings || deps.ownerSession) {
				credentials.drop("VERCEL_TOKEN");
				credentials.drop("VERCEL_TEAM_ID");
			}
			await loadOwnerDeployCredentials({
				cwd: input.context.cwd,
				env: deps.env ?? process.env,
				credentials,
				...(deps.ownerSession
					? { ownerSession: deps.ownerSession }
					: undefined),
				...(deps.ownerSettings
					? { ownerSettings: deps.ownerSettings }
					: undefined),
				...(deps.openOwnerStore ? { open: deps.openOwnerStore } : undefined),
			});
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
						"Check out a local branch, or use hobo ci deploy --managed --ref <ref> --sha <full-commit>.",
					],
				);

			// checkout. Plan and check that exact commit before delivery.
			let snapshot: Awaited<ReturnType<typeof relayCommitSnapshot>>;
			try {
				snapshot = await (deps.snapshot ?? relayCommitSnapshot)(
					relayDir,
					head.sha,
				);
			} catch {
				return refused(
					"HOBO_CI_UP_SOURCE_UNAVAILABLE",
					"Cannot inspect the relay's committed source before deployment.",
					[
						"Make the selected commit and its project dependencies available locally, then retry.",
					],
				);
			}
			try {
				let drift: readonly string[];
				try {
					drift = await (deps.platformDrift ?? relayPlatformDrift)(
						snapshot.dir,
					);
				} catch {
					return refused(
						"HOBO_CI_UP_SOURCE_UNAVAILABLE",
						"Cannot inspect the relay's committed source before deployment.",
						[
							"Make the selected commit and its project dependencies available locally, then retry.",
						],
					);
				}
				if (drift.length > 0)
					return refused(
						"HOBO_CI_UP_PLATFORM_DRIFT",
						`The relay's committed vercel.json does not hold what its plan asks: ${drift.join("; ")}.`,
						[
							"Commit a vercel.json that matches the relay's Bindle, then run hobo ci up again.",
						],
					);
				input.emitProgress(
					`delivering ${head.ref}@${head.sha.slice(0, 12)} to the relay's preview on Vercel`,
				);
				const team = credentials.reveal("VERCEL_TEAM_ID");
				const values = {
					ref: head.ref,
					sha: head.sha,
					target: "preview",
					team,
				};
				if (deps.deploy !== undefined)
					return await deps.deploy({
						cwd: snapshot.dir,
						values,
						env: deps.env ?? process.env,
						credentials,
						emitProgress: input.emitProgress,
					});
				return await runCiRelayManaged({
					cwd: relayDir,
					values: { ref: head.ref, sha: head.sha, target: "preview" },
					env: deps.env ?? process.env,
					credentials,
					...(deps.ownerSession
						? { ownerSession: deps.ownerSession }
						: undefined),
					emitProgress: input.emitProgress,
				});
			} finally {
				// Cleanup cannot turn an accepted deployment into an ambiguous
				// failure that a caller might retry.
				await snapshot.close().catch(() => undefined);
			}
		},
	};
}
