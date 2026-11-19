export {
	type ActorHost,
	type AggregateLease,
	createInMemoryActorHost,
	type InMemoryActorHostOptions,
	LeaseConflictError,
} from "./actor-host.js";
export {
	type Aggregate,
	AggregateConflictError,
	type AggregateDefinition,
	type AggregateDeps,
	AggregateInvariantError,
	type CommandContext,
	type CommandEmitter,
	type CommandResult,
	type Decide,
	defineAggregate,
	type EventEmitOptions,
} from "./aggregate.js";
export {
	type CrossCampProjectionOptions,
	type CrossCampProjectionSubscription,
	type CrossCampProjectionView,
	type CrossCampReplicationResult,
	createCrossCampProjection,
} from "./cross-camp-projection.js";
export {
	type ActorLeaseGrant,
	type ActorLeaseJournal,
	createDurableActorHost,
	type DurableActorHostOptions,
} from "./durable-actor-host.js";
export {
	AggregateStaleFenceError,
	DurableEffectUnavailableError,
	type ErrorSignal,
	isOptimisticConflict,
	isStaleFenceError,
	ProjectionWriteError,
	UnpersistedQuarantineError,
} from "./errors.js";
export {
	createActorActivatedEvent,
	createActorPassivatedEvent,
	createActorStateAppendedEvent,
	createProjectionDeclaredEvent,
	createProjectionLaggedEvent,
	createProjectionSinkReboundEvent,
	DATA_EVENT_SCHEMA_VERSION,
	type DataFact,
} from "./events.js";
export {
	type Evolve,
	type FoldFailureClassification,
	type FoldFailureClassifier,
	type FoldOutcome,
	type FoldSpec,
	foldEvents,
} from "./fold.js";
export type { Inspectable, JsonObject, JsonValue } from "./json.js";
export {
	createPaginatedEventView,
	type PaginatedPage,
	type PaginatedRow,
	type PaginatedSubscription,
	type PaginatedViewOptions,
} from "./paginated-view.js";
export {
	PROJECTION_INTERFACE,
	PROJECTION_PORT,
} from "./port.js";
export {
	type ApplyHandler,
	defineProjection,
	type Projection,
	type ProjectionDefinition,
	type ProjectionQuarantineOptions,
	type ProjectionQuarantineRecord,
	type ProjectionSnapshot,
	type QuarantinableProjection,
} from "./projection.js";
export {
	createProjectionRebuild,
	type ProjectionRebuildOptions,
	type ProjectionRebuildShardResult,
} from "./projection-rebuild.js";
export {
	createUpcasterRegistry,
	parseUpcasterVersion,
	type Upcaster,
	UpcasterChainError,
	type UpcasterRegistry,
	type UpcasterVersion,
} from "./upcaster.js";

export const HOBO_DATA_PACKAGE = "@hobo/data";
