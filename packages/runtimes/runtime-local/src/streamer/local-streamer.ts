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
			let runId: RunId;
			if (runOptions.runId === undefined) {
				do {
					runId = parseRunId(`${runIdPrefix}-${nextRunCounter++}`);
				} while (runs.has(runId));
			} else {
				runId = parseRunId(runOptions.runId);
			}
			if (runs.has(runId)) {
				throw new Error(`streamer run already exists: ${runId}`);
			}

			const journal = createFrameJournal<TChunk>({
				runId,
				bufferLimit,
				openedAt: new Date(0).toISOString(),
			});
			runs.set(runId, journal as FrameJournal<unknown>);
			return toRunHandle(journal);
		},
		start<TChunk = unknown>(
			workflow: (
				context: Pick<StreamerRunHandle<TChunk>, "runId" | "getWritable">,
			) => void | PromiseLike<void>,
			runOptions: { runId?: RunId } = {},
		) {
			if (!(workflow instanceof Function)) {
				throw new TypeError("workflow must be a function");
			}
			const run = streamer.createRun<TChunk>(runOptions);
			const journal = getJournal(runs, run.runId);
			function close(status: "completed" | "failed", reason: string): void {
				journal.close(
					createStreamerRunResult({ runId: run.runId, status, reason }),
				);
				if (runs.get(run.runId) === journal) runs.delete(run.runId);
			}
			void Promise.resolve()
				.then(() =>
					workflow({ runId: run.runId, getWritable: run.getWritable }),
				)
				.then(
					() => close("completed", "workflow completed"),
					(error) => {
						let reason = "workflow failed";
						try {
							const detail =
								error instanceof Error ? error.message : String(error);
							if (detail.trim().length > 0) reason = detail;
						} catch {}
						close("failed", reason);
					},
				);
			return run;
		},
		getRun<TChunk = unknown>(runId: RunId) {
			const journal = getJournal(runs, runId) as FrameJournal<TChunk>;
			if (foldLifecycleStatus(journal.lifecycleEvents) !== "open") {
				throw new Error(`streamer run is not open: ${runId}`);
			}
			return toRunHandle(journal);
		},
		teardownRun(runId: RunId, reason = "teardown") {
			const journal = getJournal(runs, runId);
			const result = createStreamerRunResult({
				runId,
				status: "closed",
				reason,
			});
			const closed = journal.close(result);
			runs.delete(runId);
			return closed;
		},
	};

	return streamer;
}

function toRunHandle<TChunk>(
	journal: FrameJournal<TChunk>,
): StreamerRunHandle<TChunk> {
	function read(options: { fromSeq?: Seq } = {}) {
		const fromSeq = defaultFromSeq(options.fromSeq);
		return {
			[Symbol.asyncIterator]() {
				return journal.attachReader(fromSeq)[Symbol.asyncIterator]();
			},
		};
	}

	return {
		runId: journal.runId,
		readable: read(),
		read,
		getWritable<T = TChunk>(
			stream: StreamName = DEFAULT_STREAM_NAME,
		): StreamerWritable<T> {
			const streamName = parseStreamName(stream);
			return {
				stream: streamName,
				async write(chunk: T) {
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
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new TypeError("bufferLimit must be a positive safe integer");
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
		runId,
		status: "failed" satisfies StreamerRunStatus,
		reason,
	});
}
