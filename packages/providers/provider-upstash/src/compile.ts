/**
 * The pure compiler.
 *
 * A total function from a resource spec to the plan that provisions it. No
 * clock, no network, no randomness, no environment, no filesystem — which is
 * what makes a plan diffable, cacheable, and reviewable before anything is
 * created.
 *
 * The idempotency key is an *input*, not something generated here. That is the
 * whole reason this compiles cleanly: the key doubles as the database id at
 * the provider, so it is identity, and identity that a compiler invented would
 * change on every recompile and turn one intended database into many.
 */

import { UPSTASH_START_REDIS_URL } from "./client.js";
import {
	UPSTASH_BINDING_PROFILE_REFS,
	UPSTASH_BOOTSTRAP_STRATEGY_REF,
	UPSTASH_CLAIM_ACTION_COUNT,
	UPSTASH_CLAIM_STRATEGY_REF,
	UPSTASH_DEFINITION_ID,
	UPSTASH_PROVIDER_ID,
	UPSTASH_UNCLAIMED_LIMITS,
} from "./definition.js";
import { UpstashProviderError } from "./errors.js";

export type UpstashResourceSpec = {
	/** HoBo-side resource identity this database is bound to. */
	readonly resourceRef: string;
	/**
	 * A UUIDv4 the caller owns and persists. Same key, same database, forever.
	 */
	readonly idempotencyKey: string;
	/** Overrides the control-plane URL. For a recorded-transport test only. */
	readonly startRedisUrl?: string;
};

export type UpstashPlannedRequest = {
	readonly method: "POST";
	readonly url: string;
	readonly idempotencyKey: string;
	/** Header names only. A value would be a credential or a fingerprint. */
	readonly headerNames: readonly string[];
	readonly hasBody: false;
};

export type UpstashCompiledPlan = {
	readonly schemaVersion: "hobo.provider-upstash.plan/v1";
	readonly definitionId: typeof UPSTASH_DEFINITION_ID;
	readonly providerId: typeof UPSTASH_PROVIDER_ID;
	readonly resourceRef: string;
	readonly bindingId: string;
	readonly create: UpstashPlannedRequest;
	/** Byte-identical to `create`: adoption is a repeat, not a new call. */
	readonly adopt: UpstashPlannedRequest;
	readonly bootstrapStrategyRef: typeof UPSTASH_BOOTSTRAP_STRATEGY_REF;
	readonly claimStrategyRef: typeof UPSTASH_CLAIM_STRATEGY_REF;
	readonly claimActionCount: number;
	readonly producesBindingProfiles: readonly string[];
	readonly documentedExpiryHours: number;
	/** Stated up front so a plan reviewer sees the teardown story before the create. */
	readonly teardown: "expiry-only";
};

const RESOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function compileUpstashTemporaryRedis(
	spec: UpstashResourceSpec,
): UpstashCompiledPlan {
	if (!RESOURCE_REF.test(spec.resourceRef)) {
		throw new UpstashProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"resourceRef must be a short identifier; it is used to scope secret custody",
		);
	}
	if (!UUID_V4.test(spec.idempotencyKey)) {
		throw new UpstashProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"idempotency key must be a lowercase UUIDv4; the provider derives the database id from it",
		);
	}

	const request: UpstashPlannedRequest = {
		method: "POST",
		url: spec.startRedisUrl ?? UPSTASH_START_REDIS_URL,
		idempotencyKey: spec.idempotencyKey,
		headerNames: ["accept", "idempotency-key", "user-agent"],
		hasBody: false,
	};

	return {
		schemaVersion: "hobo.provider-upstash.plan/v1",
		definitionId: UPSTASH_DEFINITION_ID,
		providerId: UPSTASH_PROVIDER_ID,
		resourceRef: spec.resourceRef,
		bindingId: `${spec.resourceRef}#redis-rest`,
		create: request,
		adopt: request,
		bootstrapStrategyRef: UPSTASH_BOOTSTRAP_STRATEGY_REF,
		claimStrategyRef: UPSTASH_CLAIM_STRATEGY_REF,
		claimActionCount: UPSTASH_CLAIM_ACTION_COUNT,
		producesBindingProfiles: [...UPSTASH_BINDING_PROFILE_REFS],
		documentedExpiryHours: UPSTASH_UNCLAIMED_LIMITS.documentedExpiryHours,
		teardown: "expiry-only",
	};
}
