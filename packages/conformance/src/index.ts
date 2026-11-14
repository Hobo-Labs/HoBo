// public-contract: package diagnostics expose this canonical package identifier.
export const HOBO_CONFORMANCE_PACKAGE = "@hobo/conformance";

export * from "./boundaries.js";
export type {
	CapabilityHostFactory,
	CapabilityHostFactoryOptions,
} from "./capability-enforcement/suite.js";
export { capabilityEnforcementSuite } from "./capability-enforcement/suite.js";
export { CORPUS_DIR, recordCorpus } from "./corpus/record.js";
export type {
	CorpusReplayResult,
	GreetingReadModel,
	ReplayCorpus,
} from "./corpus/replay.js";
export {
	assertCorpusReplayEqualsLive,
	buildReplayCorpus,
	emptyGreetingReadModel,
	foldLive,
	helloBindleFold,
	helloBindleUpcast,
	parseReplayCorpus,
	REPLAY_CORPUS_SEED,
} from "./corpus/replay.js";
export * from "./diff.js";
export * from "./golden-ir.js";
export type {
	LiveAdapterFactory,
	LiveAdapterModule,
	LiveCleanupOutcome,
	LiveCliOptions,
	LiveCliResult,
	LiveConformanceOptions,
	LiveConformancePorts,
	LiveConformanceResult,
	LiveRefusalCode,
	LiveResourceHandle,
	LiveResourceRequest,
	LiveRunGrant,
	LiveRunGrantInput,
} from "./live/index.js";
export {
	ANONYMOUS_EVIDENCE_ARTIFACT_SCHEMA,
	type AnonymousTrustEvidenceArtifact,
	assertNoUpgradedUnknowns,
	assertSanitized,
	CI_ENV_KEYS,
	CLEANUP_CHECK,
	checksFromReports,
	conformanceOutcomeFromArtifact,
	DEFAULT_EVIDENCE_FRESHNESS_WINDOW_MS,
	type EvidenceProvenance,
	type EvidenceSigner,
	emitAnonymousTrustEvidence,
	evidenceIsFullyPassing,
	LIVE_ENV_KEYS,
	LIVE_REFUSAL_CODES,
	LIVE_RUN_SCHEMA,
	LiveEvidenceError,
	type LiveEvidenceInput,
	LiveRunRefusedError,
	liveRunRefusalFor,
	MAXIMUM_EVIDENCE_FRESHNESS_WINDOW_MS,
	parseLiveRunGrant,
	runLiveAnonymousConformance,
	runLiveConformanceCli,
	selectionEvidenceFacts,
	standardTrustChecksFrom,
} from "./live/index.js";
export {
	type CreateMessagingFn,
	MESSAGING_CONFORMANCE_CONTRACT,
	type MessagingAssertionName,
	type MessagingConformanceReport,
	runMessagingConformance,
} from "./messaging-conformance.js";
export type {
	CreateScratchStackOptions,
	ProviderLifecycleCase,
	ProviderLifecycleCaseName,
	ProviderLifecycleErrorCode,
	ProviderLifecycleFailure,
	ProviderLifecycleResult,
	ScratchDesired,
	ScratchOwnedContext,
	ScratchProvider,
	ScratchProviderContext,
	ScratchProviderResult,
	ScratchResource,
	ScratchSeedInput,
	ScratchSeedResourceInput,
	ScratchStack,
	ScratchStackState,
	ScratchWorld,
} from "./provider-lifecycle.js";
export {
	createReferenceScratchProvider,
	createScratchStack,
	PROVIDER_LIFECYCLE_CASE_NAMES,
	PROVIDER_LIFECYCLE_ERROR_CODES,
	PROVIDER_LIFECYCLE_SUITE,
	PROVIDER_LIFECYCLE_SUITE_DESCRIPTOR,
	PROVIDER_LIFECYCLE_SUITE_ID,
	ProviderLifecycleError,
	parseScratchDesired,
	parseScratchProvider,
	parseScratchSeed,
	runProviderLifecycleConformance,
} from "./provider-lifecycle.js";
export type {
	CreateRuntimeLocalQueueClock,
	QueueClockAssertionName,
	QueueClockConformanceOptions,
	QueueClockConformanceReport,
	ReplayClockTraceFn,
} from "./queue-clock.js";
export {
	QUEUE_CLOCK_CONFORMANCE_CONTRACT,
	runQueueClockConformance,
} from "./queue-clock.js";
export * from "./registry.js";
export * from "./report.js";
export * from "./runner.js";
export * from "./sdk-parity.js";
export * from "./seed.js";
export type {
	StreamerAssertionName,
	StreamerConformanceReport,
} from "./streamer.js";
export {
	runStreamerConformance,
	STREAMER_CONFORMANCE_CONTRACT,
} from "./streamer.js";
export * from "./suite.js";
export * from "./suites/anonymous/index.js";
// @hobo/cd port, fleet, matrix, chaos and load suites (plan 0024 WP20).
export * from "./suites/cd-index.js";
export type {
	ComponentHostAdapter,
	ComponentHostConformanceReport,
	ComponentHostManifest,
} from "./suites/component-host/index.js";
export {
	CapabilityIsolationError,
	COMPONENT_HOST_CONFORMANCE_SCHEMA,
	ComponentHostPlanningError,
	createReferenceComponentHostManifest,
	createReferenceInContainerHost,
	createReferenceRuntimeLocalHost,
	planComponentHost,
	runComponentHostConformance,
} from "./suites/component-host/index.js";
export type {
	AssertionStatus,
	CreateRuntimeLocalEventStore,
	EventStoreConformanceAssertion,
	EventStoreConformanceReport,
} from "./suites/eventstore.js";
export {
	CAMP_EVENTSTORE_RUNTIME_PORT_CONTRACT_VERSION,
	runEventStoreConformance,
} from "./suites/eventstore.js";
export { MESSAGING_CONFORMANCE_SUITE } from "./suites/messaging.js";
export type {
	ProduceRealizationResult,
	RealizationResultAssertion,
	RealizationResultConformanceReport,
	RealizationResultScenario,
} from "./suites/realization-result.js";
export {
	REALIZATION_RESULT_CONFORMANCE_CONTRACT,
	runRealizationResultConformance,
} from "./suites/realization-result.js";
export type {
	RuntimeDurabilityBackend,
	RuntimePortConformanceReport,
} from "./suites/runtime-port/index.js";

export {
	parseRuntimePortReport,
	proveCheckoutDurability,
	RUNTIME_PORT_CONFORMANCE_VERSION,
	runRuntimePortDurabilitySuite,
} from "./suites/runtime-port/index.js";
export * from "./types.js";
