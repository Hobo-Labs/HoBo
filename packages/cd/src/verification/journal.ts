// The cd-verification-<id> stream: event bodies and the fold that rebuilds a
// verification from it. Bodies are protobuf JSON of the generated records,
// so the stream is the whole truth — the engine's memory is only a cache, and
// replay reads exactly what the live engine decided from.
//
//   verification.Started     VerificationStartedBody (identity + spec)
//   rollout.EvidenceObserved EvidenceObservationRecord (one per sample)
//   verification.Completed   VerificationResultRecord
import { fromJson, type JsonObject, type JsonValue, toJson } from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import {
	type EvidenceObservationRecord,
	EvidenceObservationRecordSchema,
	type VerificationResultRecord,
	VerificationResultRecordSchema,
	VerificationSpecRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_EVENTS } from "../events.js";
import type { CampId, FreightId, VerificationId } from "../ports.js";
import { type ParsedVerificationSpec, parseVerificationSpec } from "./spec.js";

export type VerificationState = Readonly<{
	id: VerificationId;
	freightId: FreightId;
	campId: CampId;
	cohortAware: boolean;
	/** Undefined when the spec was refused at start (the stream then completes FAIL at once). */
	spec: ParsedVerificationSpec | undefined;
	startedAtMs: number;
	evidence: readonly EvidenceObservationRecord[];
	result: VerificationResultRecord | undefined;
	/** Stream revision, for the expected-seq CAS on the next append. */
	seq: number;
}>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: JsonValue | undefined): string {
	return typeof value === "string" ? value : "";
}

/** verification.Started body. */
export function startedBody(
	input: Readonly<{ id: VerificationId; freightId: FreightId; campId: CampId; cohortAware: boolean; startedAtMs: number; spec: JsonValue }>,
): JsonObject {
	return {
		verificationId: input.id,
		freightId: input.freightId,
		campId: input.campId,
		cohortAware: input.cohortAware,
		startedAt: new Date(input.startedAtMs).toISOString(),
		spec: input.spec,
	};
}

export function evidenceBody(record: EvidenceObservationRecord): JsonValue {
	return toJson(EvidenceObservationRecordSchema, record);
}

export function resultBody(record: VerificationResultRecord): JsonValue {
	return toJson(VerificationResultRecordSchema, record);
}

function decodeStarted(data: unknown): Omit<VerificationState, "evidence" | "result" | "seq"> | undefined {
	if (!isObject(data)) return undefined;
	const startedAtMs = Date.parse(text(data.startedAt));
	if (!Number.isFinite(startedAtMs)) return undefined;
	let spec: ParsedVerificationSpec | undefined;
	try {
		const parsed = isObject(data.spec) ? parseVerificationSpec(fromJson(VerificationSpecRecordSchema, data.spec)) : undefined;
		spec = parsed?.ok ? parsed.value : undefined;
	} catch {
		spec = undefined;
	}
	return {
		// SAFETY: ids are read back from the stream this engine wrote.
		id: text(data.verificationId) as VerificationId,
		// SAFETY: as above.
		freightId: text(data.freightId) as FreightId,
		// SAFETY: as above.
		campId: text(data.campId) as CampId,
		cohortAware: data.cohortAware === true,
		spec,
		startedAtMs,
	};
}

function decodeRecord<T>(decode: () => T): T | undefined {
	try {
		return decode();
	} catch {
		return undefined;
	}
}

/** Fold a cd-verification stream; undefined when it has no Started event. */
export function foldVerification(events: Iterable<EventEnvelope>): VerificationState | undefined {
	let state: VerificationState | undefined;
	for (const event of events) {
		if (event.type === CD_EVENTS.VerificationStarted) {
			const started = decodeStarted(event.data);
			if (started) state = { ...started, evidence: [], result: undefined, seq: event.seq };
			continue;
		}
		if (!state) continue;
		const json = event.data;
		if (event.type === CD_EVENTS.RolloutEvidenceObserved && isObject(json)) {
			const record = decodeRecord(() => fromJson(EvidenceObservationRecordSchema, json));
			state = { ...state, evidence: record ? [...state.evidence, record] : state.evidence, seq: event.seq };
		} else if (event.type === CD_EVENTS.VerificationCompleted && isObject(json)) {
			const record = decodeRecord(() => fromJson(VerificationResultRecordSchema, json));
			state = { ...state, result: record ?? state.result, seq: event.seq };
		} else {
			state = { ...state, seq: event.seq };
		}
	}
	return state;
}
