import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import type {
	ReplayDivergenceRecord,
	ReplayMode,
	ReplayReport,
} from "./types.js";

const HEX64 = /^[0-9a-f]{64}$/;
const MODES = new Set<ReplayMode>(["live", "replay"]);

export class ReplayParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReplayParseError";
	}
}

export function parseReplayReport(raw: JsonValue): ReplayReport {
	const source = expectObject(raw, "ReplayReport");
	const mode = parseMode(source.mode);
	const seqVector = parseSeqVector(source.seq_vector ?? source.seqVector);
	const readSetHash = parseDigest(
		source.read_set_hash ?? source.readSetHash,
		"read_set_hash",
	);
	const stateDigest = parseDigest(
		source.state_digest ?? source.stateDigest,
		"state_digest",
	);
	const runId = nonEmptyString(source.run_id ?? source.runId, "run_id");
	const seed = nonEmptyString(source.seed, "seed");

	return Object.freeze({
		runId,
		seqVector: [...seqVector],
		readSetHash,
		stateDigest,
		mode,
		seed,
	});
}

export function parseReplayDivergence(raw: JsonValue): ReplayDivergenceRecord {
	const source = expectObject(raw, "ReplayDivergence");
	const runId = nonEmptyString(source.run_id ?? source.runId, "run_id");
	const liveStateDigest = parseDigest(
		source.live_state_digest ?? source.liveStateDigest,
		"live_state_digest",
	);
	const replayStateDigest = parseDigest(
		source.replay_state_digest ?? source.replayStateDigest,
		"replay_state_digest",
	);
	if (liveStateDigest === replayStateDigest) {
		throw new ReplayParseError(
			"ReplayDivergence requires differing state digests",
		);
	}

	return Object.freeze({
		runId,
		liveStateDigest,
		replayStateDigest,
		liveOrder: stringArray(source.live_order ?? source.liveOrder, "live_order"),
		replayOrder: stringArray(
			source.replay_order ?? source.replayOrder,
			"replay_order",
		),
		firstDivergentEventKey: nonEmptyString(
			source.first_divergent_event_key ?? source.firstDivergentEventKey,
			"first_divergent_event_key",
		),
	});
}

function parseSeqVector(value: JsonValue | undefined) {
	if (!Array.isArray(value)) {
		throw new ReplayParseError("seq_vector must be an array");
	}
	const seen = new Set<string>();
	const entries = value.map((entry, index) => {
		const source = expectObject(entry, `seq_vector[${index}]`);
		const streamId = nonEmptyString(
			source.stream_id ?? source.streamId,
			"stream_id",
		);
		if (seen.has(streamId)) {
			throw new ReplayParseError(`duplicate stream_id ${streamId}`);
		}
		seen.add(streamId);
		const seq = parseUInt(source.seq, "seq");
		return Object.freeze({ streamId, seq });
	});
	return Object.freeze(entries);
}

function parseMode(value: JsonValue | undefined): ReplayMode {
	// SAFETY: assertion to `value as ReplayMode` is required at this boundary.
	if (!isJsonString(value) || !MODES.has(value as ReplayMode)) {
		throw new ReplayParseError('mode must be "live" or "replay"');
	}
	// SAFETY: assertion to `value as ReplayMode` is required at this boundary.
	return value as ReplayMode;
}

function parseDigest(value: JsonValue | undefined, field: string): string {
	const digest = nonEmptyString(value, field);
	if (!HEX64.test(digest)) {
		throw new ReplayParseError(
			`${field} must be a 64-char lowercase hex digest`,
		);
	}
	return digest;
}

function parseUInt(value: JsonValue | undefined, field: string): number {
	if (!isJsonNumber(value) || !Number.isInteger(value) || value < 0) {
		throw new ReplayParseError(`${field} must be a non-negative integer`);
	}
	return value;
}

function stringArray(value: JsonValue | undefined, field: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => !isJsonString(entry))) {
		throw new ReplayParseError(`${field} must be a string array`);
	}
	// SAFETY: assertion to `Object.freeze([...value]) as string[]` is required at this boundary.
	return Object.freeze([...value]) as string[];
}

function nonEmptyString(value: JsonValue | undefined, field: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new ReplayParseError(`${field} must be a non-empty string`);
	}
	return value;
}

function expectObject(value: JsonValue | undefined, label: string): JsonObject {
	if (!value || !isJsonObject(value) || Array.isArray(value)) {
		throw new ReplayParseError(`${label} must be an object`);
	}
	// SAFETY: assertion to `value as JsonObject` is required at this boundary.
	return value as JsonObject;
}
