export { type EmitResult, emit, subscribe } from "./bus.js";
export { SagaCompensationError } from "./errors.js";
export {
	createDataChangedEvent,
	createSagaCompensatedEvent,
	createSagaCompletedEvent,
	createSagaStartedEvent,
	createSagaStepEmittedEvent,
	createSubscriptionClosedEvent,
	createSubscriptionOpenedEvent,
	createSubscriptionPushedEvent,
	createSubscriptionRecomputedEvent,
	EVENTS_EVENT_SCHEMA_VERSION,
	type ReactiveFact,
} from "./events.js";
export {
	SUBSCRIPTION_GATEWAY_INTERFACE,
	SUBSCRIPTION_GATEWAY_PORT,
} from "./port.js";
export {
	createReactor,
	defineMaterialization,
	type Materialization,
	type Reactor,
	type SubscriptionHandle,
} from "./reactor.js";
export {
	defineSaga,
	type Saga,
	type SagaContext,
	type SagaDefinition,
	type SagaOutcome,
} from "./saga.js";
export {
	CORPUS_BASELINE_SCHEMA,
	CORPUS_ENTRY_SCHEMA,
	type CorpusBaseline,
	type CorpusEntry,
	type CorpusReplay,
	createCorpusBaseline,
	createCorpusEntry,
	decodeEventBody,
	EVENT_BODY_UPCASTER_GATE_SCHEMA,
	type EventBody,
	type EventBodySchema,
	type EventBodyUpcaster,
	type EventEvolutionContract,
	type EventFieldSpec,
	type EventFieldType,
	encodeEventBody,
	eventSchema,
	runCanDeployUpcasterGate,
	stringField,
	type UpcasterGateReport,
	u32Field,
	validateEventBody,
} from "./upcaster.js";
export {
	MIGRATION_EVENT_CONTRACTS,
	migrationCorpusBaseline,
} from "./upcaster-corpus.js";
export {
	PRICING_EVENT_CONTRACTS,
	pricingCorpusBaseline,
} from "./pricing-event-contracts.js";

export const HOBO_EVENTS_PACKAGE = "@hobo/events";
