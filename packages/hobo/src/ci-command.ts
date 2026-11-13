import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, promisify } from "node:util";
import type { JsonValue } from "@bufbuild/protobuf";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { loadCiProjectFromDirectory } from "@hobo/ci-gh-actions/cli-serve";
import {
	CiRelayClientError,
	createCiRelayClient,
} from "@hobo/ci-gh-actions/client";
import {
	type CommandModule,
	type CommandResult,
	verbHelpText,
	type YardRuntime,
} from "@hobo/cli";
import type { Outcome } from "@hobo/fleet";
import { CiRepositoryLinkSchema } from "./_generated/composition_pb.js";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { runCiAppCreate, runCiAppDeposit } from "./ci-app-create.js";
import { runCiConnect } from "./ci-connect.js";
import { runGithubCeremony } from "./ci-github-connect.js";
import { importGithubKey, storedGithubKey } from "./ci-github-keys.js";
import {
	CI_DEPLOY_ONLY_OPTIONS,
	CI_DEPLOY_OPTIONS,
	runCiRelayDeploy,
} from "./ci-relay-deploy.js";
import type { VercelCliRunner } from "./ci-relay-provision.js";
import { runCiRuns } from "./ci-runs.js";
import {
	CI_SECRET_STORE_OPTIONS,
	runCiSecretStore,
	SECRET_STORE_ONLY_OPTIONS,
} from "./ci-secret-store.js";
import { type CiServeOptions, runCiServe } from "./ci-serve.js";
import { fleetViews } from "./fleet-command.js";
import { createFleetRuntime } from "./fleet-runtime.js";
import { fleetStatusTable, type NamedFleetView } from "./fleet-status.js";
import type { VercelFetch } from "./vercel-client.js";

const execute = promisify(execFile);
type CiLink = ReturnType<typeof create<typeof CiRepositoryLinkSchema>>;
type CiOptions = Record<string, string | boolean | string[] | undefined>;

import { ciRepositoryFromRemote, validRepository } from "./ci-repository.js";

export { ciRepositoryFromRemote };

import { CiSetupUsage } from "./ci-command-errors.js";

class CiLinkSaveError extends Error {}

export const CI_HELP = verbHelpText("ci", { implemented: true });

async function promptOnTerminal(question: string): Promise<string> {
	const terminal = createInterface({
		input: process.stdin,
		output: process.stderr,
	});
	try {
		return await terminal.question(question);
	} finally {
		terminal.close();
	}
}

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

/** Where `hobo ci status` reads the fleet table from (`hobo fleet status`). */
export type CiFleetStatus = () => Promise<
	Outcome<readonly NamedFleetView[]> | undefined
>;

/**
 * `hobo fleet status` for `hobo ci status`: every fleet the signed-in person
 * can read, when a fleet authority is configured (HOBO_FLEET_AUTHORITY_URL).
 * Undefined when none is, so the CI answer stands alone.
 */
function defaultFleetStatus(env: NodeJS.ProcessEnv): CiFleetStatus {
	return async () => {
		if (!env.HOBO_FLEET_AUTHORITY_URL) return undefined;
		const client = await createFleetRuntime({
			env,
			progress: () => undefined,
		}).client({ kind: "person" });
		return client.ok ? fleetViews(client.value, undefined) : client;
	};
}

/** The fleet section of `hobo ci status`: the table, or why there is none; undefined with no authority. */
async function fleetSection(
	status: CiFleetStatus,
): Promise<Readonly<{ message: string; data: JsonValue }> | undefined> {
	const views = await status().catch(() => undefined);
	if (views === undefined) return undefined;
	if (!views.ok)
		return {
			message: `Fleet status unavailable: ${views.error.message}`,
			data: { error: views.error.code },
		};
	return {
		message: fleetStatusTable(views.value),
		data: views.value.map((entry) => ({
			fleet: entry.fleet,
			members: entry.view?.members.length ?? 0,
			freeSlots: entry.view?.capacity?.freeSlots ?? 0,
			totalSlots: entry.view?.capacity?.totalSlots ?? 0,
		})),
	};
}

/**
 * `hobo ci status` with no relay to ask: the fleet status, when a fleet
 * authority is configured. Nothing when it is not, so the caller gives its
 * usual answer.
 */
async function offlineStatus(
	status: CiFleetStatus,
	why: string,
): Promise<CommandResult | undefined> {
	const fleet = await fleetSection(status);
	if (!fleet) return undefined;
	return {
		message: `${why}\n${fleet.message}`,
		data: { source: "fleet", fleet: fleet.data },
	};
}

function trustedOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new CiSetupUsage("Select a valid HTTPS relay origin.");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new CiSetupUsage(
			"Select an HTTPS relay origin without a path or credentials.",
		);
	return url.origin;
}

function relayOriginFromProject(
	value: string,
	allowInsecureLoopback: boolean,
): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new CiSetupUsage(
			"Select a valid relay origin from CI project config.",
		);
	}
	const loopback =
		allowInsecureLoopback &&
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1");
	if (
		(!loopback && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new CiSetupUsage(
			"CI project relay origin must be HTTPS or loopback HTTP with allowInsecureLoopback.",
		);
	return url.origin;
}

function parseSavedRelayOrigin(value: string): string {
	try {
		return trustedOrigin(value);
	} catch {
		return relayOriginFromProject(value, true);
	}
}

async function boundedText(path: string, limit: number): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > limit) throw new Error("Invalid file.");
		const buffer = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await file.read(buffer, size, buffer.length - size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > limit) throw new Error("Invalid file.");
		return buffer.subarray(0, size).toString("utf8");
	} finally {
		await file.close();
	}
}

async function readLink(path: string): Promise<CiLink | undefined> {
	try {
		const link = fromJsonString(
			CiRepositoryLinkSchema,
			await boundedText(path, 8192),
		);
		link.relayOrigin = parseSavedRelayOrigin(link.relayOrigin);
		if (
			!/^[A-Za-z0-9_-]{1,80}$/.test(link.accountId) ||
			!validRepository(link.repository)
		)
			throw new Error("Invalid CI link.");
		return link;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw new CiSetupUsage(
			"The saved CI link is invalid. Run hobo ci enable with --relay and --repo to reconnect.",
		);
	}
}

async function saveLink(
	directory: string,
	path: string,
	link: CiLink,
): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(
			temporary,
			`${toJsonString(CiRepositoryLinkSchema, link)}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		await rename(temporary, path);
	} catch {
		throw new CiLinkSaveError();
	} finally {
		try {
			await rm(temporary, { force: true });
		} catch {
			/* Preserve the failed save, not a cleanup error. */
		}
	}
}

function parseCiArgs(args: readonly string[]) {
	return parseArgs({
		args: [...args],
		allowPositionals: true,
		strict: true,
		options: {
			relay: { type: "string" },
			config: { type: "string" },
			environment: { type: "string" },
			repo: { type: "string" },
			remote: { type: "string" },
			"token-file": { type: "string" },
			home: { type: "string" },
			"installation-id": { type: "string" },
			"app-id": { type: "string" },
			"key-file": { type: "string" },
			"webhook-secret-file": { type: "string" },
			yes: { type: "boolean", short: "y" },
			"non-interactive": { type: "boolean" },
			"accept-all-matching-jobs": { type: "boolean" },
			"git-branch": { type: "string" },
			branch: { type: "string" },
			"all-branches": { type: "boolean" },
			commit: { type: "string" },
			status: { type: "string" },
			limit: { type: "string" },
			next: { type: "string" },
			attempt: { type: "string" },
			wait: { type: "boolean" },
			failed: { type: "boolean" },
			task: { type: "string", multiple: true },
			level: { type: "string", multiple: true },
			grep: { type: "string" },
			follow: { type: "boolean", short: "f" },
			runs: { type: "string" },
			host: { type: "string" },
			port: { type: "string" },
			url: { type: "string" },
			endpoint: { type: "string" },
			admission: { type: "string" },
			"allow-insecure": { type: "boolean" },
			"with-worker": { type: "boolean" },
			"no-agent": { type: "boolean" },
			"print-config": { type: "boolean" },
			origin: { type: "string" },
			"base-url": { type: "string" },
			"trust-proxy": { type: "boolean" },
			db: { type: "string" },
			engine: { type: "string", multiple: true },
			auth: { type: "string" },
			"secret-ref": { type: "string" },
			"project-id": { type: "string" },
			org: { type: "string" },
			"runs-on": { type: "string", multiple: true },
			id: { type: "string" },
			"dry-run": { type: "boolean" },
			launch: { type: "boolean" },
			ref: { type: "string" },
			sha: { type: "string" },
			project: { type: "string" },
			target: { type: "string" },
			team: { type: "string" },
			set: { type: "string", multiple: true },
			"root-directory": { type: "string" },
			"create-project": { type: "boolean" },
			provision: { type: "boolean" },
			"owner-id": { type: "string" },
			name: { type: "string" },
			"auth-md": { type: "string", multiple: true },
			"fleet-host": { type: "string" },
			"owner-email": { type: "string" },
			"vercel-team-slug": { type: "string" },
			"vercel-project-id": { type: "string" },
			"allow-designed": { type: "boolean" },
			"deploy-project-id": { type: "string" },
			"relay-identity-id": { type: "string" },
			"deploy-identity-id": { type: "string" },
			"site-url": { type: "string" },
			"via-workflow": { type: "boolean" },
		},
	});
}

function ciServeOptions(values: CiOptions): CiServeOptions {
	type MutableServeOptions = {
		-readonly [K in keyof CiServeOptions]: CiServeOptions[K];
	};
	const engines = values.engine;
	const options: MutableServeOptions = {};
	if (values.host !== undefined) options.host = String(values.host);
	if (values.port !== undefined) options.port = String(values.port);
	if (values.url !== undefined) options.url = String(values.url);
	if (values.endpoint !== undefined) options.endpoint = String(values.endpoint);
	if (values.origin !== undefined) options.origin = String(values.origin);
	if (values["base-url"] !== undefined)
		options.baseUrl = String(values["base-url"]);
	if (values["trust-proxy"] === true) options.trustProxy = true;
	if (values.environment !== undefined)
		options.environment = String(values.environment);
	if (values.config !== undefined) options.config = String(values.config);
	if (values.admission !== undefined)
		options.admission = String(values.admission);
	if (values["allow-insecure"] === true) options.allowInsecure = true;
	if (values["with-worker"] === true) options.withWorker = true;
	if (values["no-agent"] === true) options.noAgent = true;
	if (values["print-config"] === true) options.printConfig = true;
	if (values.repo !== undefined) options.repo = String(values.repo);
	if (values.remote !== undefined) options.remote = String(values.remote);
	if (values["installation-id"] !== undefined)
		options.installationId = String(values["installation-id"]);
	if (values.home !== undefined) options.home = String(values.home);
	if (values.db !== undefined) options.db = String(values.db);
	if (Array.isArray(engines) && engines.length > 0)
		options.engines = engines.map(String);
	return options;
}

export function createCiCommand(
	deps: {
		env?: NodeJS.ProcessEnv;
		fetch?: typeof fetch;
		interactive?: boolean;
		prompt?: (question: string) => Promise<string>;
		git?: (args: readonly string[], cwd: string) => Promise<string>;
		openBrowser?: (url: string) => void;
		sleep?: (ms: number) => Promise<void>;
		now?: () => number;
		/** The Vercel transport of `hobo ci deploy`; the global fetch when absent. */
		vercelFetch?: VercelFetch;
		/** The Vercel CLI `hobo ci deploy --provision` runs; spawned when absent. */
		vercelCli?: VercelCliRunner;
		/** The Yard runtime `hobo ci secret-store provision` records its claim in. */
		runtime?: YardRuntime;
		/** The fleet table under `hobo ci status`; `hobo fleet status` against HOBO_FLEET_AUTHORITY_URL when absent. */
		fleetStatus?: CiFleetStatus;
	} = {},
): CommandModule {
	return {
		implemented: true,
		async run({ args, flags, emitProgress }) {
			if (args.length === 0) return { message: CI_HELP };
			let parsed: ReturnType<typeof parseCiArgs>;
			try {
				parsed = parseCiArgs(args);
			} catch {
				return usage(
					"Invalid CI arguments. Run hobo ci --help for commands and options.",
				);
			}
			const { values } = parsed;
			const githubConnect =
				parsed.positionals[0] === "connect" &&
				parsed.positionals[1] === "github";
			if (githubConnect && parsed.positionals.length !== 2)
				return usage(
					"hobo ci connect github takes no additional positional arguments.",
				);
			const positionals = githubConnect
				? ["connect", ...parsed.positionals.slice(2)]
				: parsed.positionals;
			const command = positionals[0] ?? "";
			if (
				![
					"enable",
					"connect",
					"status",
					"list",
					"ls",
					"inspect",
					"logs",
					"grep",
					"rerun",
					"serve",
					"github",
					"deploy",
					"app",
					"secret-store",
				].includes(command)
			)
				return usage("Unknown CI command. Run hobo ci --help.");
			if (command === "deploy") {
				if (positionals.length !== 1)
					return usage("hobo ci deploy takes no positional arguments.");
				const allowed = new Set<string>(CI_DEPLOY_OPTIONS);
				const unsupported = Object.entries(values).find(
					([key, value]) => value !== undefined && !allowed.has(key),
				);
				if (unsupported)
					return usage(`--${unsupported[0]} does not apply to hobo ci deploy.`);
				return runCiRelayDeploy({
					cwd: flags.cwd,
					values,
					env: deps.env ?? process.env,
					...(deps.vercelFetch !== undefined
						? { fetch: deps.vercelFetch }
						: undefined),
					...(deps.vercelCli !== undefined
						? { runVercelCli: deps.vercelCli }
						: undefined),
					...(deps.sleep !== undefined ? { sleep: deps.sleep } : undefined),
					...(deps.now !== undefined ? { now: deps.now } : undefined),
					emitProgress,
				});
			}
			if (command === "secret-store") {
				if (positionals.length !== 2)
					return usage(
						"Use hobo ci secret-store plan, provision, connect or verify.",
					);
				const allowed = new Set<string>(CI_SECRET_STORE_OPTIONS);
				const unsupported = Object.entries(values).find(
					([key, value]) => value !== undefined && !allowed.has(key),
				);
				if (unsupported)
					return usage(
						`--${unsupported[0]} does not apply to hobo ci secret-store.`,
					);
				return runCiSecretStore({
					subcommand: positionals[1] ?? "",
					cwd: flags.cwd,
					values,
					env: deps.env ?? process.env,
					...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
					...(deps.runtime !== undefined
						? { runtime: deps.runtime }
						: undefined),
					interactive:
						(deps.interactive ??
							Boolean(process.stdin.isTTY && process.stderr.isTTY)) &&
						!flags.json,
					prompt: deps.prompt ?? promptOnTerminal,
					...(deps.now !== undefined ? { now: deps.now } : undefined),
				});
			}
			for (const key of SECRET_STORE_ONLY_OPTIONS) {
				if (values[key] !== undefined)
					return usage(`--${key} only applies to hobo ci secret-store.`);
			}
			{
				const misplaced = CI_DEPLOY_ONLY_OPTIONS.find(
					(key) => values[key] !== undefined,
				);
				if (misplaced)
					return usage(`--${misplaced} only applies to hobo ci deploy.`);
			}
			if (command === "app") {
				if (
					positionals.length !== 2 ||
					(positionals[1] !== "create" && positionals[1] !== "deposit")
				)
					return usage("Use hobo ci app create (or deposit, in the workflow).");
				if (positionals[1] === "deposit")
					return runCiAppDeposit({
						cwd: flags.cwd,
						relay:
							values.relay === undefined ? undefined : String(values.relay),
						ownerId:
							values["owner-id"] === undefined
								? undefined
								: String(values["owner-id"]),
						env: deps.env ?? process.env,
						emitProgress,
						fetch: deps.fetch,
						sleep: deps.sleep,
					});
				const allowed = new Set([
					"relay",
					"owner-id",
					"name",
					"yes",
					"non-interactive",
					"via-workflow",
				]);
				const unsupported = Object.entries(values).find(
					([key, value]) => value !== undefined && !allowed.has(key),
				);
				if (unsupported)
					return usage(
						`--${unsupported[0]} does not apply to hobo ci app create.`,
					);
				const interactive =
					(deps.interactive ??
						Boolean(process.stdin.isTTY && process.stderr.isTTY)) &&
					!flags.json &&
					!values["non-interactive"];
				return runCiAppCreate({
					relay: values.relay === undefined ? undefined : String(values.relay),
					ownerId:
						values["owner-id"] === undefined
							? undefined
							: String(values["owner-id"]),
					name: values.name === undefined ? undefined : String(values.name),
					replace: values.yes === true,
					viaWorkflow: values["via-workflow"] === true,
					interactive,
					env: deps.env ?? process.env,
					emitProgress,
					fetch: deps.fetch,
					openBrowser: deps.openBrowser,
					prompt: deps.prompt ?? promptOnTerminal,
					sleep: deps.sleep,
				});
			}
			for (const key of ["owner-id", "name"] as const) {
				if (values[key] !== undefined)
					return usage(`--${key} only applies to hobo ci app create.`);
			}
			if (command === "github") {
				if (
					positionals.length !== 2 ||
					!["import-key", "key-status"].includes(positionals[1] ?? "")
				)
					return usage(
						"Use hobo ci github import-key or hobo ci github key-status.",
					);
				const allowed =
					positionals[1] === "import-key"
						? new Set(["home", "app-id", "key-file", "webhook-secret-file"])
						: new Set(["home"]);
				const unsupported = Object.entries(values).find(
					([key, value]) => value !== undefined && !allowed.has(key),
				);
				if (unsupported)
					return usage(
						`--${unsupported[0]} does not apply to hobo ci github ${positionals[1]}.`,
					);
				const env = deps.env ?? process.env;
				const home = resolve(flags.cwd, values.home ?? defaultHoboHome(env));
				try {
					if (positionals[1] === "key-status") {
						const stored = await storedGithubKey(home);
						return stored
							? {
									message: `Self-hosted GitHub App ${stored.appId} has a stored key. Restart hobo ci serve after changing keys.`,
									data: { appId: stored.appId, configured: true },
								}
							: {
									message:
										"No self-hosted GitHub App key is stored in this HoBo home.",
									data: { configured: false },
								};
					}
					if (
						!values["app-id"] ||
						!values["key-file"] ||
						!values["webhook-secret-file"]
					)
						return usage(
							"Import requires --app-id, --key-file, and --webhook-secret-file; supply file paths, never secret values.",
						);
					await importGithubKey({
						home,
						appId: String(values["app-id"]),
						keyFile: resolve(flags.cwd, String(values["key-file"])),
						webhookSecretFile: resolve(
							flags.cwd,
							String(values["webhook-secret-file"]),
						),
						fetch: deps.fetch,
					});
					return {
						message:
							"GitHub App key verified and saved for the self-hosted relay. Restart hobo ci serve; retain the previous GitHub key until all relay and worker processes have restarted.",
					};
				} catch {
					return {
						ok: false,
						code: "HOBO_CI_GITHUB_KEY_ERROR",
						message:
							"Could not verify or store the GitHub App key. Check the App ID, credential files, GitHub access, and that HoBo home is private and outside the repository.",
					};
				}
			}
			for (const key of [
				"app-id",
				"key-file",
				"webhook-secret-file",
			] as const) {
				if (values[key] !== undefined)
					return usage(`--${key} only applies to hobo ci github import-key.`);
			}
			if (command === "serve") {
				if (positionals.length !== 1)
					return usage("hobo ci serve takes no positional arguments.");
				const env = deps.env ?? process.env;
				const gitEnv = { ...env };
				delete gitEnv.HOBO_CI_ACCOUNT_TOKEN;
				delete gitEnv.HOBO_CI_ACCOUNT_TOKEN_FILE;
				const git =
					deps.git ??
					(async (gitArgs: readonly string[], cwd: string) => {
						const result = await execute("git", [...gitArgs], {
							cwd,
							timeout: 10000,
							maxBuffer: 65536,
							env: gitEnv,
						});
						return result.stdout.trim();
					});
				let root = flags.cwd;
				try {
					root = await git(["rev-parse", "--show-toplevel"], flags.cwd);
				} catch {
					if (!values.repo)
						return usage(
							"Run from a GitHub repository or pass --repo owner/name.",
						);
				}
				return runCiServe({
					cwd: root,
					options: ciServeOptions(values),
					env,
					git,
					emitProgress,
				});
			}
			const integrationKeys = [
				"auth",
				"secret-ref",
				"project-id",
				"org",
				"runs-on",
				"id",
				"dry-run",
				"launch",
			];
			if (command === "connect" && positionals.length >= 2) {
				if (positionals.length !== 2)
					return usage(
						"hobo ci connect takes one provider: github, blacksmith, depot, jog or boat.",
					);
				const allowed = new Set([...integrationKeys, "config"]);
				const ignored = Object.entries(values).find(
					([key, value]) => value !== undefined && !allowed.has(key),
				);
				if (ignored)
					return usage(
						`--${ignored[0]} does not apply to hobo ci connect <provider>.`,
					);
				let root = flags.cwd;
				try {
					root = await (
						deps.git ??
						(async (gitArgs: readonly string[], cwd: string) =>
							(
								await execute("git", [...gitArgs], { cwd, timeout: 10000 })
							).stdout.trim())
					)(["rev-parse", "--show-toplevel"], flags.cwd);
				} catch {
					/* Outside a repository: use the working directory. */
				}
				return runCiConnect({
					cwd: root,
					provider: positionals[1] ?? "",
					values,
					env: deps.env ?? process.env,
					emitProgress,
				});
			}
			{
				const misplaced = Object.entries(values).find(
					([key, value]) =>
						value !== undefined && integrationKeys.includes(key),
				);
				if (misplaced)
					return usage(
						`--${misplaced[0]} only applies to hobo ci connect <provider>.`,
					);
			}
			const setup = command === "enable" || command === "connect";
			if ((setup || command === "status") && positionals.length !== 1)
				return usage(
					`hobo ci ${command} takes no positional arguments; use --repo owner/name.`,
				);
			const commonKeys = new Set([
				"relay",
				"repo",
				"remote",
				"token-file",
				"home",
				"yes",
				"non-interactive",
				"installation-id",
				"accept-all-matching-jobs",
			]);
			const runOptions: CiOptions = Object.fromEntries(
				Object.entries(values).filter(([key]) => !commonKeys.has(key)),
			);
			if ((setup || command === "status") && Object.keys(runOptions).length)
				return usage(`Run filters are not supported by hobo ci ${command}.`);
			if (!setup) {
				const setupOnly = [
					"yes",
					"installation-id",
					"accept-all-matching-jobs",
				];
				if (command !== "status") setupOnly.push("relay", "token-file");
				const ignored = Object.entries(values).find(
					([key, value]) => setupOnly.includes(key) && value !== undefined,
				);
				if (ignored)
					return usage(
						`--${ignored[0]} is a connection option; it does not apply to hobo ci ${command}.`,
					);
			}
			const requestedInstallationId =
				values["installation-id"] === undefined
					? undefined
					: Number(values["installation-id"]);
			if (
				values["installation-id"] !== undefined &&
				(!/^[1-9]\d*$/.test(values["installation-id"]) ||
					!Number.isSafeInteger(requestedInstallationId))
			)
				return usage(
					"--installation-id must be a positive, safe integer GitHub App installation ID.",
				);
			const env = deps.env ?? process.env;
			const fleetStatus = deps.fleetStatus ?? defaultFleetStatus(env);
			const gitEnv = { ...env };
			delete gitEnv.HOBO_CI_ACCOUNT_TOKEN;
			delete gitEnv.HOBO_CI_ACCOUNT_TOKEN_FILE;
			const interactive =
				(deps.interactive ??
					Boolean(process.stdin.isTTY && process.stderr.isTTY)) &&
				!flags.json &&
				!values["non-interactive"];
			if (githubConnect && (!interactive || flags.quiet))
				return usage(
					"GitHub setup requires an interactive terminal and visible progress. Run hobo ci connect github without --json, --quiet or --non-interactive.",
				);
			const ask =
				deps.prompt ??
				(async (question: string) => {
					const terminal = createInterface({
						input: process.stdin,
						output: process.stderr,
					});
					try {
						return await terminal.question(question);
					} finally {
						terminal.close();
					}
				});
			const git =
				deps.git ??
				(async (gitArgs: readonly string[], cwd: string) => {
					const result = await execute("git", [...gitArgs], {
						cwd,
						timeout: 10000,
						maxBuffer: 65536,
						env: gitEnv,
					});
					return result.stdout.trim();
				});
			try {
				let root = flags.cwd;
				try {
					root = await git(["rev-parse", "--show-toplevel"], flags.cwd);
				} catch {
					if (!values.repo)
						return usage(
							"Run from a GitHub repository or pass --repo owner/name.",
						);
				}
				const directory = join(
					resolve(flags.cwd, values.home ?? defaultHoboHome(env)),
					"ci",
					"links",
				);
				const path = join(
					directory,
					`${createHash("sha256").update(resolve(root)).digest("hex")}.json`,
				);
				let repository = values.repo;
				if (values.repo && values.remote)
					return usage("Choose --repo or --remote, not both.");
				if (repository && !validRepository(repository))
					return usage("--repo must be a GitHub owner/name.");
				if (!repository) {
					const remotes = (await git(["remote"], root))
						.split(/\r?\n/)
						.filter(Boolean);
					let remote = values.remote;
					if (remote && !remotes.includes(remote))
						return usage("The selected Git remote does not exist.");
					if (!remote && remotes.length === 1) remote = remotes[0];
					if (!remote && remotes.length > 1) {
						// Reuse only a unique remote matching the user-owned link. A
						// damaged link never prevents independent GitHub run queries.
						let previous: CiLink | undefined;
						try {
							previous = await readLink(path);
						} catch {
							/* Reconnect below reports a corrupt link. */
						}
						if (previous) {
							const matches: string[] = [];
							for (const name of remotes) {
								try {
									if (
										ciRepositoryFromRemote(
											await git(["remote", "get-url", name], root),
										).toLowerCase() === previous.repository.toLowerCase()
									)
										matches.push(name);
								} catch {
									/* Other remotes need not be GitHub repositories. */
								}
							}
							if (matches.length === 1) remote = matches[0];
						}
					}
					if (!remote && remotes.length > 1 && interactive)
						remote = (await ask(`Git remote (${remotes.join(", ")}): `)).trim();
					if (!remote || !remotes.includes(remote))
						return usage(
							"Select a Git remote with --remote <name>, or pass --repo owner/name.",
						);
					repository = ciRepositoryFromRemote(
						await git(["remote", "get-url", remote], root),
					);
				}
				if (!setup && command !== "status")
					return await runCiRuns({
						command,
						repository,
						cwd: root,
						args: positionals.slice(1),
						options: runOptions,
						env,
						emitProgress,
					});
				const link =
					values.relay && values.repo ? undefined : await readLink(path);
				let allowInsecureLoopback = false;
				let selectedEnvironment: string | undefined;
				let jobAdmission: "push" | "pull" | undefined;
				if (!values.relay) {
					try {
						const projectLoad: Parameters<
							typeof loadCiProjectFromDirectory
						>[0] = { repositoryRoot: root, env };
						if (values.config !== undefined)
							projectLoad.configPath = String(values.config);
						if (values.environment !== undefined)
							projectLoad.environment = String(values.environment);
						const project = await loadCiProjectFromDirectory(projectLoad);
						selectedEnvironment = project.environmentName;
						allowInsecureLoopback = project.environment.allowInsecureLoopback;
						jobAdmission = project.environment.jobAdmission ?? undefined;
						values.relay = project.environment.relayOrigin;
					} catch {
						/* Fall back to saved link or explicit env relay URL. */
					}
				}
				let relay =
					values.relay ??
					env.HOBO_CI_RELAY_URL ??
					(link?.repository.toLowerCase() === repository.toLowerCase()
						? link.relayOrigin
						: undefined);
				if (!relay && interactive && setup)
					relay = (await ask("HoBo CI relay HTTPS origin: ")).trim();
				if (!relay)
					return (
						(command === "status"
							? await offlineStatus(fleetStatus, "No CI relay is selected.")
							: undefined) ??
						usage(
							"Select your CI relay with --relay, HOBO_CI_RELAY_URL, or .hobo/ci.json (see hobo ci --help).",
						)
					);
				const origin = allowInsecureLoopback
					? relayOriginFromProject(relay, true)
					: trustedOrigin(relay);
				const tokenFile =
					values["token-file"] ?? env.HOBO_CI_ACCOUNT_TOKEN_FILE;
				if (tokenFile && env.HOBO_CI_ACCOUNT_TOKEN)
					return usage(
						"Choose one CI credential source: a token file or HOBO_CI_ACCOUNT_TOKEN.",
					);
				if (!tokenFile && !env.HOBO_CI_ACCOUNT_TOKEN)
					return (
						(command === "status"
							? await offlineStatus(
									fleetStatus,
									"No CI account credential is set, so the relay was not asked.",
								)
							: undefined) ?? {
							ok: false,
							status: "authentication-required",
							code: "HOBO_CI_AUTH_REQUIRED",
							message:
								"Set HOBO_CI_ACCOUNT_TOKEN or HOBO_CI_ACCOUNT_TOKEN_FILE to your relay account credential. Human hobo login sessions are separate from CI account credentials.",
						}
					);
				// Pin authority for the invocation. A mounted token file may rotate
				// between policy read and write; it must not silently select another account.
				const credential = tokenFile
					? (await boundedText(resolve(flags.cwd, tokenFile), 1024)).trimEnd()
					: (env.HOBO_CI_ACCOUNT_TOKEN ?? "");
				const clientOptions: Parameters<typeof createCiRelayClient>[0] = {
					origin,
					allowInsecureLoopback,
					accountToken: () => credential,
				};
				if (deps.fetch) clientOptions.fetch = deps.fetch;
				const client = createCiRelayClient(clientOptions);
				if (githubConnect) {
					const result = await runGithubCeremony({
						origin,
						credential,
						client,
						prompt: ask,
						emitProgress,
						fetch: deps.fetch,
						openBrowser: deps.openBrowser,
						sleep: deps.sleep,
						now: deps.now,
					});
					if (!result.ok) return result;
				}
				let state: Awaited<ReturnType<typeof client.getPolicy>>;
				try {
					state = await client.getPolicy();
				} catch (error) {
					// The relay could not be reached at all (status 0): offline,
					// `status` still says what this machine knows of itself.
					const offline =
						command === "status" &&
						error instanceof CiRelayClientError &&
						error.status === 0
							? await offlineStatus(
									fleetStatus,
									"The CI relay could not be reached.",
								)
							: undefined;
					if (offline) return offline;
					throw error;
				}
				if (
					!state.account?.id ||
					!/^[A-Za-z0-9_-]{1,80}$/.test(state.account.id)
				)
					throw new Error("The relay returned no account policy.");
				if (
					link &&
					!(values.relay && values.repo) &&
					link.relayOrigin === origin &&
					link.repository.toLowerCase() === repository.toLowerCase() &&
					link.accountId !== state.account.id
				)
					return {
						ok: false,
						code: "HOBO_CI_ACCOUNT_MISMATCH",
						message:
							"The CI credential selects a different account than the saved link. Reconnect with an explicit --relay and --repo.",
					};
				const existing = state.connections.find(
					(connection) =>
						connection.repository.toLowerCase() === repository.toLowerCase(),
				);
				if (command === "status") {
					// The fleets behind the relay, as `hobo fleet status` shows
					// them. Without a fleet authority the connection status is
					// the answer.
					const fleet = await fleetSection(fleetStatus);
					const connection = existing
						? `CI connected for ${repository} at ${origin}.`
						: `CI is not connected for ${repository}. Run hobo ci enable.`;
					const status = {
						repository,
						relayOrigin: origin,
						accountId: state.account.id,
						connected: Boolean(existing),
						revision: state.revision,
						isolated: existing?.isolatedOnly ?? false,
						installationId: existing?.installationId,
						environment: selectedEnvironment,
						jobAdmission,
					};
					return fleet
						? {
								message: `${connection}\n${fleet.message}`,
								data: { ...status, fleet: fleet.data },
							}
						: { message: connection, data: status };
				}
				if (existing) {
					if (
						!existing.isolatedOnly ||
						!existing.acceptAllMatchingRepositoryJobs
					)
						return {
							ok: false,
							code: "HOBO_CI_CONNECTION_MODE",
							message:
								"This repository uses a different CI connection mode. Ask the relay operator to drain and migrate it to isolated runners before enabling it with this CLI.",
						};
					if (
						requestedInstallationId !== undefined &&
						requestedInstallationId !== existing.installationId
					)
						return {
							ok: false,
							code: "HOBO_CI_INSTALLATION_MISMATCH",
							message:
								"This repository is connected through a different GitHub App installation. Inspect hobo ci status; changing the installation requires the relay operator to drain and migrate the connection.",
						};
					const verified = await client.connectIsolatedRepository(
						{
							repository,
							repositoryId: existing.repositoryId,
							installationId: existing.installationId,
							trustedRepositoryAcknowledged: true,
							publicRepositoryAcknowledged: true,
							acceptAllMatchingRepositoryJobs: true,
						},
						{ revision: state.revision },
					);
					if (
						verified.accountId !== state.account.id ||
						verified.repository.toLowerCase() !== repository.toLowerCase() ||
						verified.repositoryId !== existing.repositoryId ||
						verified.installationId !== existing.installationId ||
						!verified.isolatedOnly ||
						!verified.acceptAllMatchingRepositoryJobs
					)
						return {
							ok: false,
							code: "HOBO_CI_CONNECTION_UNCONFIRMED",
							message:
								"The relay did not verify the existing connection. Inspect hobo ci status before retrying setup.",
						};
					await saveLink(
						directory,
						path,
						create(CiRepositoryLinkSchema, {
							relayOrigin: origin,
							accountId: state.account.id,
							repository,
						}),
					);
					return {
						message: `CI already enabled for ${repository}. Use runs-on: hobo in your workflow, then push a commit.`,
						data: { repository, enabled: true, unchanged: true },
					};
				}
				if (!values.yes && !interactive)
					return usage(
						"Noninteractive setup requires --yes --accept-all-matching-jobs. This allows any matching repository job, including fork pull requests, to use isolated runners within the account policy.",
					);
				if (!values["accept-all-matching-jobs"] && !interactive)
					return usage(
						"Pass --accept-all-matching-jobs to consent to isolated runners for every matching repository job, including fork pull requests.",
					);
				const installations = await client.getInstallations();
				if (installations.accountId !== state.account.id)
					return {
						ok: false,
						code: "HOBO_CI_ACCOUNT_MISMATCH",
						message:
							"The installation response does not match the selected CI account. Check the relay before retrying setup.",
					};
				if (!installations.installationIds.length)
					return {
						ok: false,
						code: "HOBO_CI_INSTALL_REQUIRED",
						message: `Connect GitHub and install the HoBo CI App at ${origin}/v1/app-registration/setup, then run hobo ci enable again.`,
					};
				let installationId =
					requestedInstallationId ??
					(installations.installationIds.length === 1
						? installations.installationIds[0]
						: undefined);
				if (installationId === undefined && interactive)
					installationId = Number(
						await ask(
							`GitHub App installation (${installations.installationIds.join(", ")}): `,
						),
					);
				if (
					!installationId ||
					!Number.isSafeInteger(installationId) ||
					!installations.installationIds.includes(installationId)
				)
					return usage(
						"Select a bound GitHub App installation with --installation-id <id>.",
					);
				if (
					interactive &&
					(!values.yes || !values["accept-all-matching-jobs"])
				) {
					const answer = await ask(
						`Enable CI for ${repository} on ${origin}, account ${state.account.id}? Any matching job, including fork pull requests, may run on isolated hosts within your account budget. [y/N] `,
					);
					if (!/^y(?:es)?$/i.test(answer.trim()))
						return {
							message:
								"CI setup cancelled. No repository connection was created.",
						};
				}
				const connected = await client.connectIsolatedRepository(
					{
						repository,
						installationId,
						trustedRepositoryAcknowledged: true,
						publicRepositoryAcknowledged: true,
						acceptAllMatchingRepositoryJobs: true,
					},
					{ revision: state.revision },
				);
				if (
					connected.accountId !== state.account.id ||
					connected.repository.toLowerCase() !== repository.toLowerCase() ||
					connected.installationId !== installationId ||
					!connected.isolatedOnly ||
					!connected.acceptAllMatchingRepositoryJobs
				)
					return {
						ok: false,
						code: "HOBO_CI_CONNECTION_UNCONFIRMED",
						message:
							"The relay did not confirm the requested isolated repository connection. Inspect hobo ci status with the explicit --relay before retrying setup.",
					};
				await saveLink(
					directory,
					path,
					create(CiRepositoryLinkSchema, {
						relayOrigin: origin,
						accountId: state.account.id,
						repository,
					}),
				);
				return {
					message: `CI enabled for ${repository}. Set runs-on: hobo in your GitHub Actions workflow, then push a commit. Inspect runs with hobo ci list.`,
					data: {
						repository,
						relayOrigin: origin,
						accountId: state.account.id,
						enabled: true,
						unchanged: false,
						environment: selectedEnvironment,
						jobAdmission,
					},
				};
			} catch (error) {
				if (error instanceof CiLinkSaveError)
					return {
						ok: false,
						code: "HOBO_CI_LINK_SAVE_FAILED",
						message:
							"CI is connected, but its local link could not be saved. Check HOBO_HOME or --home permissions and repeat enable with the same --relay and --repo; the existing connection will be reused.",
					};
				if (error instanceof CiSetupUsage) return usage(error.message);
				if (error instanceof CiRelayClientError) {
					const guidance =
						error.status === 401
							? "Check your CI account credential."
							: error.status === 403
								? "Check account scopes and GitHub App installation permissions."
								: error.status === 404
									? "Check the repository, installation and relay API."
									: error.status === 409
										? "The policy changed or the connection is busy. Inspect hobo ci status before retrying."
										: error.status === 429
											? "The relay is rate limited. Retry later."
											: "Check the relay and account policy; an uncertain setup can be inspected with hobo ci status.";
					return {
						ok: false,
						code: "HOBO_CI_RELAY_ERROR",
						message: `CI relay request failed (${error.status}). ${guidance}`,
						data: { status: error.status },
					};
				}
				return {
					ok: false,
					code: "HOBO_CI_SETUP_ERROR",
					message:
						"CI setup failed. Check your Git remote, HTTPS relay, credential file and saved link; run hobo ci --help for setup options.",
				};
			}
		},
	};
}
