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
	requireFields(
		source,
		["runId", "seqVector", "readSetHash", "stateDigest", "mode", "seed"],
		"ReplayReport",
	);
	const mode = parseMode(source.mode);
	const seqVector = parseSeqVector(source.seqVector);
	const readSetHash = parseDigest(source.readSetHash, "readSetHash");
	const stateDigest = parseDigest(source.stateDigest, "stateDigest");
	const runId = nonEmptyString(source.runId, "runId");
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
	requireFields(
		source,
		[
			"runId",
			"liveStateDigest",
			"replayStateDigest",
			"liveOrder",
			"replayOrder",
			"firstDivergentEventKey",
		],
		"ReplayDivergence",
	);
	const runId = nonEmptyString(source.runId, "runId");
	const liveStateDigest = parseDigest(
		source.liveStateDigest,
		"liveStateDigest",
	);
	const replayStateDigest = parseDigest(
		source.replayStateDigest,
		"replayStateDigest",
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
		liveOrder: stringArray(source.liveOrder, "liveOrder"),
		replayOrder: stringArray(source.replayOrder, "replayOrder"),
		firstDivergentEventKey: nonEmptyString(
			source.firstDivergentEventKey,
			"firstDivergentEventKey",
		),
	});
}

function parseSeqVector(value: JsonValue | undefined) {
	if (!Array.isArray(value)) {
		throw new ReplayParseError("seqVector must be an array");
	}
	const seen = new Set<string>();
	const entries = value.map((entry, index) => {
		const source = expectObject(entry, `seqVector[${index}]`);
		requireFields(source, ["streamId", "seq"], `seqVector[${index}]`);
		const streamId = nonEmptyString(source.streamId, "streamId");
		if (seen.has(streamId)) {
			throw new ReplayParseError(`duplicate streamId ${streamId}`);
		}
		seen.add(streamId);
		const seq = parseUInt(source.seq, "seq");
		return Object.freeze({ streamId, seq });
	});
	return Object.freeze(entries);
}

function parseMode(value: JsonValue | undefined): ReplayMode {
	if (!isJsonString(value) || !MODES.has(value as ReplayMode)) {
		throw new ReplayParseError('mode must be "live" or "replay"');
	}
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
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < 0) {
		throw new ReplayParseError(`${field} must be a non-negative integer`);
	}
	return value;
}

function stringArray(value: JsonValue | undefined, field: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => !isJsonString(entry))) {
		throw new ReplayParseError(`${field} must be a string array`);
	}
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
	return value as JsonObject;
}

function requireFields(
	value: JsonObject,
	allowed: readonly string[],
	label: string,
): void {
	const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
	if (unexpected)
		throw new ReplayParseError(
			`${label} has an unexpected field: ${unexpected}`,
		);
}
