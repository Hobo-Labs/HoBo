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
	type ActorLeaseGrant,
	type ActorLeaseJournal,
	createDurableActorHost,
	type DurableActorHostOptions,
} from "./durable-actor-host.js";
export {
	AggregateStaleFenceError,
	type ErrorSignal,
	isOptimisticConflict,
	isStaleFenceError,
	ProjectionWriteError,
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
	type FoldOutcome,
	type FoldSpec,
	foldEvents,
} from "./fold.js";
export type { Inspectable, JsonObject, JsonValue } from "./json.js";
export {
	PROJECTION_INTERFACE,
	PROJECTION_PORT,
} from "./port.js";
export {
	type ApplyHandler,
	defineProjection,
	type Projection,
	type ProjectionDefinition,
	type ProjectionSnapshot,
} from "./projection.js";
export {
	createUpcasterRegistry,
	type Upcaster,
	type UpcasterRegistry,
} from "./upcaster.js";

export const HOBO_DATA_PACKAGE = "@hobo/data";
