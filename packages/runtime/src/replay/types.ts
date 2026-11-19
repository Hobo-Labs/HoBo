import type { JsonObject, JsonValue } from "../json.js";

export type ReplayMode = "live" | "replay";

export interface EventEnvelope {
	id: string;
	streamId: string;
	seq: number;
	type: string;
	v?: number;
	data: JsonValue;
	ts?: string;
	meta?: JsonObject;
}

export type SeqVector = Record<string, number>;

export interface SeqVectorEntry {
	streamId: string;
	seq: number;
}

export interface ReplayReport {
	runId: string;
	seqVector: readonly SeqVectorEntry[];
	readSetHash: string;
	stateDigest: string;
	mode: ReplayMode;
	seed: string;
}

export interface ReplayDivergenceRecord {
	runId: string;
	liveStateDigest: string;
	replayStateDigest: string;
	liveOrder: readonly string[];
	replayOrder: readonly string[];
	firstDivergentEventKey: string;
}

export interface DeterministicContext {
	seed: string;
	mode: ReplayMode;
	eventKey: string;
	now(): string;
	random(label?: string): number;
}

export type FoldFn<S> = (
	state: S,
	event: EventEnvelope,
	context: DeterministicContext,
) => S;
