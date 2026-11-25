/**
 * Authoring helpers for Redis-compatible key/value storage.
 *
 * `redisCompatible.store({ ttl: true })` is a semantic ask. There is no
 * product, provider, region, or account anywhere in this API, and the
 * requirement it returns is the same one a Valkey product or a self-hosted
 * Redis satisfies. That is the whole point: the Bindle author never learns
 * which one was selected.
 */
import {
	type CapabilityRequirement,
	type CapabilityRequirementInput,
	parseCapabilityRequirement,
	type StructuredFeatureRequirementInput,
	type StructuredGuaranteeRequirementInput,
} from "@hobo/capability-profiles";

import { KvRedisCompatibleError } from "./errors.js";

// public-contract: capability profile id the registry resolves.
export const KV_KEY_VALUE_PROFILE = "kv.key-value/v1" as const;
// public-contract: capability profile id the registry resolves.
export const KV_REDIS_COMPATIBLE_PROFILE = "kv.redis-compatible/v1" as const;
// public-contract: capability profile id the registry resolves.
export const KV_VALKEY_PROFILE = "kv.valkey/v1" as const;
/**
 * Short-lived, loss-tolerant state behind `EphemeralStatePort` (TTL,
 * compare-and-set, increment, locks, a capped ring), refining
 * `kv.key-value/v1`. Satisfied by any binding that passes
 * `EPHEMERAL_STATE_CONFORMANCE_CASES`: every Redis-protocol store through the
 * shared Lua binding, libSQL, and Vercel Blob. The hosted CI relay requires
 * only this profile of its cache (ADR-0179).
 */
// public-contract: capability profile id the registry resolves.
export const KV_EPHEMERAL_STATE_PROFILE = "kv.ephemeral-state/v1" as const;

/** Runtime models a Bindle may ask its store to be reachable from. */
export type KvRuntimeRequest = {
	readonly required?: string;
	readonly allowed?: readonly string[];
	readonly preferred?: readonly string[];
};

export type RedisStoreInput = {
	/** Per-key expiry (`SET ... EX`, `TTL`, `PERSIST`). */
	readonly ttl?: boolean;
	/** Atomic `INCR`/`INCRBY` on a counter key. */
	readonly atomicIncrement?: boolean;
	/** Atomic create-if-absent (`SET ... NX`), the lock primitive. */
	readonly atomicCompareAndSet?: boolean;
	/** Sorted-set commands (`ZADD`, `ZRANGE`, `ZSCORE`). */
	readonly sortedSets?: boolean;
	/** An HTTP/REST command transport, for runtimes with no outbound TCP. */
	readonly restTransport?: boolean;
	/** Smallest single value the workload must be able to store, in bytes. */
	readonly minValueBytes?: number;
	readonly runtime?: KvRuntimeRequest;
	readonly realization?: CapabilityRequirementInput["realization"];
	readonly portability?: CapabilityRequirementInput["portability"];
	readonly trustRef?: string;
};

export type ValkeyStoreInput = RedisStoreInput;

/**
 * The feature keys this builder is allowed to emit.
 *
 * `ttl`, `atomicIncrement`, `sortedSets`, and `restTransport` are declared by
 * the `kv.*` profile descriptors in `@hobo/capability-profiles`.
 * `atomicCompareAndSet` is not yet in that catalog; it is emitted here because
 * `SET ... NX` is the primitive every distributed lock is built on, and the
 * conformance suite substantiates it. Selection matches structured capability
 * keys directly, so an undeclared key still gates correctly — an implementation
 * that does not advertise it is simply absent, and absent fails a required gate.
 */
const REDIS_FEATURE_KEYS = [
	"ttl",
	"atomicIncrement",
	"atomicCompareAndSet",
	"sortedSets",
	"restTransport",
] as const;

function booleanFeatures(
	input: RedisStoreInput,
): readonly StructuredFeatureRequirementInput[] {
	// Explicit `| undefined` on each field: under `exactOptionalPropertyTypes`,
	// "may be absent" and "may be present and undefined" are different types, and
	// these are copied straight off an input whose own fields are optional.
	interface RedisFeatureFlags {
		ttl?: boolean | undefined;
		atomicIncrement?: boolean | undefined;
		atomicCompareAndSet?: boolean | undefined;
		sortedSets?: boolean | undefined;
		restTransport?: boolean | undefined;
	}
	const requested: RedisFeatureFlags = {
		ttl: input.ttl,
		atomicIncrement: input.atomicIncrement,
		atomicCompareAndSet: input.atomicCompareAndSet,
		sortedSets: input.sortedSets,
		restTransport: input.restTransport,
	};
	const features: StructuredFeatureRequirementInput[] = [];
	for (const key of REDIS_FEATURE_KEYS) {
		const value = requested[key];
		if (value !== true) continue;
		features.push({
			key,
			operator: "equals",
			value: true,
			necessity: "required",
		});
	}
	return features;
}

function valueSizeFeature(
	minValueBytes: number | undefined,
): readonly StructuredFeatureRequirementInput[] {
	if (minValueBytes === undefined) return [];
	if (!Number.isInteger(minValueBytes) || minValueBytes <= 0) {
		throw new KvRedisCompatibleError(
			"INVALID_KV_REQUIREMENT",
			"minValueBytes must be a positive integer number of bytes",
		);
	}
	return [
		{
			key: "maxValueBytes",
			operator: "at-least",
			value: minValueBytes,
			necessity: "required",
		},
	];
}

/**
 * Redis command semantics are the guarantee, not a feature: a product that
 * merely exposes GET/SET over HTTP does not satisfy this profile.
 */
const REDIS_GUARANTEES: readonly StructuredGuaranteeRequirementInput[] = [
	{ key: "redisCommandSemantics", operator: "equals", value: true },
];

function buildStoreRequirement(
	profileId: typeof KV_REDIS_COMPATIBLE_PROFILE | typeof KV_VALKEY_PROFILE,
	input: RedisStoreInput,
): CapabilityRequirement {
	const requirement: CapabilityRequirementInput = {
		requiredProfiles: [{ profileId, versionRange: ">=1" }],
		features: [
			...booleanFeatures(input),
			...valueSizeFeature(input.minValueBytes),
		],
		guarantees: REDIS_GUARANTEES,
		...(input.runtime !== undefined ? { runtime: input.runtime } : undefined),
		...(input.realization !== undefined
			? { realization: input.realization }
			: undefined),
		...(input.portability !== undefined
			? { portability: input.portability }
			: undefined),
		...(input.trustRef !== undefined
			? { trustRef: input.trustRef }
			: undefined),
	};
	return parseCapabilityRequirement(requirement);
}

/**
 * Redis-compatible store authoring.
 *
 * Deliberately absent: any way to ask for a queue or a topic. Redis lists and
 * pub/sub exist, but asking for them here would let a `kv` selection satisfy a
 * delivery requirement it has never been conformance-tested against. See
 * {@link ./separation.ts}.
 */
export const redisCompatible = {
	store(input: RedisStoreInput = {}): CapabilityRequirement {
		return buildStoreRequirement(KV_REDIS_COMPATIBLE_PROFILE, input);
	},
} as const;

/** Valkey store authoring. Refines the Redis-compatible profile. */
export const valkey = {
	store(input: ValkeyStoreInput = {}): CapabilityRequirement {
		return buildStoreRequirement(KV_VALKEY_PROFILE, input);
	},
} as const;
