export {
	type AccessDecision,
	type AccessRequest,
	evaluateReplayAccess,
} from "./access.js";
export {
	isReplayAutoWired,
	type ReplayAutowireSnippet,
	webReplayAutowire,
} from "./autowire.js";
export {
	applySessionReplayToEntrypoints,
	type BindleAnnotationLike,
	type BindleDefinitionLike,
	type BindleResourceLike,
	type BindleSessionReplayPlan,
	defaultWebSessionReplayAnnotation,
	deriveBindleSessionReplayPlan,
	type FetchHandler as SessionReplayFetchHandler,
	isReplayableAppKitKind,
	isResourceReplayable,
	listReplayableResources,
	REPLAYABLE_APP_KIT_KINDS,
	type ReplayableAppKitKind,
	readSessionReplayAnnotation,
	SESSION_REPLAY_OPTION,
	SESSION_REPLAY_PATH_PREFIX,
	type SessionReplayAnnotationConfig,
	type SessionReplayHostSurface,
	sessionReplayAnnotation,
	type WrapBindleWebHandlerOptions,
	wrapBindleWebHandler,
} from "./bindle-integration.js";
export {
	type BrowserBootstrapConfig,
	injectSessionReplayBootstrap,
	renderSessionReplayBootstrapScript,
} from "./browser-bootstrap.js";
export {
	buildCorrelation,
	type CorrelationInput,
	withErrorLink,
	withHarnessExposures,
	withTrail,
} from "./correlation.js";
export {
	createDebugReplayRecorder,
	createDebugTrackEnvelope,
	DEBUG_REPLAY_EVENT_TYPE,
	DEBUG_REPLAY_LEVEL_ENV,
	DEBUG_REPLAY_SCHEMA_VERSION,
	DEBUG_REPLAY_TRACKS,
	type DebugReplayLevel,
	type DebugReplayRecorder,
	type DebugReplayRecordInput,
	type DebugReplayRecording,
	type DebugReplayTrack,
	type DebugTrackEnvelope,
	type DebugTrackInput,
	isDebugTrackEnvelope,
	resolveDebugReplayLevel,
} from "./debug-replay.js";
export {
	createReplayEvent,
	REPLAY_EVENT_SCHEMA,
	REPLAY_EVENTS,
	type ReplayEvent,
	type ReplayEventType,
} from "./events.js";
export {
	buildEvidencePack,
	type EvidencePack,
} from "./evidence.js";
export {
	createReplayHttpSurface,
	type HttpMethod,
	REPLAY_BOUNDARIES,
	type ReplayBoundaryDescriptor,
	type ReplayHttpRequest,
	type ReplayHttpResponse,
	type ReplayHttpSurface,
	seedReplayFixture,
} from "./http-surface.js";
export {
	createMemoryMeterSink,
	type MeterSink,
	meterIngest,
	meterPlayerAccess,
	type ReplayMeterEvent,
	type ReplayMeterKind,
} from "./metering.js";
export {
	createFixtureReplayEngine,
	type DebugTimelineItem,
	loadPlayerPayload,
	type OpenUiPlayerDescriptor,
	type PlayerPayload,
	type ReplayEngine,
	summarizeSession,
} from "./player.js";
export {
	evaluateRecordingPolicy,
	REPLAY_ENV_KILL,
	REPLAY_FLAG_KEY,
	type RecordingDecision,
	type RecordingPolicyInput,
} from "./policy.js";
export {
	assertNoSensitivePlaintext,
	defaultPrivacyPolicy,
	MASK_TOKEN,
	maskRrwebEvent,
	maskRrwebEvents,
	redactDebugPayload,
	shouldMaskNode,
} from "./privacy.js";
export {
	applyRetention,
	DEFAULT_RETENTION,
	eraseSessionById,
	REPLAY_RETENTION_RECIPE,
	type RetentionPolicy,
	type RetentionResult,
	replayRetentionTrailStep,
} from "./retention.js";
export {
	createContractAssertedReplayFixtures,
	createReplayService,
	type ReplayService,
} from "./service.js";
export {
	createFilesystemDualFixtures,
	createMemoryDualFixtures,
	createObjectStorageBlobStore,
	type DualFixtureStore,
	type ObjectStoragePort,
	type SessionBlobStore,
	type SessionIndex,
	type SessionListQuery,
} from "./storage.js";
export {
	createDefaultLocalTracker,
	createFixtureRecordEngine,
	createRrwebRecordEngine,
	createTracker,
	type RecordEngine,
	type TrackerHandle,
	type TrackerOptions,
} from "./tracker.js";
export {
	type IsolationClass,
	type PrivacyPolicy,
	parsePrivacyPolicy,
	parseSessionCorrelation,
	parseSessionRecord,
	REPLAY_CONTRACT_VERSION,
	REPLAY_CORRELATION_SCHEMA,
	REPLAY_PRIVACY_SCHEMA,
	REPLAY_SCHEMA_VERSION,
	type RecordingChunk,
	ReplayParseError,
	type RrwebEvent,
	type SessionCorrelation,
	type SessionRecord,
	type SessionStatus,
} from "./types.js";

// public-contract: package id consumers assert against.
export const HOBO_REPLAY_PACKAGE = "@hobo/replay";
