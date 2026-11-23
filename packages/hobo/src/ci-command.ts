import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, promisify } from "node:util";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import type { CredentialResolver } from "@hobo/cd";
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
import type { HttpTransport, TrustedVault } from "@hobo/core";
import {
	type AppHandOffMode,
	egressFetch,
	egressFrom,
	parseAppHandOffMode,
	REDIRECT_RECEIVER_SETTING,
	type RedirectReceiver,
	redirectReceiverFrom,
	withoutSecretEnv,
} from "@hobo/hobo-ci";
import type { KubernetesTlsMaterial } from "@hobo/provider-kubernetes";
import { CiRepositoryLinkSchema } from "./_generated/composition_pb.js";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { runCiAppCreate, runCiAppDeposit } from "./ci-app-create.js";
import { runCiConnect } from "./ci-connect.js";
import { runCiFleet } from "./ci-fleet.js";
import {
	defaultKubernetesTransport,
	loadFleetClusters,
	runCiFleetCaches,
} from "./ci-fleet-caches.js";
import { runGithubCeremony } from "./ci-github-connect.js";
import { importGithubKey, storedGithubKey } from "./ci-github-keys.js";
import { runCiInit } from "./ci-init.js";
import { runCiInsights } from "./ci-insights.js";
import {
	localMeshReport,
	meshNodesData,
	meshNodesTable,
} from "./ci-mesh-status.js";
import { CI_DEPLOY_ADOPT_OPTIONS, runCiRelayAdopt } from "./ci-relay-adopt.js";
import {
	CI_DEPLOY_ONLY_OPTIONS,
	CI_DEPLOY_OPTIONS,
	runCiRelayDeploy,
} from "./ci-relay-deploy.js";
import type { readRelayDeployToken } from "./ci-relay-deploy-credential.js";
import type { VercelCliRunner } from "./ci-relay-provision.js";
import { runCiRoute } from "./ci-route.js";
import { runCiRuns } from "./ci-runs.js";
import {
	CI_SECRET_STORE_OPTIONS,
	ownerSecretStoreBindingStore,
	runCiSecretStore,
	SECRET_STORE_ONLY_OPTIONS,
	type SecretStoreBindingStore,
} from "./ci-secret-store.js";
import { type CiServeOptions, runCiServe } from "./ci-serve.js";
import type { OwnerStoreEntries } from "./owner-store-session.js";
import { createFetchHttpTransport } from "./resolver-iac-provider.js";
import type { VercelFetch } from "./vercel-client.js";
import type { VercelBuildRunner } from "./vercel-prebuilt.js";

const execute = promisify(execFile);
type CiLink = ReturnType<typeof create<typeof CiRepositoryLinkSchema>>;
type CiOptions = Record<string, string | boolean | string[] | undefined>;
type CiGit = (args: readonly string[], cwd: string) => Promise<string>;

import { ciRepositoryFromRemote, validRepository } from "./ci-repository.js";

export { ciRepositoryFromRemote };

import { CiSetupUsage } from "./ci-command-errors.js";

class CiLinkSaveError extends Error {}

export const CI_HELP = verbHelpText("ci", { implemented: true });

export const CI_ACCOUNT_TOKEN_REF = "owner://HOBO_CI_ACCOUNT_TOKEN";

async function ciAccountToken(
	credentials: CredentialResolver | undefined,
): Promise<string | undefined> {
	const material = await credentials
		?.resolve(CI_ACCOUNT_TOKEN_REF, "hobo-ci-account")
		.catch(() => undefined);
	const token = material?.token;
	return token === "" ? undefined : token;
}

function ciAccountCredentialUnavailable(): CommandResult {
	return {
		ok: false,
		status: "authentication-required",
		code: "HOBO_CI_ACCOUNT_CREDENTIAL_UNAVAILABLE",
		message: `hobo ci needs the relay account credential ${CI_ACCOUNT_TOKEN_REF} from the owner's store session, and none resolved. Run HoBo MCP's choose_secret_store for this project directory, then ask again. Human hobo login sessions are separate from CI account credentials.`,
		remediation: [
			"Call the HoBo MCP tool choose_secret_store for this project directory.",
			`Have the owner keep the relay account credential in that store under ${CI_ACCOUNT_TOKEN_REF.slice("owner://".length)}.`,
		],
	};
}

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

/**
 * `hobo ci status` with no relay to ask: this machine's own mesh report,
 * when its local runner keeps one. Nothing when it does not, so the caller
 * gives its usual answer.
 */
async function offlineStatus(
	repositoryRoot: string,
	env: NodeJS.ProcessEnv,
	why: string,
): Promise<CommandResult | undefined> {
	const report = await localMeshReport(repositoryRoot, env);
	if (!report) return undefined;
	return {
		message: `${why} Showing this machine's own report.\n${meshNodesTable(report)}`,
		data: { source: "local", mesh: meshNodesData(report) },
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
			identity: { type: "string" },
			"dry-run": { type: "boolean" },
			launch: { type: "boolean" },
			ref: { type: "string" },
			sha: { type: "string" },
			project: { type: "string" },
			target: { type: "string" },
			team: { type: "string" },
			set: { type: "string", multiple: true },
			"root-directory": { type: "string" },
			build: { type: "string" },
			"create-project": { type: "boolean" },
			provision: { type: "boolean" },
			adopt: { type: "boolean" },
			deadline: { type: "string" },
			budget: { type: "string" },
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
			"deploy-credential-identity-id": { type: "string" },
			fleet: { type: "string" },
			machine: { type: "string" },
			github: { type: "string" },
			blacksmith: { type: "string" },
			depot: { type: "string" },
			namespace: { type: "string" },
			warpbuild: { type: "string" },
			ubicloud: { type: "string" },
			boat: { type: "string" },
			public: { type: "boolean" },
			fork: { type: "boolean" },
			event: { type: "string" },
			facts: { type: "string" },
			plan: { type: "boolean" },
			apply: { type: "string", multiple: true },
			"fleet-label": { type: "string" },
			"include-secret-jobs": { type: "boolean" },
			"site-url": { type: "string" },
			"via-workflow": { type: "boolean" },
			"hand-off": { type: "boolean" },
			receiver: { type: "string" },
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

async function localRepository(
	deps: { env?: NodeJS.ProcessEnv; git?: CiGit },
	cwd: string,
	values: CiOptions,
): Promise<{ root: string; repository: string | undefined }> {
	const git: CiGit =
		deps.git ??
		(async (gitArgs, directory) => {
			const result = await execute("git", [...gitArgs], {
				cwd: directory,
				timeout: 10000,
				maxBuffer: 65536,
				env: deps.env ?? process.env,
			});
			return result.stdout.trim();
		});
	let root = cwd;
	try {
		root = await git(["rev-parse", "--show-toplevel"], cwd);
	} catch {}
	if (values.repo !== undefined && validRepository(String(values.repo)))
		return { root, repository: String(values.repo) };
	try {
		return {
			root,
			repository: ciRepositoryFromRemote(
				await git(["remote", "get-url", "origin"], root),
			),
		};
	} catch {
		return { root, repository: undefined };
	}
}

function bindingStoreFor(
	ownerEntries: ((cwd: string) => OwnerStoreEntries) | undefined,
	cwd: string,
): { bindingStore?: SecretStoreBindingStore } {
	return ownerEntries === undefined
		? {}
		: { bindingStore: ownerSecretStoreBindingStore(ownerEntries(cwd)) };
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
		deployCredentials?: TrustedVault;
		readDeployCredential?: typeof readRelayDeployToken;
		/** The Vercel CLI `hobo ci deploy --provision` runs; spawned when absent. */
		vercelCli?: VercelCliRunner;
		vercelBuild?: VercelBuildRunner;
		checkoutHead?: (repoRoot: string) => Promise<string>;
		/** HOBO_HOME for `hobo ci deploy`'s CD journal; the default home when absent. */
		hoboHome?: string;
		/** The transport `hobo ci deploy --adopt` reads GitHub's Deployments API with. */
		githubHttp?: HttpTransport;
		/** The transport `hobo ci deploy --wait`'s verification probes use. */
		probeHttp?: HttpTransport;
		/** The Yard runtime `hobo ci secret-store provision` records its claim in. */
		runtime?: YardRuntime;
		ownerCredentials?: (cwd: string) => CredentialResolver;
		ownerEntries?: (cwd: string) => OwnerStoreEntries;
		hostingerHttp?: HttpTransport;
		kubernetesHttp?: (tls: KubernetesTlsMaterial) => HttpTransport;
	} = {},
): CommandModule {
	return {
		implemented: true,
		async run({ args, flags, emitProgress }) {
			if (args.length === 0) return { message: CI_HELP };
			if (args[0] === "fleet") {
				const [, verb, ...rest] = args;
				if (verb === "caches") {
					const local = await localRepository(deps, flags.cwd, {});
					return runCiFleetCaches({
						args: rest,
						repository: local.repository,
						clusters: () => loadFleetClusters(local.root),
						credentials: deps.ownerCredentials?.(flags.cwd),
						transport: deps.kubernetesHttp ?? defaultKubernetesTransport,
					});
				}
				const option = args.find((arg) => arg.startsWith("-"));
				if (option !== undefined)
					return usage(`${option} does not apply to hobo ci fleet.`);
				return runCiFleet({
					positionals: args.slice(1),
					credentials: deps.ownerCredentials?.(flags.cwd),
					transport:
						deps.hostingerHttp ?? createFetchHttpTransport(globalThis.fetch),
				});
			}
			let parsed: ReturnType<typeof parseCiArgs>;
			try {
				parsed = parseCiArgs(args);
			} catch {
				return usage(
					"Invalid CI arguments. Run hobo ci --help for commands and options.",
				);
			}
			const { values } = parsed;
			if (values.repo !== undefined && !validRepository(String(values.repo)))
				return usage("--repo <owner/name> must be a GitHub owner/name.");
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
					"route",
					"init",
					"signals",
					"diagnose",
					"fleet",
				].includes(command)
			)
				return usage("Unknown CI command. Run hobo ci --help.");
			if (command === "init") {
				const local = await localRepository(deps, flags.cwd, values);
				return runCiInit({
					cwd: local.root,
					args: positionals.slice(1),
					options: values,
				});
			}
			if (command === "signals" || command === "diagnose") {
				const local = await localRepository(deps, flags.cwd, values);
				if (local.repository === undefined)
					return usage(
						"Run from a GitHub repository or pass --repo owner/name.",
					);
				return runCiInsights({
					command,
					repository: local.repository,
					cwd: local.root,
					args: positionals.slice(1),
					options: values,
					env: deps.env ?? process.env,
				});
			}
			if (command === "route") {
				if (positionals.length !== 1)
					return usage("hobo ci route takes no positional arguments.");
				const local = await localRepository(deps, flags.cwd, values);
				return runCiRoute({
					cwd: local.root,
					repository: local.repository,
					options: values,
				});
			}
			if (command === "deploy") {
				if (positionals.length !== 1)
					return usage("hobo ci deploy takes no positional arguments.");
				if (values.adopt === true) {
					const adoptable = new Set<string>(CI_DEPLOY_ADOPT_OPTIONS);
					const other = Object.entries(values).find(
						([key, value]) => value !== undefined && !adoptable.has(key),
					);
					if (other)
						return usage(
							`--${other[0]} does not apply to hobo ci deploy --adopt: it observes the deployment Vercel's Git integration made and configures none.`,
						);
					return runCiRelayAdopt({
						cwd: flags.cwd,
						values,
						env: deps.env ?? process.env,
						...(deps.githubHttp !== undefined
							? { github: deps.githubHttp }
							: undefined),
						...(deps.probeHttp !== undefined
							? { probe: deps.probeHttp }
							: undefined),
						...(deps.sleep !== undefined ? { sleep: deps.sleep } : undefined),
						...(deps.now !== undefined ? { now: deps.now } : undefined),
						...(deps.hoboHome !== undefined
							? { home: deps.hoboHome }
							: undefined),
						emitProgress,
					});
				}
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
					...bindingStoreFor(deps.ownerEntries, flags.cwd),
					...(deps.deployCredentials !== undefined
						? { credentials: deps.deployCredentials }
						: undefined),
					...(deps.readDeployCredential !== undefined
						? { readDeployCredential: deps.readDeployCredential }
						: undefined),
					...(deps.vercelFetch !== undefined
						? { fetch: deps.vercelFetch }
						: undefined),
					...(deps.vercelCli !== undefined
						? { runVercelCli: deps.vercelCli }
						: undefined),
					...(deps.vercelBuild !== undefined
						? { runVercelBuild: deps.vercelBuild }
						: undefined),
					...(deps.checkoutHead !== undefined
						? { checkoutHead: deps.checkoutHead }
						: undefined),
					...(deps.sleep !== undefined ? { sleep: deps.sleep } : undefined),
					...(deps.now !== undefined ? { now: deps.now } : undefined),
					...(deps.hoboHome !== undefined
						? { home: deps.hoboHome }
						: undefined),
					...(deps.probeHttp !== undefined
						? { probe: deps.probeHttp }
						: undefined),
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
					...bindingStoreFor(deps.ownerEntries, flags.cwd),
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
						...bindingStoreFor(deps.ownerEntries, flags.cwd),
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
					"hand-off",
					"receiver",
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
				// The owner's outbound-only tunnel: --receiver, else the
				// non-secret HOBO_REDIRECT_RECEIVER; none means the hand-off.
				// Both, and the hand-off mode, are parsed here, at the boundary.
				let receiver: RedirectReceiver | undefined;
				let handOffMode: AppHandOffMode;
				try {
					handOffMode = parseAppHandOffMode(
						"HOBO_APP_HANDOFF",
						(deps.env ?? process.env).HOBO_APP_HANDOFF,
					);
					receiver = redirectReceiverFrom({
						...withoutSecretEnv(deps.env ?? process.env),
						...(values.receiver !== undefined
							? { [REDIRECT_RECEIVER_SETTING]: String(values.receiver) }
							: undefined),
					});
				} catch (error) {
					return usage(
						error instanceof Error ? error.message : "Unknown receiver.",
					);
				}
				if (
					(values["hand-off"] === true || receiver !== undefined) &&
					(flags.json || flags.quiet)
				)
					return usage(
						"The App hand-off needs progress output. Omit --json and -q, then retry.",
					);
				return runCiAppCreate({
					relay: values.relay === undefined ? undefined : String(values.relay),
					ownerId:
						values["owner-id"] === undefined
							? undefined
							: String(values["owner-id"]),
					name: values.name === undefined ? undefined : String(values.name),
					replace: values.yes === true,
					viaWorkflow: values["via-workflow"] === true,
					handOff: values["hand-off"] === true,
					handOffMode,
					receiver,
					// Every request of this run goes through the proxy the
					// environment requires, read once up front.
					tunnelProbe:
						deps.fetch ?? egressFetch(egressFrom(deps.env ?? process.env)),
					interactive,
					env: deps.env ?? process.env,
					emitProgress,
					fetch: deps.fetch ?? egressFetch(egressFrom(deps.env ?? process.env)),
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
				const git =
					deps.git ??
					(async (gitArgs: readonly string[], cwd: string) => {
						const result = await execute("git", [...gitArgs], {
							cwd,
							timeout: 10000,
							maxBuffer: 65536,
							env,
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
				if (command !== "status") setupOnly.push("relay");
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
						env,
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
							? await offlineStatus(root, env, "No CI relay is selected.")
							: undefined) ??
						usage(
							"Select your CI relay with --relay, HOBO_CI_RELAY_URL, or .hobo/ci.json (see hobo ci --help).",
						)
					);
				const origin = allowInsecureLoopback
					? relayOriginFromProject(relay, true)
					: trustedOrigin(relay);
				const credential = await ciAccountToken(
					deps.ownerCredentials?.(flags.cwd),
				);
				if (credential === undefined)
					return (
						(command === "status"
							? await offlineStatus(
									root,
									env,
									"No CI account credential resolved from the owner's store session, so the relay was not asked.",
								)
							: undefined) ?? ciAccountCredentialUnavailable()
					);
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
									root,
									env,
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
					// The runner nodes behind the relay: availability, capacity
					// and trust. A relay too old to have the route, or one that
					// refuses it, leaves the connection status as the answer.
					const mesh = await client.getMeshNodes().catch(() => undefined);
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
					return mesh
						? {
								message: `${connection}\n${meshNodesTable(mesh)}`,
								data: { ...status, mesh: meshNodesData(mesh) },
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
