import {
	type CapabilityRequirement,
	type CapabilityRequirementInput,
	parseCapabilityRequirement,
	type StructuredFeatureRequirementInput,
	type StructuredGuaranteeRequirementInput,
} from "@hobo/capability-profiles";
import { capability } from "@hobo/core";

import { KvRedisCompatibleError } from "./errors.js";

export const KV_KEY_VALUE_PROFILE = capability.kv.keyValue;
export const KV_REDIS_COMPATIBLE_PROFILE = capability.kv.redisCompatible;
export const KV_VALKEY_PROFILE = capability.kv.valkey;
export const KV_EPHEMERAL_STATE_PROFILE = capability.kv.ephemeralState;

export type KvRuntimeRequest = {
	readonly required?: string;
	readonly allowed?: readonly string[];
	readonly preferred?: readonly string[];
};

export type RedisStoreInput = {
	readonly ttl?: boolean;
	readonly atomicIncrement?: boolean;
	readonly atomicCompareAndSet?: boolean;
	readonly sortedSets?: boolean;
	readonly restTransport?: boolean;
	readonly minValueBytes?: number;
	readonly runtime?: KvRuntimeRequest;
	readonly realization?: CapabilityRequirementInput["realization"];
	readonly portability?: CapabilityRequirementInput["portability"];
	readonly trustRef?: string;
};

export type ValkeyStoreInput = RedisStoreInput;

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

export const redisCompatible = {
	store(input: RedisStoreInput = {}): CapabilityRequirement {
		return buildStoreRequirement(KV_REDIS_COMPATIBLE_PROFILE, input);
	},
} as const;

export const valkey = {
	store(input: ValkeyStoreInput = {}): CapabilityRequirement {
		return buildStoreRequirement(KV_VALKEY_PROFILE, input);
	},
} as const;
