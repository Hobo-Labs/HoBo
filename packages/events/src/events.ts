// Past-tense facts for the reactive-streams / saga leg of the data plane
// (data-plane.md Plan 32 event catalog: `subscription.*`, `saga.*`,
// `data.Changed`). Plain fact bodies; a runtime wraps them in the shared
// EventEnvelope from @hobo/core.

export const EVENTS_EVENT_SCHEMA_VERSION = "hobo.reactive-events/v1"; // public-contract: schemaVersion stamped on every reactive fact body

type FactValue = string | number | readonly string[];
type FactData = Record<string, FactValue>;

export interface ReactiveFact<T extends FactData = FactData> {
	readonly type: string;
	readonly schemaVersion: typeof EVENTS_EVENT_SCHEMA_VERSION;
	readonly data: Readonly<T>;
}

function fact<T extends FactData>(type: string, data: T): ReactiveFact<T> {
	return Object.freeze({
		type,
		schemaVersion: EVENTS_EVENT_SCHEMA_VERSION,
		data: Object.freeze(data),
	});
}

export function createSubscriptionOpenedEvent(input: {
	subscriptionId: string;
	materialization: string;
	readSet: readonly string[];
}): ReactiveFact {
	return fact("subscription.Opened", {
		subscriptionId: input.subscriptionId,
		materialization: input.materialization,
		readSet: [...input.readSet],
	});
}

export function createSubscriptionRecomputedEvent(input: {
	subscriptionId: string;
	seq: number;
	readSetHash: string;
}): ReactiveFact {
	return fact("subscription.Recomputed", {
		subscriptionId: input.subscriptionId,
		seq: input.seq,
		readSetHash: input.readSetHash,
	});
}

export function createSubscriptionPushedEvent(input: {
	subscriptionId: string;
	seq: number;
	resultCount: number;
}): ReactiveFact {
	return fact("subscription.Pushed", {
		subscriptionId: input.subscriptionId,
		seq: input.seq,
		resultCount: input.resultCount,
	});
}

export function createSubscriptionClosedEvent(input: {
	subscriptionId: string;
	reason: string;
}): ReactiveFact {
	return fact("subscription.Closed", {
		subscriptionId: input.subscriptionId,
		reason: input.reason,
	});
}

export function createSagaStartedEvent(input: {
	sagaId: string;
	name: string;
	triggerType: string;
}): ReactiveFact {
	return fact("saga.Started", {
		sagaId: input.sagaId,
		name: input.name,
		triggerType: input.triggerType,
	});
}

export function createSagaStepEmittedEvent(input: {
	sagaId: string;
	step: string;
	emittedType: string;
}): ReactiveFact {
	return fact("saga.StepEmitted", {
		sagaId: input.sagaId,
		step: input.step,
		emittedType: input.emittedType,
	});
}

export function createSagaCompensatedEvent(input: {
	sagaId: string;
	step: string;
	reason: string;
}): ReactiveFact {
	return fact("saga.Compensated", {
		sagaId: input.sagaId,
		step: input.step,
		reason: input.reason,
	});
}

export function createSagaCompletedEvent(input: {
	sagaId: string;
	outcome: string;
}): ReactiveFact {
	return fact("saga.Completed", {
		sagaId: input.sagaId,
		outcome: input.outcome,
	});
}

export function createDataChangedEvent(input: {
	resource: string;
	key: string;
	op: "insert" | "update" | "delete";
	sourceSeq: number;
}): ReactiveFact {
	return fact("data.Changed", {
		resource: input.resource,
		key: input.key,
		op: input.op,
		sourceSeq: input.sourceSeq,
	});
}
