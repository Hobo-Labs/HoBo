import type { JsonObject, JsonValue } from "../json.js";

export type ReplayMode = "live" | "replay";
export type CanonicalizationVersion = 1 | 2;

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
	readonly streamId: string;
	readonly seq: number;
}

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface ReplayReport {
	/** Missing in historical records, which used version 1. */
	readonly canonicalizationVersion?: CanonicalizationVersion;
	readonly runId: string;
	readonly seqVector: readonly SeqVectorEntry[];
	readonly readSetHash: string;
	readonly stateDigest: string;
	readonly mode: ReplayMode;
	readonly seed: string;
}

export interface ReplayDivergenceRecord {
	/** Missing in historical records, which used version 1. */
	readonly canonicalizationVersion?: CanonicalizationVersion;
	readonly runId: string;
	readonly liveStateDigest: string;
	readonly replayStateDigest: string;
	readonly liveOrder: readonly string[];
	readonly replayOrder: readonly string[];
	readonly firstDivergentEventKey: string;
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
