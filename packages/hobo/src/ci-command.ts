import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, promisify } from "node:util";
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
} from "@hobo/cli";
import { CiRepositoryLinkSchema } from "./_generated/composition_pb.js";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { runCiConnect } from "./ci-connect.js";
import { runCiRuns } from "./ci-runs.js";
import { type CiServeOptions, runCiServe } from "./ci-serve.js";

const execute = promisify(execFile);
type CiLink = ReturnType<typeof create<typeof CiRepositoryLinkSchema>>;
type CiOptions = Record<string, string | boolean | string[] | undefined>;

import { ciRepositoryFromRemote, validRepository } from "./ci-repository.js";

export { ciRepositoryFromRemote };

import { CiSetupUsage } from "./ci-command-errors.js";

class CiLinkSaveError extends Error {}

export const CI_HELP = verbHelpText("ci", { implemented: true });

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
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
			const { values, positionals } = parsed;
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
				].includes(command)
			)
				return usage("Unknown CI command. Run hobo ci --help.");
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
						"hobo ci connect takes one provider: blacksmith, depot, jog or boat.",
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
			const gitEnv = { ...env };
			delete gitEnv.HOBO_CI_ACCOUNT_TOKEN;
			delete gitEnv.HOBO_CI_ACCOUNT_TOKEN_FILE;
			const interactive =
				(deps.interactive ??
					Boolean(process.stdin.isTTY && process.stderr.isTTY)) &&
				!flags.json &&
				!values["non-interactive"];
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
					return usage(
						"Select your CI relay with --relay, HOBO_CI_RELAY_URL, or .hobo/ci.json (see hobo ci --help).",
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
					return {
						ok: false,
						status: "authentication-required",
						code: "HOBO_CI_AUTH_REQUIRED",
						message:
							"Set HOBO_CI_ACCOUNT_TOKEN or HOBO_CI_ACCOUNT_TOKEN_FILE to your relay account credential. Human hobo login sessions are separate from CI account credentials.",
					};
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
				const state = await client.getPolicy();
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
				if (command === "status")
					return {
						message: existing
							? `CI connected for ${repository} at ${origin}.`
							: `CI is not connected for ${repository}. Run hobo ci enable.`,
						data: {
							repository,
							relayOrigin: origin,
							accountId: state.account.id,
							connected: Boolean(existing),
							revision: state.revision,
							isolated: existing?.isolatedOnly ?? false,
							installationId: existing?.installationId,
							environment: selectedEnvironment,
							jobAdmission,
						},
					};
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
