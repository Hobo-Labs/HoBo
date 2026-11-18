import { fromBinary, fromJson } from "@bufbuild/protobuf";
import {
	ReplayDivergenceSchema,
	ReplayReportSchema,
	type ReplayDivergence as WireReplayDivergence,
	type ReplayReport as WireReplayReport,
} from "../_generated/replay/replay_report_pb.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonValue,
} from "../json.js";
import {
	parseReplayDivergence,
	parseReplayReport,
	ReplayParseError,
} from "./parse.js";
import { captureProtoJson } from "./proto-json.js";
import type { ReplayDivergenceRecord, ReplayReport } from "./types.js";
import { checkReplayWire } from "./wire.js";

/** Decode protobuf JSON, including omitted repeated fields and uint64 strings. */
export function parseReplayReportProtoJson(raw: JsonValue): ReplayReport {
	const captured = captureProtoJson(raw);
	checkJsonVersion(captured);
	checkJsonPositions(captured);
	return reportFromMessage(fromJson(ReplayReportSchema, captured));
}

/** Decode the binary protobuf representation into a validated domain report. */
export function parseReplayReportBinary(bytes: Uint8Array): ReplayReport {
	const captured = new Uint8Array(bytes);
	checkReplayWire(captured, "report");
	return reportFromMessage(fromBinary(ReplayReportSchema, captured));
}

export function parseReplayDivergenceProtoJson(
	raw: JsonValue,
): ReplayDivergenceRecord {
	const captured = captureProtoJson(raw);
	checkJsonVersion(captured);
	return divergenceFromMessage(fromJson(ReplayDivergenceSchema, captured));
}

export function parseReplayDivergenceBinary(
	bytes: Uint8Array,
): ReplayDivergenceRecord {
	const captured = new Uint8Array(bytes);
	checkReplayWire(captured, "divergence");
	return divergenceFromMessage(fromBinary(ReplayDivergenceSchema, captured));
}

function checkJsonVersion(raw: JsonValue): void {
	if (!isJsonObject(raw))
		throw new ReplayParseError("protobuf JSON must be an object");
	// Protobuf JSON normally treats null as absent. A null version must not
	// silently turn new evidence into unmarked legacy evidence.
	const snake = raw.canonicalization_version;
	const camel = raw.canonicalizationVersion;
	if (snake === null || camel === null)
		throw new ReplayParseError("invalid replay canonicalization version");
	if (snake !== undefined && camel !== undefined)
		throw new ReplayParseError("duplicate replay canonicalization version");
	const version = snake === undefined ? camel : snake;
	if (version !== undefined && !isExactKnownVersion(version))
		throw new ReplayParseError("invalid replay canonicalization version");
}

function isExactKnownVersion(value: JsonValue): boolean {
	if (isJsonNumber(value)) return value === 1 || value === 2;
	if (!isJsonString(value) || String(value) !== value) return false;
	const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(
		value,
	);
	if (!match) return false;
	const fraction = match[2] ?? match[3] ?? "";
	const digits = `${match[1] ?? ""}${fraction}`.replace(/^0+/, "");
	const significant = digits.replace(/0+$/, "");
	const exponent = Number(match[4] ?? "0");
	return (
		(significant === "1" || significant === "2") &&
		Number.isSafeInteger(exponent) &&
		exponent + digits.length - significant.length - fraction.length === 0
	);
}

function checkJsonPositions(raw: JsonValue): void {
	if (!isJsonObject(raw))
		throw new ReplayParseError("protobuf JSON must be an object");
	for (const entries of [raw.seq_vector, raw.seqVector]) {
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (!isJsonObject(entry)) continue;
			const value = entry.seq;
			if (isJsonNumber(value) && !Number.isSafeInteger(value))
				throw new ReplayParseError("seq must be a safe integer");
		}
	}
}

function reportFromMessage(message: WireReplayReport): ReplayReport {
	const seqVector = message.seqVector.map(({ streamId, seq }) => {
		if (seq > BigInt(Number.MAX_SAFE_INTEGER))
			throw new ReplayParseError("seq must be a safe integer");
		return { streamId, seq: Number(seq) };
	});
	const record: JsonBag = {
		runId: message.runId,
		seqVector,
		readSetHash: message.readSetHash,
		stateDigest: message.stateDigest,
		mode: message.mode,
		seed: message.seed,
	};
	if (message.canonicalizationVersion !== undefined)
		record.canonicalizationVersion = message.canonicalizationVersion;
	return parseReplayReport(record);
}

function divergenceFromMessage(
	message: WireReplayDivergence,
): ReplayDivergenceRecord {
	const record: JsonBag = {
		runId: message.runId,
		liveStateDigest: message.liveStateDigest,
		replayStateDigest: message.replayStateDigest,
		liveOrder: message.liveOrder,
		replayOrder: message.replayOrder,
		firstDivergentEventKey: message.firstDivergentEventKey,
	};
	if (message.canonicalizationVersion !== undefined)
		record.canonicalizationVersion = message.canonicalizationVersion;
	return parseReplayDivergence(record);
}
