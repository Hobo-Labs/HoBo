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

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface SeqVectorEntry {
	streamId: string;
	seq: number;
}

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
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

export type UpcastFn = (
	event: EventEnvelope,
	context: DeterministicContext,
) => EventEnvelope;
