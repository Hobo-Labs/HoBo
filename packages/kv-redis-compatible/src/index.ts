export {
	CONFORMANCE_AREAS,
	type ConformanceArea,
	type ConformanceCase,
	type ConformanceStep,
	type ConsistencyClaim,
	KV_REDIS_CONFORMANCE_CASES,
	KV_REDIS_CONSISTENCY_CLAIMS,
} from "./cases.js";
export {
	EPHEMERAL_STATE_CONFORMANCE_CASES,
	type EphemeralConformanceArea,
	type EphemeralConformanceCase,
	type EphemeralConformanceContext,
	EphemeralConformanceFailure,
	type EphemeralConformanceResult,
	runEphemeralStateConformance,
} from "./ephemeral-conformance.js";
export {
	createManualClock,
	createMemoryEphemeralState,
	createMemoryRedisExecutor,
	type ManualClock,
	type MemoryEphemeralStateOptions,
	type MemoryRedisExecutor,
	type MemoryRedisExecutorOptions,
} from "./ephemeral-memory.js";
export {
	type CommandUsage,
	commandBudgetStatus,
	type MeteredExecutor,
	type MeterOptions,
	meterExecutor,
} from "./ephemeral-meter.js";
export {
	EPHEMERAL_SCRIPTS,
	type EphemeralScript,
	type EphemeralScriptName,
	scriptSha1,
} from "./ephemeral-scripts.js";
export {
	createRedisEphemeralState,
	type RedisEphemeralStateOptions,
} from "./ephemeral-state.js";
export {
	isKvRedisCompatibleError,
	KV_REDIS_ERROR_CODES,
	KvRedisCompatibleError,
	type KvRedisErrorCode,
} from "./errors.js";

export {
	CONFORMANCE_KEY_NAMESPACE,
	type CommandArgTemplate,
	type CommandTemplate,
	describeCommand,
	type ExpectationOutcome,
	evaluateExpectation,
	type FillKind,
	type FillSizes,
	type KvRedisExecutor,
	type RedisCommand,
	type RedisReply,
	type RedisValue,
	type ReplyExpectation,
	requiredFills,
	resolveCommand,
	resolveFillSizes,
} from "./protocol.js";
export {
	createReferenceRedisStore,
	createTimelessReferenceStore,
	type ReferenceStore,
	type ReferenceStoreOptions,
} from "./reference-store.js";
export {
	KV_KEY_VALUE_PROFILE,
	KV_REDIS_COMPATIBLE_PROFILE,
	KV_VALKEY_PROFILE,
	type KvRuntimeRequest,
	type RedisStoreInput,
	redisCompatible,
	type ValkeyStoreInput,
	valkey,
} from "./requirement.js";
export {
	type ConformanceCaseResult,
	type ConformanceReport,
	type ConformanceRunInput,
	type DeclaredLimits,
	KV_REDIS_CONFORMANCE_SUITE_REF,
	runKvRedisConformance,
	type StepResult,
	TRANSPORT_KINDS,
	type TransportKind,
	toProfileImplementations,
	toStructuredCapabilities,
} from "./runner.js";

export {
	assertNoQueueTopicImplication,
	explainNonImplication,
	findQueueTopicImplications,
	type ImplicationViolation,
	isNonImpliedProfile,
	KV_REDIS_NON_IMPLIED_PROFILES,
	type NonImpliedProfile,
} from "./separation.js";
