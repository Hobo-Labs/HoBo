import assert from "node:assert/strict";
import crypto from "node:crypto";
import { must, mustGet } from "@hobo/core/total-access";
import {
	cloneAsJson,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import { isNonEmptyPrimitiveString } from "../workflow-boundary.js";
import {
	compareCanonicalStrings,
	canonicalizationVersion as requireCanonicalizationVersion,
} from "./canonicalization.js";
import { createDeterministicContext } from "./context.js";
import { ReplayDivergenceError } from "./divergence.js";
import type {
	CanonicalizationVersion,
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
	canonicalizationVersion?: CanonicalizationVersion;
}

export function assertReplayEqualsLive<S>({
	events,
	fold,
	initialState,
	upcast = (event) => event,
	targetSeq,
	seed = "hobo-replay-live",
	normalize,
	runId = "fold-proof",
	canonicalizationVersion: requestedVersion,
}: AssertReplayEqualsLiveInput<S>): ReplayReport {
	const version = requireCanonicalizationVersion(requestedVersion, 2);
	if (!isNonEmptyPrimitiveString(runId))
		throw new TypeError("replay runId must be a non-empty string");
	if (!isNonEmptyPrimitiveString(seed))
		throw new TypeError("replay seed must be a non-empty string");
	const capturedEvents = events.map((event) => clone(event));
	const defaultTarget = seqVectorForVersion(capturedEvents, version);
	const requestedTarget = targetSeq === undefined ? defaultTarget : targetSeq;
	const capturedTarget = Object.fromEntries(
		Object.getOwnPropertyNames(requestedTarget).map((streamId) => {
			if (!isNonEmptyPrimitiveString(streamId))
				throw new TypeError("target stream must be a non-empty string");
			const sequence = must(
				requestedTarget[streamId],
				`target sequence for ${streamId}`,
			);
			if (!Number.isSafeInteger(sequence) || sequence < 0)
				throw new RangeError(
					"target sequence must be a non-negative safe integer",
				);
			return [streamId, sequence];
		}),
	);
	const eventSlice = capturedEvents.filter((event) =>
		isAtOrBefore(event, capturedTarget),
	);
	const replayEvents = [...eventSlice].sort((left, right) =>
		compareCanonicalEventOrder(left, right, version),
	);

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

	const normalizeState =
		normalize ?? ((value) => stableValueForVersion(value, version));
	const normalizedLive = normalizeState(cloneAsJson(liveState));
	const normalizedReplay = normalizeState(cloneAsJson(replayState));

	try {
		assert.deepEqual(normalizedLive, normalizedReplay);
	} catch {
		throw new ReplayDivergenceError({
			canonicalizationVersion: version,
			runId,
			liveState: normalizedLive,
			replayState: normalizedReplay,
			liveOrder: eventSlice.map(eventKey),
			replayOrder: replayEvents.map(eventKey),
		});
	}

	return Object.freeze({
		canonicalizationVersion: version,
		runId,
		seqVector: toSeqVectorEntries(capturedTarget, version),
		readSetHash: hashReadSet(capturedEvents),
		stateDigest: crypto
			.createHash("sha256")
			.update(stableStringifyForVersion(normalizedReplay, version))
			.digest("hex"),
		mode: "replay",
		seed,
	});
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
	return seqVectorForVersion(events, 2);
}

export function seqVectorForVersion(
	events: EventEnvelope[],
	requestedVersion: CanonicalizationVersion,
): SeqVector {
	const version = requireCanonicalizationVersion(requestedVersion);
	const positions = new Map<string, number>();
	for (const event of events) {
		if (!isNonEmptyPrimitiveString(event.streamId))
			throw new TypeError("event stream must be a non-empty string");
		if (!Number.isSafeInteger(event.seq) || event.seq < 0)
			throw new RangeError(
				"event sequence must be a non-negative safe integer",
			);
		positions.set(
			event.streamId,
			Math.max(positions.get(event.streamId) ?? 0, event.seq),
		);
	}
	return stableObject(Object.fromEntries(positions), version);
}

export function hashReadSet(events: EventEnvelope[]): string {
	const streams = [
		...new Set(
			events.map((event) => {
				if (!isNonEmptyPrimitiveString(event.streamId))
					throw new TypeError("event stream must be a non-empty string");
				return event.streamId;
			}),
		),
	].sort();
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
	requestedVersion?: CanonicalizationVersion,
): number {
	const version = requireCanonicalizationVersion(requestedVersion, 2);
	return (
		compareCanonicalStrings(left.streamId, right.streamId, version) ||
		left.seq - right.seq ||
		compareCanonicalStrings(String(left.type), String(right.type), version) ||
		compareCanonicalStrings(String(left.id), String(right.id), version)
	);
}

export function stableValue(value: JsonValue): JsonValue {
	return stableValueForVersion(value, 2);
}

function stableValueForVersion(
	value: JsonValue,
	requestedVersion: CanonicalizationVersion,
): JsonValue {
	const version = requireCanonicalizationVersion(requestedVersion);
	if (value instanceof Map) {
		return [...value.entries()]
			.map(([key, entry]) => [
				stableValueForVersion(key, version),
				stableValueForVersion(entry, version),
			])
			.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
				const keys = compareCanonicalStrings(
					stableStringifyForVersion(leftKey ?? null, version),
					stableStringifyForVersion(rightKey ?? null, version),
					version,
				);
				return (
					keys ||
					(version === 1
						? 0
						: compareCanonicalStrings(
								stableStringifyForVersion(leftValue ?? null, version),
								stableStringifyForVersion(rightValue ?? null, version),
								version,
							))
				);
			});
	}

	if (value instanceof Set) {
		return [...value]
			.map((entry) => stableValueForVersion(entry, version))
			.sort((left, right) =>
				compareCanonicalStrings(
					stableStringifyForVersion(left ?? null, version),
					stableStringifyForVersion(right ?? null, version),
					version,
				),
			);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => stableValueForVersion(entry, version));
	}

	if (value && isJsonObject(value)) {
		return stableObject(
			Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [
					key,
					stableValueForVersion(entry ?? null, version),
				]),
			),
			version,
		);
	}

	return value;
}

export function stableStringify(value: JsonValue): string {
	return stableStringifyForVersion(value, 2);
}

export function stableStringifyForVersion(
	value: JsonValue,
	requestedVersion: CanonicalizationVersion,
): string {
	return JSON.stringify(stableValueForVersion(value, requestedVersion));
}

function isAtOrBefore(event: EventEnvelope, targetSeq: SeqVector): boolean {
	const limit = Object.hasOwn(targetSeq, event.streamId)
		? targetSeq[event.streamId]
		: undefined;
	return event.seq <= (limit ?? 0);
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

function stableObject<T extends JsonObject>(
	value: T,
	version: CanonicalizationVersion,
): T {
	// SAFETY: sorting and rebuilding preserves the object's own JSON entries.
	return Object.fromEntries(
		Object.entries(value).sort(([left], [right]) =>
			compareCanonicalStrings(left, right, version),
		),
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
	const clockDescriptor = Object.getOwnPropertyDescriptor(Date, "now");
	const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
	if (
		!clockDescriptor ||
		!("value" in clockDescriptor) ||
		!randomDescriptor ||
		!("value" in randomDescriptor)
	)
		throw new Error(
			"replay harness requires ordinary clock and random intrinsics",
		);
	let clockInstalled = false;
	let randomInstalled = false;
	try {
		Date.now = () => now;
		clockInstalled = true;
		Math.random = () => random;
		randomInstalled = true;
		return callback();
	} finally {
		try {
			if (randomInstalled)
				Object.defineProperty(Math, "random", randomDescriptor);
		} finally {
			if (clockInstalled) Object.defineProperty(Date, "now", clockDescriptor);
		}
	}
}

export function toSeqVectorEntries(
	vector: SeqVector,
	version: CanonicalizationVersion,
) {
	const entries = Object.entries(vector)
		.map(([streamId, seq]) => ({ streamId, seq }))
		.sort((left, right) =>
			compareCanonicalStrings(left.streamId, right.streamId, version),
		);
	return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}
