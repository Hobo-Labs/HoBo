import { CoreParseError } from "../errors.js";
import { isJsonString, type JsonValue } from "../json.js";
import { deepFreeze, nonEmptyString, positiveInteger } from "../parse-utils.js";

export type RunId = string & { readonly __brand: "RunId" };
export type StreamName = string & { readonly __brand: "StreamName" };

const DEFAULT_STREAM_NAME_VALUE = "default";
const brandedDefaultStreamName = DEFAULT_STREAM_NAME_VALUE as StreamName;
export const DEFAULT_STREAM_NAME = brandedDefaultStreamName;
export type Seq = number & { readonly __brand: "Seq" };

export type StreamerRunStatus = "completed" | "closed" | "failed";

export interface StreamerFrameRecord {
	readonly runId: string;
	readonly seq: number;
	readonly stream: string;
}

export interface StreamerRunResultRecord {
	readonly runId: string;
	readonly status: StreamerRunStatus;
	readonly reason: string;
}

export interface StreamerFrame<TChunk = unknown> {
	readonly runId: RunId;
	readonly seq: Seq;
	readonly stream: StreamName;
	readonly chunk: TChunk;
}

export interface StreamerRunResult {
	readonly runId: RunId;
	readonly status: StreamerRunStatus;
	readonly reason: string;
}

export interface StreamerWritable<T = unknown> {
	readonly stream: StreamName;
	write(chunk: T): Promise<void>;
}

export interface StreamerRunHandle<TChunk = unknown> {
	readonly runId: RunId;
	readonly readable: AsyncIterable<StreamerFrame<TChunk>>;
	read(options?: { fromSeq?: Seq }): AsyncIterable<StreamerFrame<TChunk>>;
	getWritable<T = TChunk>(stream?: StreamName): StreamerWritable<T>;
	readonly done: Promise<StreamerRunResult>;
}

export interface Streamer {
	createRun<TChunk = unknown>(options?: {
		runId?: RunId;
	}): StreamerRunHandle<TChunk>;
	getRun<TChunk = unknown>(runId: RunId): StreamerRunHandle<TChunk>;
	teardownRun(runId: RunId, reason?: string): StreamerRunResult;
}

export class StreamerParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_STREAMER_PARSE", path, expected, received, message);
		this.name = "StreamerParseError";
	}
}

export class StreamerBackpressureError extends Error {
	readonly code = "STREAMER_BACKPRESSURE" as const;
	readonly runId: RunId;
	readonly bufferLimit: number;

	constructor(runId: RunId, bufferLimit: number) {
		super(`streamer buffer limit reached for ${runId}; limit=${bufferLimit}`);
		this.name = "StreamerBackpressureError";
		this.runId = runId;
		this.bufferLimit = bufferLimit;
	}
}

export class StreamerClosedError extends Error {
	readonly code = "STREAMER_CLOSED" as const;
	readonly runId: RunId;

	constructor(runId: RunId) {
		super(`streamer run is closed: ${runId}`);
		this.name = "StreamerClosedError";
		this.runId = runId;
	}
}

export class StreamerHistoryExpiredError extends Error {
	readonly code = "STREAMER_HISTORY_EXPIRED" as const;
	constructor(
		readonly runId: RunId,
		readonly requestedSeq: Seq,
		readonly firstAvailableSeq: Seq,
	) {
		super(
			`streamer history for ${runId} begins at ${firstAvailableSeq}; requested ${requestedSeq}`,
		);
		this.name = "StreamerHistoryExpiredError";
	}
}

export function parseRunId(value: string): RunId {
	if (!isJsonString(value)) {
		throw new StreamerParseError("runId", "non-empty trimmed string", value);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new StreamerParseError("runId", "non-empty trimmed string", value);
	}
	return trimmed as RunId;
}

export function parseStreamName(
	value: string = DEFAULT_STREAM_NAME,
): StreamName {
	return nonEmptyString(value, "stream", StreamerParseError) as StreamName;
}

export function parseSeq(value: number): Seq {
	return positiveInteger(value, "seq", StreamerParseError) as Seq;
}

export function createStreamerFrame<TChunk>(
	record: StreamerFrameRecord,
	chunk: TChunk,
): StreamerFrame<TChunk> {
	const runId = parseRunId(record.runId);
	const seq = parseSeq(record.seq);
	if (record.stream === undefined) {
		throw new StreamerParseError("stream", "non-empty string", record.stream);
	}
	const stream = parseStreamName(record.stream);
	const frame: StreamerFrame<TChunk> = {
		runId,
		seq,
		stream,
		chunk,
	};
	return deepFreeze(frame);
}

export function createStreamerRunResult(
	record: StreamerRunResultRecord,
): StreamerRunResult {
	const runId = parseRunId(record.runId);
	const status = parseStreamerRunStatus(record.status);
	const reason = nonEmptyString(record.reason, "reason", StreamerParseError);
	const result: StreamerRunResult = {
		runId,
		status,
		reason,
	};
	return deepFreeze(result);
}

function parseStreamerRunStatus(
	value: JsonValue | undefined,
): StreamerRunStatus {
	if (value !== "completed" && value !== "closed" && value !== "failed") {
		throw new StreamerParseError(
			"status",
			"completed | closed | failed",
			value,
		);
	}
	return value;
}
