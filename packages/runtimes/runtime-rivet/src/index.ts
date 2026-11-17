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
	RivetDistributedJournalError,
	type RivetJournalNamespace,
	rivetDistributedJournalActor,
} from "./distributed-actor.js";
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
