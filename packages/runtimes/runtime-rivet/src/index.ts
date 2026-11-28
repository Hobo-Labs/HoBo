export {
	DURABLE_TOPIC_REDUCER_CAPABILITIES as RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
	DURABLE_TOPIC_REDUCER_LIMITS as RIVET_DURABLE_TOPIC_BUS_LIMITS,
} from "@hobo/runtime/durable-topic-reducer";
export {
	assertNoWaitTrue,
	createRivetActorHost,
	type RivetActorHost,
	type RivetActorLease,
	type RivetActorStateHandle,
	RivetLeaseConflictError,
	rivetStreamId,
} from "./actor-host.js";
export {
	createRivetDistributedJournal,
	createRivetDistributedJournalActor,
	RivetDistributedJournalError,
	type RivetJournalNamespace,
} from "./distributed-actor.js";
export {
	computeRivetOperationDigest,
	createRivetCapabilityVerifier,
	issueRivetCapability,
	type RivetCapabilityClaims,
	RivetCapabilityError,
	type RivetCapabilityVerifierOptions,
	type RivetOperation,
	type RivetSignedCapability,
} from "./distributed-auth.js";
export {
	createRivetDurableTopicActor,
	createRivetDurableTopicBusActor,
	isRivetDurableTopicBinding,
	isRivetDurableTopicBusBinding,
	type RivetDurableTopicBinding,
	type RivetDurableTopicBusBinding,
	type RivetDurableTopicBusOptions,
	type RivetDurableTopicContext,
	type RivetDurableTopicOptions,
} from "./durable-topic-actor.js";
export {
	createRivetDurableTopicClient,
	createRivetDurableTopicMetadataGrant,
	isRivetDurableTopicClientBoundTo,
	isRivetDurableTopicClientFor,
	type RivetDurableTopicCapabilities,
	type RivetDurableTopicClient,
	type RivetDurableTopicClientBinding,
	type RivetDurableTopicClientOptions,
	type RivetDurableTopicLogMessage,
	type RivetDurableTopicLogOutcome,
	type RivetDurableTopicMetadataGrant,
	type RivetDurableTopicRequest,
	type RivetDurableTopicTransportClaim,
} from "./durable-topic-client.js";
export {
	RIVET_DURABLE_TOPIC_LOG_CAPABILITIES,
	RIVET_DURABLE_TOPIC_LOG_LIMITS,
} from "./durable-topic-log.js";
export {
	createRivetRuntimeHost,
	diagnoseRivetReadiness,
	type RivetRuntimeBundle,
	type RivetRuntimeHostOptions,
} from "./host.js";
export {
	type ActorLocalJournal,
	createActorLocalJournal,
	type JournalFactRecord,
} from "./journal.js";
export type { RivetkitModule } from "./load-rivetkit.js";
export { loadRivetkit, loadRivetkitClient } from "./load-rivetkit.js";
export {
	dispatchRivetOutbox,
	type RivetOutboxEffect,
	type RivetOutboxEffectInput,
} from "./outbox.js";
export {
	parseRivetRuntimeConfig,
	parseRivetRuntimeMode,
} from "./parse.js";
export {
	type AcceptCommandInput,
	type AcceptCommandResult,
	type InboxCommand,
	type JournalFact,
	type RivetDoctorReport,
	type RivetFidelity,
	type RivetInboxStatus,
	RivetJournalError,
	type RivetRuntimeConfig,
	type RivetRuntimeMode,
} from "./types.js";
export {
	RIVET_ENGINE_PIN,
	RIVETKIT_PIN,
	rivetEngineImageRef,
} from "./upstream-pin.js";

// public-contract: package id compose and Matching pin.
export const HOBO_RUNTIME_RIVET_PACKAGE = "@hobo/runtime-rivet";

/** Profiles this resolver claims. Grammar-legal kv refinements, not actor.*. */
export const RIVET_RESOLVER_PROFILES = [
	"kv.durable-object/v1",
	"kv.durable-object.event-journal/v1",
	"kv.durable-object.durable-inbox/v1",
	"kv.durable-object.transactional-outbox/v1",
	"kv.durable-object.exportable-state/v1",
] as const;
