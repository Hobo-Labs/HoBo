// Past-tense facts the write-model kernel produces about its own actor lifecycle
// and about projection declarations (data-plane.md event catalog: `actor.*`,
// `projection.*`). These are plain fact bodies; a runtime wraps them in the shared
// EventEnvelope. Fence tokens are serialized as strings (bigint is not JSON-safe).

import type { JsonObject } from "./json.js";

export const DATA_EVENT_SCHEMA_VERSION = "hobo.data-events/v1";

export interface DataFact<T = JsonObject> {
	readonly type: string;
	readonly schemaVersion: typeof DATA_EVENT_SCHEMA_VERSION;
	readonly data: Readonly<T>;
}

function fact<T extends JsonObject>(type: string, data: T): DataFact<T> {
	return Object.freeze({
		type,
		schemaVersion: DATA_EVENT_SCHEMA_VERSION,
		data: Object.freeze(data),
	});
}

export function createActorActivatedEvent(input: {
	streamId: string;
	holderId: string;
	fenceToken: bigint;
}): DataFact {
	return fact("actor.Activated", {
		streamId: input.streamId,
		holderId: input.holderId,
		fenceToken: input.fenceToken.toString(),
	});
}

export function createActorStateAppendedEvent(input: {
	streamId: string;
	seq: number;
	fenceToken: bigint;
}): DataFact {
	return fact("actor.StateAppended", {
		streamId: input.streamId,
		seq: input.seq,
		fenceToken: input.fenceToken.toString(),
	});
}

export function createActorPassivatedEvent(input: {
	streamId: string;
	seq: number;
}): DataFact {
	return fact("actor.Passivated", {
		streamId: input.streamId,
		seq: input.seq,
	});
}

export function createProjectionDeclaredEvent(input: {
	projection: string;
	readSet: readonly string[];
	reactivityClass: "reactive" | "non-reactive";
}): DataFact {
	return fact("projection.Declared", {
		projection: input.projection,
		readSet: [...input.readSet],
		reactivityClass: input.reactivityClass,
	});
}

export function createProjectionLaggedEvent(input: {
	projection: string;
	lagSeq: number;
	bound: number;
}): DataFact {
	return fact("projection.Lagged", {
		projection: input.projection,
		lagSeq: input.lagSeq,
		bound: input.bound,
	});
}

export function createProjectionSinkReboundEvent(input: {
	projection: string;
	matchDecidedRef: string;
}): DataFact {
	return fact("projection.SinkRebound", {
		projection: input.projection,
		matchDecidedRef: input.matchDecidedRef,
	});
}
