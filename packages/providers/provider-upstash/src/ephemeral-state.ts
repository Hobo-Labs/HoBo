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

// public-contract: env names the Marketplace integration injects and the relay reads.
export const UPSTASH_REST_ENV_PAIRS = [
	{ url: "UPSTASH_REDIS_REST_URL", token: "UPSTASH_REDIS_REST_TOKEN" },
	{ url: "KV_REST_API_URL", token: "KV_REST_API_TOKEN" },
] as const;

export type UpstashRestEnvPair = (typeof UPSTASH_REST_ENV_PAIRS)[number];

export type UpstashRestEnv = {
	readonly source: UpstashRestEnvPair;
	readonly restEndpointUrl: string;
	readonly resolveToken: () => Promise<string>;
};

type Env = Readonly<Record<string, string | undefined>>;

const unavailable = (message: string) =>
	new KvRedisCompatibleError("EPHEMERAL_BINDING_UNAVAILABLE", message);

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
	readonly network:
		| { readonly transport: UpstashTransport }
		| { readonly fetchImpl: typeof globalThis.fetch };
	readonly policy?: TransportPolicy;
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
