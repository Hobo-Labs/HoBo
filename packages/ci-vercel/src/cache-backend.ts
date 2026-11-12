/**
 * The hosted relay's cache backends: every one the deployment binds, opened
 * and metered in the units each one bills (ADR-0179;
 * [Relay ephemeral state](../../../docs/design/relay-ephemeral-state.md)).
 *
 * Only variable names are read here and logged; a value (a URL that carries a
 * password, a REST or database token) goes straight to its client and nowhere
 * else, not even into an error message.
 *
 * Which of them is active is not decided here: `cache-fleet.ts` reads it from
 * the fleet's assignment register and routes every call to it (phase 4c).
 * This file only answers which backends exist, in a fixed configured order
 * (Upstash REST, Valkey, Redis, Turso, Vercel Blob), and opens them. The
 * in-memory engine is a member only off Vercel and only when nothing else is
 * bound: a deployed relay with no cache refuses to start rather than keep
 * state each instance forgets.
 */
import type { FleetUsageUnit } from "@hobo/backend-fleet";
import type { EphemeralStatePort } from "@hobo/core";
import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
	type KvRedisExecutor,
	type MeteredExecutor,
	meterExecutor,
} from "@hobo/kv-redis-compatible";
import {
	createUpstashEphemeralState,
	resolveUpstashRestEnv,
	UPSTASH_REST_ENV_PAIRS,
} from "@hobo/provider-upstash";

type Env = Readonly<Record<string, string | undefined>>;

/** The variables a Redis-protocol binding over TCP is read from, in order. */
const REDIS_URL_NAMES = ["VALKEY_URL", "REDIS_URL"] as const;
/** The Turso Marketplace integration's names (`@hobo/provider-turso`). */
const TURSO_NAMES = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"] as const;
/** A connected Blob store's id (`@hobo/provider-vercel-blob`); OIDC does the rest. */
const BLOB_STORE_NAME = "BLOB_STORE_ID";

export const CACHE_BACKEND_KINDS = [
	"upstash-rest",
	"redis-protocol",
	"libsql",
	"vercel-blob",
	"memory",
] as const;
export type CacheBackendKind = (typeof CACHE_BACKEND_KINDS)[number];

/** A member's id in the cache fleet: stable, short, and never a value. */
export const CACHE_BACKEND_IDS = [
	"upstash",
	"valkey",
	"redis",
	"turso",
	"blob",
	"memory",
] as const;
export type CacheBackendId = (typeof CACHE_BACKEND_IDS)[number];

/** One bound backend: its fleet id, its kind, and the variable names that bound it. */
export type CacheBackendBinding = Readonly<{
	id: CacheBackendId;
	kind: CacheBackendKind;
	names: readonly string[];
}>;

/** What the deployment binds, in configured order. */
export type CacheBindings = Readonly<{
	members: readonly CacheBackendBinding[];
	/** Every cache variable the environment names, bound or not. Names only. */
	candidates: readonly string[];
}>;

/** Raised when no cache is bound where one must be. Names variables only. */
export class CacheBindingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CacheBindingError";
	}
}

/** Where the relay runs: on Vercel (production or preview), or not. */
export function onVercel(env: Env): boolean {
	return env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";
}

const present = (value: string | undefined) =>
	value !== undefined && value.trim() !== "";

/**
 * Every cache this deployment binds, in configured order: a complete Upstash
 * REST pair (`UPSTASH_REDIS_REST_*`, then `KV_REST_API_*`), `VALKEY_URL`,
 * `REDIS_URL` (a member only when it is not the same URL as `VALKEY_URL`),
 * the Turso pair, and `BLOB_STORE_ID`. With none, the in-memory engine, and
 * only off Vercel. A half-configured pair or a malformed URL is an error that
 * names the variable.
 */
export function discoverCacheBackends(env: Env): CacheBindings {
	const candidates: string[] = [];
	const members: CacheBackendBinding[] = [];
	for (const pair of UPSTASH_REST_ENV_PAIRS)
		if (env[pair.url] || env[pair.token]) candidates.push(pair.url);
	for (const name of REDIS_URL_NAMES) if (env[name]) candidates.push(name);
	for (const name of TURSO_NAMES) if (env[name]) candidates.push(name);
	if (env[BLOB_STORE_NAME]) candidates.push(BLOB_STORE_NAME);

	// Throws, naming the variable, for a half-configured pair or a host
	// outside Upstash's data plane.
	const rest = resolveUpstashRestEnv(env);
	if (rest)
		members.push({
			id: "upstash",
			kind: "upstash-rest",
			names: [rest.source.url, rest.source.token],
		});
	for (const name of REDIS_URL_NAMES) {
		const url = env[name];
		if (!present(url)) continue;
		if (!/^rediss?:\/\//u.test(url ?? ""))
			throw new CacheBindingError(
				`${name} must be a redis:// or rediss:// URL`,
			);
		if (name === "REDIS_URL" && url === env.VALKEY_URL) continue;
		members.push({
			id: name === "VALKEY_URL" ? "valkey" : "redis",
			kind: "redis-protocol",
			names: [name],
		});
	}
	const [tursoUrl, tursoToken] = TURSO_NAMES;
	if (present(env[tursoUrl]) || present(env[tursoToken])) {
		if (!present(env[tursoUrl]) || !present(env[tursoToken]))
			throw new CacheBindingError(
				`${present(env[tursoUrl]) ? tursoToken : tursoUrl} is not set although ${present(env[tursoUrl]) ? tursoUrl : tursoToken} is`,
			);
		members.push({ id: "turso", kind: "libsql", names: [...TURSO_NAMES] });
	}
	if (present(env[BLOB_STORE_NAME]))
		members.push({
			id: "blob",
			kind: "vercel-blob",
			names: [BLOB_STORE_NAME],
		});
	if (members.length > 0) return { members, candidates };
	if (onVercel(env))
		throw new CacheBindingError(
			"no cache is bound: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN), VALKEY_URL or REDIS_URL, TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, or BLOB_STORE_ID",
		);
	return {
		members: [{ id: "memory", kind: "memory", names: [] }],
		candidates,
	};
}

/** The units each kind of backend bills, in the order a report lists them. */
export const CACHE_BILLED_UNITS: Readonly<
	Record<CacheBackendKind, readonly FleetUsageUnit[]>
> = Object.freeze({
	"upstash-rest": ["commands"],
	"redis-protocol": ["commands"],
	memory: ["commands"],
	libsql: ["rows-read", "rows-written"],
	"vercel-blob": ["simple-operations", "advanced-operations"],
});

export type CacheUsage = Readonly<Partial<Record<FleetUsageUnit, number>>>;

/**
 * An opened backend: the port, what it has cost since it was opened (in the
 * units it bills, counted at its client), and its close.
 */
export type OpenedCacheBackend = Readonly<{
	binding: CacheBackendBinding;
	state: EphemeralStatePort;
	units: readonly FleetUsageUnit[];
	usage(): CacheUsage;
	close(): Promise<void>;
}>;

export type OpenCacheOptions = Readonly<{
	fetch?: typeof fetch;
	/** Tests: the Blob SDK stand-in (`createMemoryBlobSdk`). */
	blobSdk?: import("@hobo/provider-vercel-blob").VercelBlobSdk;
}>;

function commandsBackend(
	binding: CacheBackendBinding,
	open: (wrap: (executor: KvRedisExecutor) => MeteredExecutor) => Readonly<{
		state: EphemeralStatePort;
		close(): Promise<void>;
	}>,
): OpenedCacheBackend {
	let meter: MeteredExecutor | undefined;
	const opened = open((executor) => {
		meter = meterExecutor(executor);
		return meter;
	});
	const metered = meter;
	if (!metered) throw new Error("cache executor was not metered");
	return Object.freeze({
		binding,
		state: opened.state,
		units: CACHE_BILLED_UNITS[binding.kind],
		usage: () => ({ commands: metered.usage().total }),
		close: () => opened.close(),
	});
}

/**
 * Open one bound backend with every call metered. A client is imported only
 * when its binding is present, so a deployment bound to Upstash REST alone
 * never loads a socket, libSQL or Blob client.
 */
export async function openCacheBackend(
	binding: CacheBackendBinding,
	env: Env,
	options: OpenCacheOptions = {},
): Promise<OpenedCacheBackend> {
	switch (binding.kind) {
		case "upstash-rest": {
			const rest = resolveUpstashRestEnv(env);
			if (!rest) throw new CacheBindingError(`${binding.names[0]} is not set`);
			return commandsBackend(binding, (wrap) => ({
				state: createUpstashEphemeralState({
					restEndpointUrl: rest.restEndpointUrl,
					resolveToken: rest.resolveToken,
					network: { fetchImpl: options.fetch ?? fetch },
					wrap,
				}),
				close: async () => {},
			}));
		}
		case "redis-protocol": {
			const name = binding.names[0] ?? "VALKEY_URL";
			const url = env[name];
			if (!url) throw new CacheBindingError(`${name} is not set`);
			const { createRespEphemeralState } = await import(
				"@hobo/kv-redis-compatible/resp"
			);
			return commandsBackend(binding, (wrap) => {
				const resp = createRespEphemeralState({ url, wrap });
				return { state: resp.state, close: () => resp.close() };
			});
		}
		case "libsql": {
			const turso = await import("@hobo/provider-turso");
			const meter = turso.createLibsqlUsageMeter();
			const tursoOptions: Parameters<
				typeof turso.createTursoEphemeralState
			>[0] = {
				env,
				wrap: (client) =>
					turso.meterLibsqlClient(client, { onRequest: meter.onRequest }),
				onRows: meter.onRows,
			};
			const withFetch = options.fetch
				? { ...tursoOptions, fetch: options.fetch }
				: tursoOptions;
			let opened: ReturnType<typeof turso.createTursoEphemeralState>;
			try {
				opened = turso.createTursoEphemeralState(withFetch);
			} catch (error) {
				// The provider's message names variables only.
				throw new CacheBindingError(
					error instanceof Error ? error.message : "Turso binding refused",
				);
			}
			if (!opened) throw new CacheBindingError("TURSO_DATABASE_URL is not set");
			const client = opened;
			return Object.freeze({
				binding,
				state: client.port,
				units: CACHE_BILLED_UNITS.libsql,
				usage: () => {
					const usage = meter.usage();
					return {
						"rows-read": usage.rowsRead,
						"rows-written": usage.rowsWritten,
					};
				},
				close: async () => client.close(),
			});
		}
		case "vercel-blob": {
			const blob = await import("@hobo/provider-vercel-blob");
			const sdk = blob.meterVercelBlobSdk(
				options.blobSdk ?? blob.vercelBlobSdk,
			);
			let opened: ReturnType<typeof blob.createVercelBlobEphemeralStateFromEnv>;
			try {
				opened = blob.createVercelBlobEphemeralStateFromEnv({ env, sdk });
			} catch (error) {
				throw new CacheBindingError(
					error instanceof Error ? error.message : "Blob binding refused",
				);
			}
			if (!opened) throw new CacheBindingError(`${BLOB_STORE_NAME} is not set`);
			const port = opened.port;
			return Object.freeze({
				binding,
				state: port,
				units: CACHE_BILLED_UNITS["vercel-blob"],
				usage: () => {
					const usage = sdk.usage();
					return {
						"simple-operations": usage.simple,
						"advanced-operations": usage.advanced,
					};
				},
				close: async () => {},
			});
		}
		case "memory":
			return commandsBackend(binding, (wrap) => ({
				state: createRedisEphemeralState({
					executor: wrap(createMemoryRedisExecutor()),
				}),
				close: async () => {},
			}));
	}
}

/** Open every member; if one fails to open, close the ones already opened. */
export async function openCacheBackends(
	bindings: CacheBindings,
	env: Env,
	options: OpenCacheOptions = {},
): Promise<readonly OpenedCacheBackend[]> {
	const opened: OpenedCacheBackend[] = [];
	try {
		for (const binding of bindings.members)
			opened.push(await openCacheBackend(binding, env, options));
	} catch (error) {
		await Promise.all(
			opened.map((backend) => backend.close().catch(() => undefined)),
		);
		throw error;
	}
	return opened;
}

/**
 * Cache bindings the config service may hold as well as the deployment's
 * environment (an Aiven Valkey URL is stored there, ADR-0179). A name the
 * environment sets keeps the environment's value; the config service fills in
 * the rest. Returns the merged bindings and which names came from the config
 * service, never a value.
 */
export const CACHE_CONFIG_KEYS = [
	"VALKEY_URL",
	"TURSO_DATABASE_URL",
	"TURSO_AUTH_TOKEN",
	"BLOB_STORE_ID",
] as const;

/** The merged cache bindings, and which names the config service supplied. */
export type CacheBindingEnv = Readonly<{
	env: Env;
	fromConfig: readonly string[];
}>;

export function cacheBindingEnv(
	env: Env,
	config: Readonly<
		Partial<Record<(typeof CACHE_CONFIG_KEYS)[number], string | undefined>>
	>,
): CacheBindingEnv {
	const merged = { ...env };
	const fromConfig: string[] = [];
	for (const name of CACHE_CONFIG_KEYS) {
		const value = config[name];
		if (present(merged[name]) || !present(value)) continue;
		merged[name] = value;
		fromConfig.push(name);
	}
	return { env: merged, fromConfig };
}

/** The default allowance: the Upstash free tier's monthly commands (vendor's figure; re-check). */
export const DEFAULT_MONTHLY_CACHE_COMMANDS = 500_000;

/** `HOBO_CI_CACHE_MONTHLY_COMMANDS`, or the free-tier default. */
export function monthlyCommandAllowance(env: Env): number {
	const raw = env.HOBO_CI_CACHE_MONTHLY_COMMANDS;
	if (raw === undefined || raw === "") return DEFAULT_MONTHLY_CACHE_COMMANDS;
	if (!/^[1-9]\d{0,11}$/u.test(raw))
		throw new CacheBindingError(
			"HOBO_CI_CACHE_MONTHLY_COMMANDS must be a positive whole number",
		);
	return Number(raw);
}
