import { type ChildProcess, spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ConfigurationSchema } from "@hobo/ci";
import { createDashboardRoute } from "@hobo/ci-dashboard";
import {
	type CiJobAdmission,
	type CiWorkerStore,
	createGithubAppTransport,
	createGithubJobPoller,
	createPollIngestCoalesce,
	createPollLogFilter,
	describeWaitingJobs,
	type GithubTransport,
	inferJobAdmission,
	inventoryCiEnginesFromRepository,
	loadCiProjectFromDirectory,
	parseRelayJobs,
	type RelaySecrets,
	type RelayWiring,
	resolveEnvironmentEngines,
	startRelayFromEnvironment,
	WORKER_SECRETS_FD,
	waitForWorkerStart,
	workerSecretsPayload,
} from "@hobo/ci-gh-actions/cli-serve";
import { parseCiAgentBlock } from "@hobo/ci-gh-actions/project-config";
import type { CommandResult } from "@hobo/cli";
import { resolveSettings } from "@hobo/connect-ui";
import { createTrustedVault, type TrustedVault } from "@hobo/core";
import {
	CI_SETTINGS,
	familySettings,
	hasSecretStoreLocator,
	loadGithubAppCredentials,
	type OpenedSecretStore,
	ownerStore,
	resolveGithubAppExpectation,
	withoutSecretEnv,
	workloadOidcOf,
} from "@hobo/hobo-ci";
import { z } from "zod";
import { githubKeyEnvironment } from "./ci-github-keys.js";
import { ciRepositoryFromRemote } from "./ci-repository.js";
import { defaultHoboHome } from "./hobo-home.js";
import { isJsonNumber, isJsonObject } from "./json.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);
const JsonValue = z.json();
const JsonObjectSchema = z.record(z.string(), JsonValue);

export interface CiServeRedactedSnapshot {
	readonly environment: string;
	readonly relayOrigin: string;
	readonly configRelayOrigin: string;
	readonly admission: CiJobAdmission;
	readonly bind: { readonly host: string; readonly port: number };
	readonly trustProxy: boolean;
	readonly repository: string;
	readonly engines: readonly string[];
	readonly project: z.infer<typeof JsonValue>;
	readonly installationId?: number;
}

interface ServeLogEntry {
	readonly ts: string;
	readonly level: "info" | "error";
	readonly event: string;
	readonly environment?: string;
	readonly publicOrigin?: string;
	readonly bind?: { readonly host: string; readonly port: number };
	readonly admission?: CiJobAdmission;
	readonly trustProxy?: boolean;
	readonly engines?: readonly string[];
	readonly agent?: boolean;
}

export interface CiServeOptions {
	readonly host?: string;
	readonly port?: string;
	readonly url?: string;
	readonly endpoint?: string;
	readonly origin?: string;
	readonly baseUrl?: string;
	readonly trustProxy?: boolean;
	readonly environment?: string;
	readonly config?: string;
	readonly admission?: string;
	readonly allowInsecure?: boolean;
	readonly withWorker?: boolean;
	/** Serve without the CI agent even when the project configures one. */
	readonly noAgent?: boolean;
	readonly printConfig?: boolean;
	readonly repo?: string;
	readonly remote?: string;
	readonly installationId?: string;
	readonly home?: string;
	readonly db?: string;
	readonly engines?: readonly string[];
}

export interface CiServeHandle {
	readonly origin: string;
	readonly plan: ResolvedServePlan;
	stop(): Promise<void>;
}

interface ResolvedServePlan {
	readonly environmentName: string;
	readonly publicOrigin: string;
	readonly configRelayOrigin: string;
	readonly host: string;
	readonly port: number;
	readonly admission: CiJobAdmission;
	readonly allowInsecureLoopback: boolean;
	readonly trustProxy: boolean;
	readonly repository: string;
	readonly installationId?: number;
	readonly engines: readonly string[];
	readonly configPath: string;
	readonly workerStore: CiWorkerStore;
	readonly redacted: CiServeRedactedSnapshot;
}

/**
 * Environment for the `--with-worker` sidecar. The worker keeps its own lease
 * journal: SQLite under the serve state dir, never the relay's file.
 */
export function ciWorkerEnvironment(input: {
	relayEnv: NodeJS.ProcessEnv;
	store: CiWorkerStore;
	stateDir: string;
}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...input.relayEnv };
	// HOBO_CI_DB is the relay's journal; a second writer must not open it.
	delete env.HOBO_CI_DB;
	env.HOBO_CI_STORE = input.store.kind;
	env.HOBO_CI_WORKER_DB =
		input.relayEnv.HOBO_CI_WORKER_DB ?? join(input.stateDir, "worker.sqlite");
	// A setting the removed Postgres store read; the worker reads it no more.
	delete env.HOBO_CI_STORE_URL_ENV;
	return env;
}

type RunningRelay = Awaited<ReturnType<typeof startRelayFromEnvironment>>;
type RelayStarter = (
	env: NodeJS.ProcessEnv,
	ports: { readonly secrets: RelaySecrets },
) => Promise<RunningRelay>;

/**
 * The relay's startup with the CI agent beside it, from `@hobo/ci-agent`. The
 * agent and its model SDK are not part of the `hobo` CLI; they are loaded
 * only when a project's `.hobo/ci.json` has an `agent` block.
 */
async function loadAgentRelay() {
	try {
		return (await import("@hobo/ci-agent/relay-main"))
			.startRelayWithAgentFromEnvironment;
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			error.code === "ERR_MODULE_NOT_FOUND"
		)
			throw new Error(
				"This project configures a CI agent (the agent block of .hobo/ci.json), which needs the @hobo/ci-agent package. Install it next to hobo, or pass --no-agent to serve without the agent.",
			);
		throw error;
	}
}

/**
 * Pull admission for a relay with no public webhook URL: the same GitHub job
 * poller the box worker runs, feeding the relay's inbox. Only the repository
 * this serve was started for is read, and only once the relay holds a
 * connection for it; the relay's own tick then admits what was accepted.
 */
export function startPullAdmission(input: {
	github: GithubTransport;
	relay: {
		runtime: Pick<RunningRelay["runtime"], "admissionOrder" | "ingestWebhook">;
		store: Pick<RunningRelay["store"], "configuration">;
		wiring?: Pick<RelayWiring, "afterPoll"> | undefined;
	};
	repository: string;
	installationId: number;
	intervalMs?: number;
	emitProgress?: ((message: string) => void) | undefined;
}) {
	const { runtime, store, wiring } = input.relay;
	const repository = input.repository.toLowerCase();
	const served = async () =>
		((await store.configuration())?.configuration?.connections ?? []).filter(
			(connection) =>
				connection.installationId === input.installationId &&
				connection.repository.toLowerCase() === repository,
		);
	const poller = createGithubJobPoller({
		github: input.github,
		admissionOrder: runtime.admissionOrder,
		ingestCoalesce: createPollIngestCoalesce(),
		connections: served,
		ingest: (delivery) => runtime.ingestWebhook(delivery),
		onIngestError: (jobId, message) =>
			input.emitProgress?.(`poll-admission job ${jobId} refused: ${message}`),
		onGithubError: (failure) =>
			input.emitProgress?.(
				`poll-admission GitHub read failed (${failure.status}): ${failure.path}`,
			),
	});
	const worthLogging = createPollLogFilter();
	let inFlight: Promise<void> | undefined;
	function poll(): Promise<void> {
		inFlight ??= poller
			.poll()
			.then((summary) => {
				if (!worthLogging(summary, Date.now())) return;
				const waiting = describeWaitingJobs(summary.waiting);
				input.emitProgress?.(
					[
						`poll-admission: ${summary.accepted} accepted`,
						`${summary.failed} refused`,
						`${summary.githubErrors} GitHub read errors`,
						waiting ? `waiting ${waiting}` : "",
						summary.pausedUntil ? `paused until ${summary.pausedUntil}` : "",
					]
						.filter(Boolean)
						.join(", "),
				);
			})
			.catch(() => {
				// The next poll retries; a failed poll admits nothing.
			})
			.finally(() => {
				inFlight = undefined;
				if (wiring) void relayModePass(wiring);
			});
		return inFlight;
	}
	async function relayModePass(
		relayWiring: Pick<RelayWiring, "afterPoll">,
	): Promise<void> {
		try {
			const pass = await relayWiring.afterPoll(
				(await served()).map((connection) => ({
					installationId: connection.installationId,
					repository: connection.repository,
				})),
			);
			if (pass && (pass.rescue.queued > 0 || pass.sweep.deleted.length > 0))
				input.emitProgress?.(
					`relay mode: ${pass.rescue.queued} queued relay jobs, ${pass.sweep.deleted.length} leftover runners removed`,
				);
		} catch {
			return;
		}
	}
	const timer = setInterval(() => void poll(), input.intervalMs ?? 15_000);
	void poll();
	return {
		poll,
		stop(): void {
			clearInterval(timer);
		},
	};
}

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

function parseAdmission(value: string | undefined): CiJobAdmission | undefined {
	if (value === undefined) return undefined;
	if (value === "push" || value === "pull") return value;
	throw new Error("admission must be push or pull");
}

interface NormalizedRelayOrigin {
	readonly origin: string;
	readonly port: number;
}

function normalizeOrigin(
	value: string,
	allowInsecureLoopback: boolean,
): NormalizedRelayOrigin {
	const url = new URL(value);
	const loopback =
		allowInsecureLoopback &&
		url.protocol === "http:" &&
		LOOPBACK.has(url.hostname);
	if (
		(!loopback && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("invalid relay origin");
	const port =
		url.port.length > 0
			? Number(url.port)
			: url.protocol === "https:"
				? 443
				: 80;
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("invalid relay port");
	return { origin: url.origin, port };
}

async function freePort(host: string): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, resolve);
	});
	const address = server.address();
	if (!address || !isJsonObject(address) || !isJsonNumber(address.port))
		throw new Error("failed to allocate port");
	const port = address.port;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
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

function redactProjectDocument(
	document: z.infer<typeof JsonValue>,
): z.infer<typeof JsonValue> {
	const parsed = JsonObjectSchema.safeParse(document);
	if (!parsed.success) return document;
	const clone = structuredClone(parsed.data);
	delete clone.secrets;
	const environments = JsonObjectSchema.safeParse(clone.environments);
	if (environments.success) {
		const nextEnvironments: z.infer<typeof JsonObjectSchema> = {
			...environments.data,
		};
		for (const key of Object.keys(nextEnvironments)) {
			const envObject = JsonObjectSchema.safeParse(nextEnvironments[key]);
			if (envObject.success) {
				const envClone = { ...envObject.data };
				delete envClone.secrets;
				nextEnvironments[key] = envClone;
			}
		}
		clone.environments = nextEnvironments;
	}
	return clone;
}

async function resolveRepository(
	options: CiServeOptions,
	cwd: string,
	git: (args: readonly string[], cwd: string) => Promise<string>,
): Promise<string> {
	if (options.repo) return options.repo;
	const remotes = (await git(["remote"], cwd).catch(() => ""))
		.split("\n")
		.filter(Boolean);
	const soleRemote = remotes.length === 1 ? remotes[0] : undefined;
	const remote = options.remote ?? soleRemote ?? "origin";
	if (!remotes.includes(remote)) throw new Error("missing git remote");
	return ciRepositoryFromRemote(await git(["remote", "get-url", remote], cwd));
}

export async function resolveCiServePlan(input: {
	cwd: string;
	options: CiServeOptions;
	env: NodeJS.ProcessEnv;
	git: (args: readonly string[], cwd: string) => Promise<string>;
}): Promise<ResolvedServePlan> {
	const loadOptions: Parameters<typeof loadCiProjectFromDirectory>[0] = {
		repositoryRoot: input.cwd,
		env: input.env,
	};
	if (input.options.config) loadOptions.configPath = input.options.config;
	if (input.options.environment)
		loadOptions.environment = input.options.environment;
	const project = await loadCiProjectFromDirectory(loadOptions);
	const inventory = await inventoryCiEnginesFromRepository(input.cwd);
	const engines = resolveEnvironmentEngines({
		environment: project.environment,
		inventory,
		cliEngines: input.options.engines,
	});
	const admission =
		parseAdmission(input.options.admission) ??
		project.environment.jobAdmission ??
		inferJobAdmission(project.environment);
	const allowInsecureLoopback =
		project.environment.allowInsecureLoopback ||
		input.options.allowInsecure === true;
	const bindHost = input.options.host ?? "127.0.0.1";
	const publicOriginInput =
		input.options.origin ??
		input.options.baseUrl ??
		input.options.url ??
		input.options.endpoint;
	if (
		!LOOPBACK.has(bindHost) &&
		!publicOriginInput &&
		!input.options.allowInsecure
	)
		throw new Error(
			"refusing non-loopback bind without --origin (HTTPS) or --allow-insecure",
		);
	const configRelayOrigin = normalizeOrigin(
		project.environment.relayOrigin,
		allowInsecureLoopback,
	).origin;
	let publicOrigin = publicOriginInput ?? project.environment.relayOrigin;
	const normalizedPublic = normalizeOrigin(publicOrigin, allowInsecureLoopback);
	publicOrigin = normalizedPublic.origin;
	if (publicOriginInput && publicOrigin !== configRelayOrigin)
		throw new Error(
			`public origin ${publicOrigin} does not match environment ${project.environmentName} relayOrigin ${configRelayOrigin}`,
		);
	let port = input.options.port ? Number(input.options.port) : undefined;
	if (
		port !== undefined &&
		(!Number.isInteger(port) || port < 1 || port > 65535)
	)
		throw new Error("invalid --port");
	if (port === undefined) {
		const loopbackPublic = LOOPBACK.has(new URL(publicOrigin).hostname);
		if (allowInsecureLoopback && loopbackPublic) {
			port = normalizedPublic.port;
			if (port === 80 || port === 443) port = await freePort(bindHost);
		} else {
			port = await freePort(bindHost);
		}
	}
	if (allowInsecureLoopback && LOOPBACK.has(new URL(publicOrigin).hostname)) {
		const originUrl = new URL(publicOrigin);
		if (originUrl.port !== String(port)) {
			originUrl.port = String(port);
			publicOrigin = originUrl.origin;
		}
	}
	const origin = publicOrigin;
	const trustProxy =
		input.options.trustProxy === true || input.env.HOBO_CI_TRUST_PROXY === "1";
	const repository = await resolveRepository(
		input.options,
		input.cwd,
		input.git,
	);
	const installationId =
		input.options.installationId === undefined
			? undefined
			: Number(input.options.installationId);
	if (
		installationId !== undefined &&
		(!Number.isSafeInteger(installationId) || installationId < 1)
	)
		throw new Error("invalid installation id");
	const committed = await readFile(project.configPath, "utf8");
	const projectDocument = JsonValue.parse(JSON.parse(committed));
	const redacted: CiServeRedactedSnapshot =
		installationId === undefined
			? {
					environment: project.environmentName,
					relayOrigin: new URL(origin).origin,
					configRelayOrigin,
					admission,
					bind: { host: bindHost, port },
					trustProxy,
					repository,
					engines,
					project: redactProjectDocument(projectDocument),
				}
			: {
					environment: project.environmentName,
					relayOrigin: new URL(origin).origin,
					configRelayOrigin,
					admission,
					bind: { host: bindHost, port },
					trustProxy,
					repository,
					engines,
					project: redactProjectDocument(projectDocument),
					installationId,
				};
	const planBase = {
		environmentName: project.environmentName,
		publicOrigin: new URL(origin).origin,
		configRelayOrigin,
		host: bindHost === "localhost" ? "127.0.0.1" : bindHost,
		port,
		admission,
		allowInsecureLoopback,
		trustProxy,
		repository,
		engines,
		configPath: project.configPath,
		workerStore: project.environment.store ?? { kind: "sqlite" as const },
		redacted,
	};
	if (installationId === undefined) return planBase;
	return { ...planBase, installationId };
}

// Secrets `ci serve` reads: from a mounted file the environment names
// (`<NAME>_FILE`), else from the run's trusted vault, which holds what the
// owner's secret store gave this run. Never from a value in the environment,
// where every child process would inherit it.
const INLINE_SECRETS = Object.freeze([
	"HOBO_CI_GITHUB_APP_PRIVATE_KEY",
	"HOBO_CI_WEBHOOK_SECRET",
	"HOBO_CI_ACCOUNT_TOKEN",
	"HOBO_CI_INGRESS_FORWARD_SECRET",
] as const);

/** Refuse secret values set in the environment, naming them (never their values). */
export function refuseInlineSecrets(env: NodeJS.ProcessEnv): void {
	const named = INLINE_SECRETS.filter((name) => env[name]);
	if (named.length === 0) return;
	throw new Error(
		`${named.join(", ")} in the environment ${named.length === 1 ? "is" : "are"} not read. Keep ${named.length === 1 ? "it" : "them"} in your secret store (hobo ci up connects GitHub there), or mount ${named.length === 1 ? "it as a file" : "each as a file"} and name the file with ${named.map((name) => `${name}_FILE`).join(", ")}.`,
	);
}

async function readOptionalSecret(
	env: NodeJS.ProcessEnv,
	name: string,
	vault?: TrustedVault,
): Promise<string | undefined> {
	const file = env[`${name}_FILE`];
	if (file) return (await boundedText(resolve(file), 65536)).trimEnd();
	return vault?.reveal(name);
}

async function readSecret(
	env: NodeJS.ProcessEnv,
	name: string,
	vault?: TrustedVault,
): Promise<string> {
	const value = await readOptionalSecret(env, name, vault);
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

/** The store entry an account token for the local control plane may be kept in. */
const ACCOUNT_TOKEN_ENTRY = "HOBO_CI_ACCOUNT_TOKEN";

/**
 * Read the GitHub App connection `hobo ci up` deposited from the owner's store
 * into `vault`, and the account token when the store keeps one (with or
 * without a connection). False when no store opens or it holds no connection.
 */
async function loadStoredConnection(
	open: () => Promise<OpenedSecretStore | undefined>,
	vault: TrustedVault,
	env: NodeJS.ProcessEnv,
	fetchImpl?: typeof fetch,
): Promise<boolean> {
	const store = await open().catch(() => {
		throw new Error("Cannot open the owner's secret store.");
	});
	if (store === undefined) return false;
	const token = await store.port
		.access(ACCOUNT_TOKEN_ENTRY)
		.catch(() => undefined);
	if (token?.status === "ok" && token.material)
		vault.put(ACCOUNT_TOKEN_ENTRY, token.material);
	return loadGithubAppCredentials(store, vault, async () => {
		const plainEnv = withoutSecretEnv(env);
		const basics = resolveSettings(
			CI_SETTINGS,
			plainEnv,
			await familySettings(store, "ci").read(),
		);
		return resolveGithubAppExpectation(basics.values, plainEnv, fetchImpl);
	});
}

/** The owner's store, opened without a page: the committed locator and a non-interactive sign-in. */
function ownerStoreOpener(
	env: NodeJS.ProcessEnv,
	cwd: string,
): () => Promise<OpenedSecretStore | undefined> {
	return async () => {
		const signIn = createTrustedVault();
		const workloadOidc = workloadOidcOf(env);
		try {
			const owner = await ownerStore("ci", signIn, {
				env: withoutSecretEnv(env),
				cwd,
				...(workloadOidc !== undefined ? { workloadOidc } : undefined),
			});
			const configured =
				Boolean(env.HOBO_SECRET_STORE) || hasSecretStoreLocator(cwd, env);
			if (owner.opened === undefined && configured)
				throw new Error("Cannot open the owner's secret store.");
			return owner.opened;
		} finally {
			signIn.clear();
		}
	};
}

function serveLog(
	emit: ((message: string) => void) | undefined,
	entry: ServeLogEntry,
): void {
	emit?.(`${JSON.stringify(entry)}\n`);
}

interface ServeCredentials {
	/** The App key's file, when it came from one (the relay is handed the key itself). */
	readonly keyPath: string | undefined;
	readonly privateKey: string;
	readonly tokenPath: string;
	readonly webhookSecret: string;
	readonly appId: string;
}

async function ensureCredentials(
	env: NodeJS.ProcessEnv,
	directory: string,
	requireRealCredentials: boolean,
	installationId: number | undefined,
	vault: TrustedVault,
): Promise<ServeCredentials> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const tokenPath = join(directory, "control-tokens.json");
	const fromStore = vault.has("HOBO_CI_GITHUB_APP_PRIVATE_KEY");
	const configuredKeyPath = env.HOBO_CI_GITHUB_APP_KEY_FILE;
	const hasKeyFile =
		configuredKeyPath !== undefined &&
		configuredKeyPath.length > 0 &&
		(await access(configuredKeyPath, constants.R_OK).then(
			() => true,
			() => false,
		));
	const appConfigurationPresent = Boolean(
		env.HOBO_CI_GITHUB_APP_ID ||
			env.HOBO_CI_GITHUB_APP_ID_FILE ||
			configuredKeyPath ||
			env.HOBO_CI_GITHUB_APP_PRIVATE_KEY_FILE ||
			env.HOBO_CI_WEBHOOK_SECRET_FILE,
	);
	if (appConfigurationPresent && !hasKeyFile)
		throw new Error(
			"GitHub App configuration requires a readable HOBO_CI_GITHUB_APP_KEY_FILE",
		);
	if (requireRealCredentials && !hasKeyFile && !fromStore)
		throw new Error(
			"remote bind requires GitHub App credentials: connect GitHub with hobo ci up (they go to your secret store), or mount HOBO_CI_GITHUB_APP_KEY_FILE and the related files",
		);
	if (hasKeyFile || fromStore) {
		const webhookSecret = await readSecret(
			env,
			"HOBO_CI_WEBHOOK_SECRET",
			fromStore ? vault : undefined,
		);
		if (webhookSecret.length < 32)
			throw new Error("HOBO_CI_WEBHOOK_SECRET must be at least 32 characters");
		let controlPath = env.HOBO_CI_CONTROL_TOKENS_FILE ?? tokenPath;
		if (!env.HOBO_CI_CONTROL_TOKENS_FILE) {
			const token = await readOptionalSecret(env, ACCOUNT_TOKEN_ENTRY, vault);
			if (!token || token.length < 32 || /\s/.test(token))
				throw new Error(
					`real App credentials require a CI account token of at least 32 characters (${ACCOUNT_TOKEN_ENTRY} in your secret store, or a file named by ${ACCOUNT_TOKEN_ENTRY}_FILE) or HOBO_CI_CONTROL_TOKENS_FILE`,
				);
			await writeFile(
				tokenPath,
				JSON.stringify({
					tokens: [
						{
							accountId: "local-dev",
							tokenSha256: createHash("sha256").update(token).digest("hex"),
							installationIds:
								installationId === undefined ? [] : [installationId],
							scopes: [
								"policy:read",
								"policy:write",
								"repositories:write",
								"operations:write",
							],
						},
					],
				}),
				{ mode: 0o600 },
			);
			controlPath = tokenPath;
		}
		if (fromStore)
			return {
				keyPath: undefined,
				privateKey: await readSecret(
					{},
					"HOBO_CI_GITHUB_APP_PRIVATE_KEY",
					vault,
				),
				tokenPath: controlPath,
				webhookSecret,
				appId: await readSecret({}, "HOBO_CI_GITHUB_APP_ID", vault),
			};
		return {
			keyPath: configuredKeyPath,
			privateKey: await boundedText(String(configuredKeyPath), 65536),
			tokenPath: controlPath,
			webhookSecret,
			// An App id names the App; it is not a secret.
			appId:
				env.HOBO_CI_GITHUB_APP_ID?.trim() ||
				(await readSecret(env, "HOBO_CI_GITHUB_APP_ID")),
		};
	}
	const pair = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	// A throwaway key for a loopback relay, held in memory only.
	const webhookSecret = `synthetic-webhook-secret-${createHash("sha256").update(directory).digest("hex")}`;
	const token = `synthetic-local-token-${createHash("sha256").update(directory).digest("hex")}`;
	await writeFile(
		tokenPath,
		JSON.stringify({
			tokens: [
				{
					accountId: "local-dev",
					tokenSha256: createHash("sha256").update(token).digest("hex"),
					installationIds: [],
					scopes: [
						"policy:read",
						"policy:write",
						"repositories:write",
						"operations:write",
					],
				},
			],
		}),
		{ mode: 0o600 },
	);
	return {
		keyPath: undefined,
		privateKey: pair.privateKey,
		tokenPath,
		webhookSecret,
		appId: env.HOBO_CI_GITHUB_APP_ID ?? "123456",
	};
}

export async function startCiServe(input: {
	cwd: string;
	options: CiServeOptions;
	env: NodeJS.ProcessEnv;
	git: (args: readonly string[], cwd: string) => Promise<string>;
	emitProgress?: (message: string) => void;
	/** The owner's secret store (test seam); by default opened from the committed locator. */
	openStore?: () => Promise<OpenedSecretStore | undefined>;
	/** GitHub verification seam for lifecycle tests. */
	fetch?: typeof fetch;
	/** Relay startup seam for lifecycle tests. */
	startRelay?: RelayStarter;
	/** The worker script to run (test seam); the isolated worker daemon by default. */
	workerScript?: string;
}): Promise<CiServeHandle> {
	refuseInlineSecrets(input.env);
	const plan = await resolveCiServePlan(input);
	const home = resolve(
		input.cwd,
		input.options.home ?? defaultHoboHome(input.env),
	);
	const stateDir = join(home, "ci", "serve");
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	const requireRealCredentials =
		!LOOPBACK.has(plan.host) && !plan.allowInsecureLoopback;
	// What the owner's store gives this run lives in this vault, in memory,
	// and is wiped when the relay stops.
	const vault = createTrustedVault();
	let startupRelay: RunningRelay | undefined;
	let pollStop: (() => void) | undefined;
	let worker: ChildProcess | undefined;
	try {
		// Explicitly mounted App files win as a unit; then the store's connection;
		// then a key imported under HOBO_HOME.
		const filesConfigured = Boolean(
			input.env.HOBO_CI_GITHUB_APP_KEY_FILE ||
				input.env.HOBO_CI_GITHUB_APP_ID ||
				input.env.HOBO_CI_GITHUB_APP_ID_FILE ||
				input.env.HOBO_CI_WEBHOOK_SECRET_FILE,
		);
		const fromStore =
			!filesConfigured &&
			(await loadStoredConnection(
				input.openStore ?? ownerStoreOpener(input.env, input.cwd),
				vault,
				input.env,
				input.fetch,
			));
		const configuredEnv = fromStore
			? input.env
			: await githubKeyEnvironment(input.env, home);
		const credentials = await ensureCredentials(
			configuredEnv,
			stateDir,
			requireRealCredentials,
			plan.installationId,
			vault,
		);
		const dbPath = input.options.db ?? join(stateDir, "relay.sqlite");
		const seedConfig = join(stateDir, "config.json");
		if (
			!(await access(seedConfig, constants.R_OK).then(
				() => true,
				() => false,
			))
		) {
			await writeFile(
				seedConfig,
				toJsonString(
					ConfigurationSchema,
					create(ConfigurationSchema, { accounts: [], connections: [] }),
				),
				{ mode: 0o600 },
			);
		}
		const relayEnv: NodeJS.ProcessEnv = { ...configuredEnv };
		relayEnv.HOBO_CI_PUBLIC_URL = plan.publicOrigin;
		relayEnv.HOBO_CI_HOST = plan.host;
		relayEnv.HOBO_CI_PORT = String(plan.port);
		if (plan.allowInsecureLoopback)
			relayEnv.HOBO_CI_ALLOW_INSECURE_LOOPBACK = "1";
		relayEnv.HOBO_CI_GITHUB_APP_ID = credentials.appId;
		// The relay is handed its secrets in memory (below); its environment names
		// none, so the worker it may spawn inherits none.
		delete relayEnv.HOBO_CI_GITHUB_APP_KEY_FILE;
		delete relayEnv.HOBO_CI_WEBHOOK_SECRET_FILE;
		delete relayEnv.HOBO_CI_INGRESS_FORWARD_SECRET_FILE;
		relayEnv.HOBO_CI_CONTROL_TOKENS_FILE = credentials.tokenPath;
		const ingressForward = await readOptionalSecret(
			input.env,
			"HOBO_CI_INGRESS_FORWARD_SECRET",
			vault,
		);
		if (
			ingressForward !== undefined &&
			Buffer.byteLength(ingressForward, "utf8") < 32
		)
			throw new Error(
				"HOBO_CI_INGRESS_FORWARD_SECRET must be at least 32 bytes",
			);
		const secrets: RelaySecrets = {
			githubAppPrivateKey: credentials.privateKey,
			webhookSecret: credentials.webhookSecret,
			...(ingressForward !== undefined
				? { ingressForwardSecret: ingressForward }
				: undefined),
		};
		if (plan.trustProxy) relayEnv.HOBO_CI_TRUST_PROXY = "1";
		relayEnv.HOBO_CI_DB = dbPath;
		relayEnv.HOBO_CI_CONFIG = seedConfig;
		const relayJobs = parseRelayJobs(await readFile(plan.configPath, "utf8"));
		delete relayEnv.HOBO_CI_RELAY_JOBS_ANSWER;
		delete relayEnv.HOBO_CI_RELAY_JOBS_LABEL;
		if (relayJobs.answer) {
			relayEnv.HOBO_CI_RELAY_JOBS_ANSWER = "1";
			relayEnv.HOBO_CI_RELAY_JOBS_LABEL = relayJobs.label;
		}
		const stubEngines = plan.engines.filter(
			(engine) => engine !== "gh-actions",
		);
		if (stubEngines.length > 0)
			relayEnv.HOBO_CI_STUB_ENGINES = stubEngines.join(",");
		if (!plan.engines.includes("gh-actions"))
			throw new Error(
				"gh-actions engine is required for local relay serve today",
			);
		// The agent is part of the project's configuration: an `agent` block turns
		// it on. It keeps its journal and clones under this serve's state.
		const agentBlock = input.options.noAgent
			? undefined
			: parseCiAgentBlock(await readFile(plan.configPath, "utf8"));
		let startRelay: RelayStarter =
			input.startRelay ??
			((env, ports) =>
				startRelayFromEnvironment(env, {
					...ports,
					dashboard: createDashboardRoute(),
				}));
		if (agentBlock !== undefined) {
			relayEnv.HOBO_CI_AGENT_CONFIG = plan.configPath;
			relayEnv.HOBO_CI_AGENT_DIR = join(stateDir, "agent");
			startRelay = await loadAgentRelay();
		}
		serveLog(input.emitProgress, {
			ts: new Date().toISOString(),
			level: "info",
			event: "serve.starting",
			environment: plan.environmentName,
			publicOrigin: plan.publicOrigin,
			bind: { host: plan.host, port: plan.port },
			admission: plan.admission,
			trustProxy: plan.trustProxy,
			engines: plan.engines,
			agent: agentBlock !== undefined,
		});
		const running = await startRelay(relayEnv, { secrets });
		startupRelay = running;
		if (plan.admission === "pull") {
			if (plan.installationId === undefined)
				throw new Error("pull admission requires --installation-id");
			const github = createGithubAppTransport({
				appId: credentials.appId,
				privateKey: credentials.privateKey,
			});
			const poll = startPullAdmission({
				github,
				relay: running,
				repository: plan.repository,
				installationId: plan.installationId,
				emitProgress: input.emitProgress,
			});
			pollStop = () => poll.stop();
		}
		if (input.options.withWorker) {
			const workerEnv = ciWorkerEnvironment({
				relayEnv,
				store: plan.workerStore,
				stateDir,
			});
			const script =
				input.workerScript ??
				fileURLToPath(
					new URL(
						"../../ci-gh-actions/scripts/isolated-worker-daemon.mts",
						import.meta.url,
					),
				);
			// The App key and webhook secret go to the worker on an inherited pipe
			// (fd 3), written once and closed: in neither its environment nor a file.
			workerEnv[WORKER_SECRETS_FD] = "3";
			const started = spawn(process.execPath, ["--import", "tsx", script], {
				env: workerEnv,
				stdio: ["ignore", "inherit", "pipe", "pipe"],
			});
			worker = started;
			const pipe = started.stdio[3];
			if (pipe === null || pipe === undefined || !("end" in pipe))
				throw new Error("the CI worker's secrets pipe did not open");
			pipe.on("error", () => {});
			pipe.end(
				workerSecretsPayload({
					githubAppPrivateKey: credentials.privateKey,
					webhookSecret: credentials.webhookSecret,
				}),
			);
			// Serving is reported only once the worker says it is serving; an
			// early exit or a timeout fails startup, which stops the relay.
			const timeoutMs = Number(
				input.env.HOBO_CI_WORKER_START_TIMEOUT_MS ?? "600000",
			);
			await waitForWorkerStart(started, {
				timeoutMs:
					Number.isSafeInteger(timeoutMs) && timeoutMs > 0
						? timeoutMs
						: 600_000,
				forward: (chunk) => process.stderr.write(chunk),
			});
		}
		await running.service.checkReadiness();
		serveLog(input.emitProgress, {
			ts: new Date().toISOString(),
			level: "info",
			event: "serve.ready",
			publicOrigin: plan.publicOrigin,
		});
		return {
			origin: plan.publicOrigin,
			plan,
			async stop() {
				pollStop?.();
				if (worker) worker.kill("SIGTERM");
				try {
					await running.stop();
				} finally {
					vault.clear();
				}
			},
		};
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		try {
			pollStop?.();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		try {
			worker?.kill("SIGTERM");
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		try {
			await startupRelay?.stop();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		vault.clear();
		if (cleanupErrors.length > 0)
			throw new AggregateError(
				[error, ...cleanupErrors],
				"CI relay startup and cleanup failed",
			);
		throw error;
	}
}

export async function runCiServe(input: {
	cwd: string;
	options: CiServeOptions;
	env: NodeJS.ProcessEnv;
	git: (args: readonly string[], cwd: string) => Promise<string>;
	emitProgress?: (message: string) => void;
	waitUntilSignal?: boolean;
	/** Relay startup seam for lifecycle tests. */
	startRelay?: RelayStarter;
}): Promise<CommandResult> {
	try {
		if (input.options.printConfig) {
			const plan = await resolveCiServePlan(input);
			return {
				message: JSON.stringify(plan.redacted, null, 2),
			};
		}
		const handle = await startCiServe(input);
		try {
			input.emitProgress?.(
				`HoBo CI relay listening on ${handle.origin} (bind ${handle.plan.host}:${handle.plan.port}, ${handle.plan.admission} admission, environment ${handle.plan.environmentName}).`,
			);
		} catch (error) {
			try {
				await handle.stop();
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"CI relay reporting and cleanup failed",
				);
			}
			throw error;
		}
		if (input.waitUntilSignal === false) {
			return {
				message: `Serving HoBo CI at ${handle.origin}`,
				data: { origin: handle.origin, stop: handle.stop },
			};
		}
		await new Promise<void>((resolve, reject) => {
			const stop = () => {
				void handle
					.stop()
					.then(() => resolve())
					.catch(reject);
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});
		return { message: "HoBo CI relay stopped." };
	} catch (error) {
		return usage(
			error instanceof Error ? error.message : "hobo ci serve failed",
		);
	}
}
