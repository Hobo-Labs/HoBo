import type { Queue, VirtualClock } from "@hobo/core";
import {
	createStreamerRunResult,
	DEFAULT_STREAM_NAME,
	parseRunId,
	parseStreamName,
	type RunId,
	type Seq,
	type Streamer,
	type StreamerRunHandle,
	type StreamerRunResult,
	type StreamerRunStatus,
	type StreamerWritable,
	type StreamName,
} from "@hobo/core";
import type {
	QueueClockSnapshot,
	RuntimeLocalQueueClockOptions,
} from "../queue-clock-store.js";

import { createRuntimeLocalQueueClock } from "../replay.js";
import {
	createFrameJournal,
	defaultFromSeq,
	type FrameJournal,
	foldLifecycleStatus,
} from "./frame-journal.js";

export type LocalStreamerOptions = {
	bufferLimit?: number;
	runIdPrefix?: string;
	queueClock?: RuntimeLocalQueueClockOptions;
};

const DEFAULT_BUFFER_LIMIT = 32;
const DEFAULT_RUN_ID_PREFIX = "run";

export function createLocalStreamer(
	options: LocalStreamerOptions = {},
): Streamer {
	const bufferLimit = normalizeBufferLimit(
		options.bufferLimit ?? DEFAULT_BUFFER_LIMIT,
	);
	const runIdPrefix = parseRunId(options.runIdPrefix ?? DEFAULT_RUN_ID_PREFIX);
	const runs = new Map<RunId, FrameJournal<unknown>>();
	let nextRunCounter = 1;

	const streamer: Streamer = {
		createRun<TChunk = unknown>(runOptions: { runId?: RunId } = {}) {
			const runId =
				runOptions.runId ?? parseRunId(`${runIdPrefix}-${nextRunCounter++}`);
			if (runs.has(runId)) {
				throw new Error(`streamer run already exists: ${runId}`);
			}

			const journal = createFrameJournal<TChunk>({
				runId,
				bufferLimit,
				openedAt: new Date(0).toISOString(),
			});
			// SAFETY: assertion to `journal as FrameJournal<unknown>` is required at this boundary.
			runs.set(runId, journal as FrameJournal<unknown>);
			return toRunHandle(journal);
		},
		getRun<TChunk = unknown>(runId: RunId) {
			// SAFETY: assertion to `getJournal(runs, runId) as FrameJournal<TChunk>` is required at this boundary.
			const journal = getJournal(runs, runId) as FrameJournal<TChunk>;
			if (foldLifecycleStatus(journal.lifecycleEvents) !== "open") {
				throw new Error(`streamer run is not open: ${runId}`);
			}
			return toRunHandle(journal);
		},
		teardownRun(runId: RunId, reason = "teardown") {
			const journal = getJournal(runs, runId);
			const result = createStreamerRunResult({
				run_id: runId,
				status: "closed",
				reason,
			});
			journal.close(result);
			runs.delete(runId);
			return result;
		},
	};

	return streamer;
}

function toRunHandle<TChunk>(
	journal: FrameJournal<TChunk>,
): StreamerRunHandle<TChunk> {
	const readable = journal.attachReader(defaultFromSeq());

	return {
		runId: journal.runId,
		readable,
		read(options: { fromSeq?: Seq } = {}) {
			return journal.attachReader(defaultFromSeq(options.fromSeq));
		},
		getWritable<T = TChunk>(
			stream: StreamName = DEFAULT_STREAM_NAME,
		): StreamerWritable<T> {
			const streamName = parseStreamName(stream);
			return {
				stream: streamName,
				async write(chunk: T) {
					// SAFETY: writable stream chunks match the journal TChunk at this boundary.
					journal.write(streamName, chunk as never);
				},
			};
		},
		done: journal.done,
	};
}

function getJournal(
	runs: Map<RunId, FrameJournal<unknown>>,
	runId: RunId,
): FrameJournal<unknown> {
	const journal = runs.get(runId);
	if (!journal) {
		throw new Error(`unknown streamer run: ${runId}`);
	}
	return journal;
}

function normalizeBufferLimit(value: number): number {
	if (!Number.isInteger(value) || value < 1) {
		throw new TypeError("bufferLimit must be a positive integer");
	}
	return value;
}

export type Runtime = {
	readonly streams: Streamer;
	readonly queue: Queue;
	readonly clock: VirtualClock;
	snapshotQueueClock(): QueueClockSnapshot;
};

export function createRuntimeLocal(
	options: LocalStreamerOptions = {},
): Runtime {
	const queueClock = createRuntimeLocalQueueClock(options.queueClock);
	return {
		streams: createLocalStreamer(options),
		queue: queueClock.queue,
		clock: queueClock.clock,
		snapshotQueueClock: queueClock.snapshot,
	};
}

export function createFailedRunResult(
	runId: RunId,
	reason: string,
): StreamerRunResult {
	return createStreamerRunResult({
		run_id: runId,
		status: "failed" satisfies StreamerRunStatus,
		reason,
	});
}
