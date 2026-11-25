import assert from "node:assert/strict";
import crypto from "node:crypto";
import { must, mustGet } from "@hobo/core/total-access";
import {
	cloneAsJson,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import { createDeterministicContext } from "./context.js";
import { ReplayDivergenceError } from "./divergence.js";
import type {
	EventEnvelope,
	FoldFn,
	ReplayMode,
	ReplayReport,
	SeqVector,
	UpcastFn,
} from "./types.js";

export interface AssertReplayEqualsLiveInput<S> {
	events: EventEnvelope[];
	fold: FoldFn<S>;
	initialState: S;
	upcast?: UpcastFn;
	targetSeq?: SeqVector;
	seed?: string;
	normalize?: (value: JsonValue) => JsonValue;
	runId?: string;
}

export function assertReplayEqualsLive<S>({
	events,
	fold,
	initialState,
	upcast = (event) => event,
	targetSeq = seqVector(events),
	seed = "hobo-replay-live",
	normalize = stableValue,
	runId = "fold-proof",
}: AssertReplayEqualsLiveInput<S>): ReplayReport {
	const eventSlice = events.filter((event) => isAtOrBefore(event, targetSeq));
	const replayEvents = [...eventSlice].sort(compareCanonicalEventOrder);

	const liveState = runFold({
		events: eventSlice,
		fold,
		initialState,
		upcast,
		seed,
		mode: "live",
		ambientNow: 1_900_000_000_000,
		ambientRandom: 0.111111111,
	});

	const replayState = runFold({
		events: replayEvents,
		fold,
		initialState,
		upcast,
		seed,
		mode: "replay",
		ambientNow: 2_000_000_000_000,
		ambientRandom: 0.999999999,
	});

	const normalizedLive = normalize(cloneAsJson(liveState));
	const normalizedReplay = normalize(cloneAsJson(replayState));

	try {
		assert.deepEqual(normalizedLive, normalizedReplay);
	} catch {
		throw new ReplayDivergenceError({
			runId,
			liveState: normalizedLive,
			replayState: normalizedReplay,
			liveOrder: eventSlice.map(eventKey),
			replayOrder: replayEvents.map(eventKey),
		});
	}

	return {
		runId,
		seqVector: toSeqVectorEntries(targetSeq),
		readSetHash: hashReadSet(events),
		stateDigest: crypto
			.createHash("sha256")
			.update(stableStringify(normalizedReplay))
			.digest("hex"),
		mode: "replay",
		seed,
	};
}

export interface RunFoldInput<S> {
	events: EventEnvelope[];
	fold: FoldFn<S>;
	initialState: S;
	upcast: UpcastFn;
	seed: string;
	mode: ReplayMode;
	ambientNow: number;
	ambientRandom: number;
}

export function runFold<S>({
	events,
	fold,
	initialState,
	upcast,
	seed,
	mode,
	ambientNow,
	ambientRandom,
}: RunFoldInput<S>): S {
	return withAmbientNondeterminism(
		{ now: ambientNow, random: ambientRandom },
		() => {
			let state = clone(initialState);

			for (const event of events) {
				const context = createDeterministicContext({
					seed,
					mode,
					eventKey: eventKey(event),
				});
				const lifted = upcast(clone(event), context);
				state = fold(state, lifted, context);
			}

			return state;
		},
	);
}

export function seqVector(events: EventEnvelope[]): SeqVector {
	return stableObject(
		events.reduce<SeqVector>((position, event) => {
			position[event.streamId] = Math.max(
				position[event.streamId] ?? 0,
				event.seq,
			);
			return position;
		}, {}),
	);
}

export function hashReadSet(events: EventEnvelope[]): string {
	const streams = [...new Set(events.map((event) => event.streamId))].sort();
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(streams))
		.digest("hex");
}

export function interleaveStreams(
	streams: Record<string, EventEnvelope[]>,
	seed: string,
): EventEnvelope[] {
	const queues = new Map(
		Object.entries(streams).map(([streamId, events]) => [
			streamId,
			[...events].sort((left, right) => left.seq - right.seq),
		]),
	);
	const interleaved: EventEnvelope[] = [];

	while ([...queues.values()].some((events) => events.length > 0)) {
		const availableStreams = [...queues.entries()]
			.filter(([, events]) => events.length > 0)
			.map(([streamId]) => streamId)
			.sort();
		const index = Math.floor(
			seededUnit(`${seed}:${interleaved.length}`) * availableStreams.length,
		);
		const streamId = availableStreams[index];
		if (streamId === undefined) {
			throw new Error("interleaveStreams selected an unavailable stream");
		}
		interleaved.push(must(mustGet(queues, streamId, "queues").shift()));
	}

	return interleaved;
}

export function compareCanonicalEventOrder(
	left: EventEnvelope,
	right: EventEnvelope,
): number {
	return (
		left.streamId.localeCompare(right.streamId) ||
		left.seq - right.seq ||
		String(left.type).localeCompare(String(right.type)) ||
		String(left.id).localeCompare(String(right.id))
	);
}

export function stableValue(value: JsonValue): JsonValue {
	if (value instanceof Map) {
		return [...value.entries()]
			.map(([key, entry]) => [stableValue(key), stableValue(entry)])
			.sort(([left], [right]) =>
				stableStringify(left ?? null).localeCompare(
					stableStringify(right ?? null),
				),
			);
	}

	if (value instanceof Set) {
		return [...value]
			.map(stableValue)
			.sort((left, right) =>
				stableStringify(left ?? null).localeCompare(
					stableStringify(right ?? null),
				),
			);
	}

	if (Array.isArray(value)) {
		return value.map(stableValue);
	}

	if (value && isJsonObject(value)) {
		return stableObject(
			Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [
					key,
					stableValue(entry ?? null),
				]),
			),
		);
	}

	return value;
}

export function stableStringify(value: JsonValue): string {
	return JSON.stringify(stableValue(value));
}

function isAtOrBefore(event: EventEnvelope, targetSeq: SeqVector): boolean {
	return event.seq <= (targetSeq[event.streamId] ?? 0);
}

export function eventKey(event: EventEnvelope): string {
	return `${event.streamId}:${event.seq}:${event.id ?? event.type}`;
}

function seededUnit(input: string): number {
	const hex = crypto
		.createHash("sha256")
		.update(input)
		.digest("hex")
		.slice(0, 12);
	return Number.parseInt(hex, 16) / 0xffffffffffff;
}

function stableObject<T extends JsonObject>(value: T): T {
	// SAFETY: assertion to `Object.fromEntries( Object.entries(value).sort(([left], [right]) => left.localeCompare(right)), ) as T` is required at this boundary.
	return Object.fromEntries(
		Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
	) as T;
}

function clone<T>(value: T): T {
	if (structuredClone instanceof Function) {
		return structuredClone(value);
	}
	// SAFETY: assertion to `JSON.parse(JSON.stringify(value)) as T` is required at this boundary.
	return JSON.parse(JSON.stringify(value)) as T;
}

function withAmbientNondeterminism<T>(
	{ now, random }: { now: number; random: number },
	callback: () => T,
): T {
	const originalDateNow = Date.now;
	const originalMathRandom = Math.random;

	Date.now = () => now;
	Math.random = () => random;

	try {
		return callback();
	} finally {
		Date.now = originalDateNow;
		Math.random = originalMathRandom;
	}
}

function toSeqVectorEntries(vector: SeqVector) {
	return Object.entries(vector)
		.map(([streamId, seq]) => ({ streamId, seq }))
		.sort((left, right) => left.streamId.localeCompare(right.streamId));
}
