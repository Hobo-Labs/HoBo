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

export function parseReplayReportProtoJson(raw: JsonValue): ReplayReport {
	const captured = captureProtoJson(raw);
	checkJsonObject(captured);
	checkJsonPositions(captured);
	return reportFromMessage(fromJson(ReplayReportSchema, captured));
}

export function parseReplayReportBinary(bytes: Uint8Array): ReplayReport {
	const captured = new Uint8Array(bytes);
	checkReplayWire(captured, "report");
	return reportFromMessage(fromBinary(ReplayReportSchema, captured));
}

export function parseReplayDivergenceProtoJson(
	raw: JsonValue,
): ReplayDivergenceRecord {
	const captured = captureProtoJson(raw);
	checkJsonObject(captured);
	return divergenceFromMessage(fromJson(ReplayDivergenceSchema, captured));
}

export function parseReplayDivergenceBinary(
	bytes: Uint8Array,
): ReplayDivergenceRecord {
	const captured = new Uint8Array(bytes);
	checkReplayWire(captured, "divergence");
	return divergenceFromMessage(fromBinary(ReplayDivergenceSchema, captured));
}

function checkJsonObject(raw: JsonValue): void {
	if (!isJsonObject(raw))
		throw new ReplayParseError("protobuf JSON must be an object");
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
	return parseReplayDivergence(record);
}
