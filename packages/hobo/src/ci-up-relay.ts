import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { runCiRelayDeploy } from "./ci-relay-deploy.js";
import { loadRelayJoinedYards, loadRelayYard } from "./ci-relay-yard.js";
import { parseJsonValue } from "./json.js";

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
				...joined.map((yard) => relayYardRegistryProvider(yard, relay)),
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
export function gitHead(
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
	return (async () => {
		const sha = await git(["rev-parse", "HEAD"]);
		if (!sha) return undefined;
		let ref = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
		if (!ref || ref === "HEAD") ref = await git(["branch", "--show-current"]);
		const envRef = process.env.GITHUB_HEAD_REF?.trim();
		if ((!ref || ref === "HEAD") && envRef) ref = envRef;
		if (!ref || ref === "HEAD") return undefined;
		return { ref, sha };
	})();
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

/** Materialize exactly the source tree a Git deployment will receive. */
export async function relayCommitSnapshot(
	relayDir: string,
	sha: string,
): Promise<{ dir: string; close(): Promise<void> }> {
	if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))
		throw new Error("The relay commit is not a complete Git object id.");
	const git = (args: readonly string[]): Promise<Buffer> =>
		new Promise((resolve, reject) =>
			execFile(
				"git",
				[...args],
				{
					cwd: relayDir,
					env: withoutSecretEnv(process.env),
					encoding: "buffer",
					maxBuffer: 32 * 1024 * 1024,
					timeout: 30_000,
				},
				(error, stdout) => {
					if (error) reject(error);
					else resolve(stdout);
				},
			),
		);
	const prefix = (await git(["rev-parse", "--show-prefix"]))
		.toString("utf8")
		.replace(/\r?\n$/u, "")
		.replace(/\/$/u, "");
	const tree = prefix.length === 0 ? sha : `${sha}:${prefix}`;
	const listing = await git(["ls-tree", "--full-tree", "-r", "-z", tree]);
	if (!Buffer.from(listing.toString("utf8"), "utf8").equals(listing))
		throw new Error("The committed relay tree contains a non-UTF-8 path.");
	// The scratch tree is outside the checkout so another Git operation cannot
	// accidentally stage it. Its dependency lookup uses the project's install.
	const root = await mkdtemp(path.join(tmpdir(), "hobo-ci-commit-"));
	try {
		const source = path.join(root, "source");
		await mkdir(source);
		let ancestor = path.resolve(relayDir);
		while (true) {
			const modules = path.join(ancestor, "node_modules");
			if (existsSync(modules)) {
				await symlink(
					modules,
					path.join(root, "node_modules"),
					process.platform === "win32" ? "junction" : "dir",
				);
				break;
			}
			const parent = path.dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
		const entries = listing.toString("utf8").split("\0").filter(Boolean);
		if (entries.length > 5_000)
			throw new Error("The committed relay tree is too large to inspect.");
		let total = 0;
		for (const entry of entries) {
			const tab = entry.indexOf("\t");
			const meta = entry
				.slice(0, tab)
				.match(/^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)$/u);
			const name = entry.slice(tab + 1);
			const parts = name.split("/");
			if (
				tab < 0 ||
				meta === null ||
				parts.some(
					(part) =>
						!part || part === "." || part === ".." || /[\\:]/u.test(part),
				)
			)
				throw new Error(
					"The committed relay tree contains an unsupported path or file type.",
				);
			const oid = meta[2];
			if (oid === undefined) throw new Error("Invalid Git tree entry.");
			const content = await git(["cat-file", "blob", oid]);
			total += content.length;
			if (total > 32 * 1024 * 1024)
				throw new Error("The committed relay tree is too large to inspect.");
			const destination = path.join(source, ...parts);
			await mkdir(path.dirname(destination), { recursive: true });
			await writeFile(destination, content, {
				mode: meta[1] === "100755" ? 0o755 : 0o644,
			});
		}
		return {
			dir: source,
			close: () => rm(root, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
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
			// A Git deployment uses head.sha, not the caller's possibly dirty
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
				return await (deps.deploy ?? runCiRelayDeploy)({
					cwd: snapshot.dir,
					values,
					env: deps.env ?? process.env,
					credentials,
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
