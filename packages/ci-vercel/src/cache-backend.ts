/**
 * The hosted relay's cache backend, chosen from the deployment's bindings
 * (ADR-0179; [Relay ephemeral state](../../../docs/design/relay-ephemeral-state.md)).
 *
 * Only variable names are read here and logged; a value (a URL that carries a
 * password, a REST token) goes straight to the executor and nowhere else.
 *
 * Which backend: `selectCacheBackend` is the one seam. For now it takes the
 * first binding present, in a fixed order (Upstash REST, then Valkey or Redis
 * over TCP), and the in-memory engine only off Vercel. Phase 4c replaces the
 * order with policy-driven selection behind the same function.
 */
import {
	type EphemeralKey,
	type EphemeralStatePort,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "@hobo/core";
import {
	type CommandUsage,
	commandBudgetStatus,
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

/** Which backend serves the cache, and the variable names that bound it. */
export type CacheBackendChoice = Readonly<
	| {
			kind: "upstash-rest";
			names: readonly [url: string, token: string];
			/** Every binding the environment names, in precedence order. */
			candidates: readonly string[];
	  }
	| {
			kind: "redis-protocol";
			names: readonly [url: (typeof REDIS_URL_NAMES)[number]];
			candidates: readonly string[];
	  }
	| { kind: "memory"; names: readonly []; candidates: readonly string[] }
>;

/** Raised when no cache is bound where one must be. Names variables only. */
export class CacheBindingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CacheBindingError";
	}
}

/** Where the relay runs: on Vercel (production or preview), or not. */
function onVercel(env: Env): boolean {
	return env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";
}

/**
 * The cache backend this deployment binds, by a deterministic first choice:
 * a complete Upstash REST pair (`UPSTASH_REDIS_REST_*`, then `KV_REST_API_*`),
 * else `VALKEY_URL`, else `REDIS_URL`. With none, the in-memory engine, and
 * only off Vercel: a deployed relay with no cache refuses to start rather
 * than keep state each instance forgets.
 *
 * The seam phase 4c replaces with policy-driven selection.
 */
export function selectCacheBackend(env: Env): CacheBackendChoice {
	const candidates: string[] = [];
	for (const pair of UPSTASH_REST_ENV_PAIRS)
		if (env[pair.url] || env[pair.token]) candidates.push(pair.url);
	for (const name of REDIS_URL_NAMES) if (env[name]) candidates.push(name);
	// Throws, naming the variable, for a half-configured pair or a host
	// outside Upstash's data plane.
	const rest = resolveUpstashRestEnv(env);
	if (rest)
		return {
			kind: "upstash-rest",
			names: [rest.source.url, rest.source.token],
			candidates,
		};
	for (const name of REDIS_URL_NAMES) {
		const url = env[name];
		if (!url) continue;
		if (!/^rediss?:\/\//u.test(url))
			throw new CacheBindingError(
				`${name} must be a redis:// or rediss:// URL`,
			);
		return { kind: "redis-protocol", names: [name], candidates };
	}
	if (onVercel(env))
		throw new CacheBindingError(
			"no cache is bound: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN), or VALKEY_URL or REDIS_URL",
		);
	return { kind: "memory", names: [], candidates };
}

/** An opened cache: the port, the meter counting what it sends, and its close. */
export type OpenedCache = Readonly<{
	choice: CacheBackendChoice;
	state: EphemeralStatePort;
	meter: MeteredExecutor;
	close(): Promise<void>;
}>;

/**
 * Open the chosen backend with every command metered. The TCP client is
 * imported only when a Redis-protocol binding is chosen, so the REST binding
 * (the relay on Vercel) never loads a socket client.
 */
export async function openCacheBackend(
	choice: CacheBackendChoice,
	env: Env,
	options: Readonly<{ fetch?: typeof fetch }> = {},
): Promise<OpenedCache> {
	let meter: MeteredExecutor | undefined;
	const wrap = (executor: KvRedisExecutor) => {
		meter = meterExecutor(executor);
		return meter;
	};
	if (choice.kind === "upstash-rest") {
		const rest = resolveUpstashRestEnv(env);
		if (!rest) throw new CacheBindingError(`${choice.names[0]} is not set`);
		const state = createUpstashEphemeralState({
			restEndpointUrl: rest.restEndpointUrl,
			resolveToken: rest.resolveToken,
			network: { fetchImpl: options.fetch ?? fetch },
			wrap,
		});
		return opened(choice, state, meter, async () => {});
	}
	if (choice.kind === "redis-protocol") {
		const url = env[choice.names[0]];
		if (!url) throw new CacheBindingError(`${choice.names[0]} is not set`);
		const { createRespEphemeralState } = await import(
			"@hobo/kv-redis-compatible/resp"
		);
		const resp = createRespEphemeralState({ url, wrap });
		return opened(choice, resp.state, meter, () => resp.close());
	}
	const state = createRedisEphemeralState({
		executor: wrap(createMemoryRedisExecutor()),
	});
	return opened(choice, state, meter, async () => {});
}

function opened(
	choice: CacheBackendChoice,
	state: EphemeralStatePort,
	meter: MeteredExecutor | undefined,
	close: () => Promise<void>,
): OpenedCache {
	if (!meter) throw new Error("cache executor was not metered");
	return Object.freeze({ choice, state, meter, close });
}

/** A month's command total and where it is heading, against the allowance. */
export type CacheCommandReport = Readonly<{
	event: "hobo_ci_cache_commands";
	backend: CacheBackendChoice["kind"];
	month: string;
	/** Commands every instance has added to the month's counter so far. */
	used: number;
	/** `used`, extrapolated to the end of the month at the month's rate so far. */
	projected: number;
	allowance: number;
	overBudget: boolean;
	/** This instance's commands since its last report, by verb. */
	byVerb: Readonly<Record<string, number>>;
}>;

const DAY_MS = 24 * 60 * 60_000;
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

/**
 * The cache's command meter, reported against the monthly allowance.
 *
 * Each instance adds what it sent since its last report to one counter per
 * calendar month in the cache (one `INCRBY`, at most once a minute), so the
 * total covers every instance; the report is a log line, values never
 * included. The counter lapses 30 days after the month's first report (the
 * port's TTL cap), so on the 31st day of a month it can restart: the
 * projection is a guide, not a bill.
 */
export function createCacheCommandMeter(
	options: Readonly<{
		cache: OpenedCache;
		environment: string;
		allowance: number;
		now?: () => number;
		intervalMs?: number;
		log?: (report: CacheCommandReport) => void;
	}>,
) {
	const now = options.now ?? Date.now;
	const intervalMs = options.intervalMs ?? 60_000;
	let reported: CommandUsage = { total: 0, byVerb: {} };
	let lastAt = Number.NEGATIVE_INFINITY;
	let pending: Promise<CacheCommandReport | undefined> | undefined;
	const key = (month: string): EphemeralKey =>
		parseEphemeralKey(`hobo-ci:${options.environment}:meter:commands:${month}`);
	async function report(): Promise<CacheCommandReport | undefined> {
		const at = new Date(now());
		const usage = options.cache.meter.usage();
		const delta = usage.total - reported.total;
		const byVerb: Record<string, number> = {};
		for (const [verb, count] of Object.entries<number>(usage.byVerb)) {
			const added = count - (reported.byVerb[verb] ?? 0);
			if (added > 0) byVerb[verb] = added;
		}
		reported = { total: usage.total, byVerb: { ...usage.byVerb } };
		lastAt = at.getTime();
		const month = at.toISOString().slice(0, 7);
		// The report's own increment is counted from the next report on.
		const used = await options.cache.state.increment(
			key(month),
			delta,
			parseEphemeralTtlMs(30 * DAY_MS),
			"on-create",
		);
		const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
		const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
		const status = commandBudgetStatus({
			used,
			allowance: options.allowance,
			elapsedFraction: (at.getTime() - start) / (end - start),
		});
		const line: CacheCommandReport = {
			event: "hobo_ci_cache_commands",
			backend: options.cache.choice.kind,
			month,
			used,
			projected: status.projected,
			allowance: options.allowance,
			overBudget: status.overBudget,
			byVerb,
		};
		options.log?.(line);
		return line;
	}
	return {
		/** Report now (a repair tick), whatever the interval. */
		flush(): Promise<CacheCommandReport | undefined> {
			pending ??= report().finally(() => {
				pending = undefined;
			});
			return pending;
		},
		/** Report if the interval has passed since this instance last did. */
		async maybeFlush(): Promise<CacheCommandReport | undefined> {
			if (now() - lastAt < intervalMs) return undefined;
			return this.flush();
		},
	};
}
