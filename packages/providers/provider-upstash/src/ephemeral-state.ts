/**
 * `EphemeralStatePort` over the Upstash REST API.
 *
 * Nothing Upstash-specific happens above the executor: this is the shared
 * Redis-protocol binding from `@hobo/kv-redis-compatible` — the same Lua
 * scripts a self-hosted Valkey runs over TCP — sent as `EVALSHA`/`EVAL` in the
 * REST envelope by `createUpstashRestExecutor`. It needs `fetch` and nothing
 * else: no SDK, no socket client, no native module, so it bundles lean into a
 * serverless function.
 *
 * Environment. A Vercel Marketplace Upstash integration injects the REST pair
 * under one of two naming schemes; the `@upstash/redis` SDK's `fromEnv()`
 * reads the same two, in the same order (source checked 2026-11-11:
 * packages/redis/platforms/nodejs.ts in upstash/redis-js). Only names are read
 * here; values go straight to the executor and are never logged or echoed.
 */
import type { EphemeralStatePort } from "@hobo/core";
import {
	createRedisEphemeralState,
	KvRedisCompatibleError,
	type KvRedisExecutor,
} from "@hobo/kv-redis-compatible";

import { createUpstashRestExecutor } from "./rest-executor.js";
import {
	assertAllowedEndpoint,
	createFetchTransport,
	type TransportPolicy,
	UPSTASH_DATA_PLANE_POLICY,
	type UpstashTransport,
} from "./transport.js";

/**
 * REST URL/token variable pairs, in precedence order.
 *
 * `UPSTASH_REDIS_REST_*` is Upstash's own naming; `KV_REST_API_*` is the
 * naming Vercel KV used and the Marketplace integration still injects for
 * stores migrated from it. A pair is used only whole — a URL from one scheme
 * is never combined with a token from the other.
 */
// public-contract: env names the Marketplace integration injects and the relay reads.
export const UPSTASH_REST_ENV_PAIRS = [
	{ url: "UPSTASH_REDIS_REST_URL", token: "UPSTASH_REDIS_REST_TOKEN" },
	{ url: "KV_REST_API_URL", token: "KV_REST_API_TOKEN" },
] as const;

export type UpstashRestEnvPair = (typeof UPSTASH_REST_ENV_PAIRS)[number];

export type UpstashRestEnv = {
	/** The variable names that supplied the binding — safe to log. */
	readonly source: UpstashRestEnvPair;
	readonly restEndpointUrl: string;
	/** Reads the token variable at call time, so a rotated value is picked up. */
	readonly resolveToken: () => Promise<string>;
};

type Env = Readonly<Record<string, string | undefined>>;

const unavailable = (message: string) =>
	new KvRedisCompatibleError("EPHEMERAL_BINDING_UNAVAILABLE", message);

/**
 * The first complete REST pair in `env`, or `undefined` when neither scheme is
 * configured. A half-configured pair is an error naming the missing variable.
 */
export function resolveUpstashRestEnv(
	env: Env,
	policy: TransportPolicy = UPSTASH_DATA_PLANE_POLICY,
): UpstashRestEnv | undefined {
	for (const pair of UPSTASH_REST_ENV_PAIRS) {
		const url = env[pair.url];
		const token = env[pair.token];
		if (!url && !token) continue;
		if (!url || !token) {
			throw unavailable(
				`${url ? pair.token : pair.url} is not set although ${url ? pair.url : pair.token} is`,
			);
		}
		try {
			assertAllowedEndpoint(url, policy);
		} catch {
			throw unavailable(
				`${pair.url} is not an https URL on an allowed Upstash data-plane host`,
			);
		}
		return {
			source: pair,
			restEndpointUrl: url,
			async resolveToken() {
				const current = env[pair.token];
				if (!current) throw unavailable(`${pair.token} is no longer set`);
				return current;
			},
		};
	}
	return undefined;
}

export type UpstashEphemeralStateOptions = {
	readonly restEndpointUrl: string;
	readonly resolveToken: () => Promise<string>;
	/**
	 * The network, handed over by the host: a ready transport, or the `fetch`
	 * to build the bounded one from. This package never reaches for a global.
	 */
	readonly network:
		| { readonly transport: UpstashTransport }
		| { readonly fetchImpl: typeof globalThis.fetch };
	readonly policy?: TransportPolicy;
	/** Wrap the executor, e.g. with `meterExecutor` to count billed commands. */
	readonly wrap?: (executor: KvRedisExecutor) => KvRedisExecutor;
};

export function createUpstashEphemeralState(
	options: UpstashEphemeralStateOptions,
): EphemeralStatePort {
	const transport =
		"transport" in options.network
			? options.network.transport
			: createFetchTransport({ fetchImpl: options.network.fetchImpl });
	const executor = createUpstashRestExecutor({
		transport,
		restEndpointUrl: options.restEndpointUrl,
		resolveToken: options.resolveToken,
		policy: options.policy ?? UPSTASH_DATA_PLANE_POLICY,
	});
	return createRedisEphemeralState({
		executor: options.wrap ? options.wrap(executor) : executor,
	});
}
