import {
	createStreamerFrame,
	DEFAULT_STREAM_NAME,
	parseSeq,
	type RunId,
	type Seq,
	StreamerBackpressureError,
	StreamerClosedError,
	type StreamerFrame,
	type StreamerRunResult,
	type StreamerRunStatus,
	type StreamName,
} from "@hobo/core";

const END_OF_STREAM = Symbol("streamer.end");

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
};

type ReaderState<TChunk> = {
	nextSeq: number;
	waiters: Array<(value: typeof END_OF_STREAM | StreamerFrame<TChunk>) => void>;
};

export type LifecycleEvent =
	| {
			readonly kind: "opened";
			readonly runId: RunId;
			readonly openedAt: string;
	  }
	| {
			readonly kind: "closed";
			readonly runId: RunId;
			readonly status: StreamerRunStatus;
			readonly reason: string;
			readonly closedAt: string;
	  };

export type FrameJournal<TChunk = unknown> = {
	readonly runId: RunId;
	readonly bufferLimit: number;
	attachReader(fromSeq: Seq): AsyncIterable<StreamerFrame<TChunk>>;
	write(stream: StreamName, chunk: TChunk): StreamerFrame<TChunk>;
	close(result: StreamerRunResult): StreamerRunResult;
	readonly lifecycleEvents: readonly LifecycleEvent[];
	readonly done: Promise<StreamerRunResult>;
};

export function createFrameJournal<TChunk>(options: {
	runId: RunId;
	bufferLimit: number;
	openedAt: string;
}): FrameJournal<TChunk> {
	const frames: StreamerFrame<TChunk>[] = [];
	const readers = new Map<symbol, ReaderState<TChunk>>();
	let nextSeq = 1;
	let closed = false;
	let closeResult: StreamerRunResult | undefined;
	const done = createDeferred<StreamerRunResult>();
	// The journal owns completion even when consumers read only frames. Observe
	// rejection immediately without replacing the original promise: explicit
	// completion waiters must still receive the failed run's error, including
	// callers that attach after close.
	void done.promise.catch(() => undefined);
	const lifecycleEvents: LifecycleEvent[] = [
		{ kind: "opened", runId: options.runId, openedAt: options.openedAt },
	];

	const journal: FrameJournal<TChunk> = {
		runId: options.runId,
		bufferLimit: options.bufferLimit,
		lifecycleEvents,
		done: done.promise,
		attachReader(fromSeq: Seq) {
			const readerId = Symbol("reader");
			readers.set(readerId, {
				nextSeq: fromSeq,
				waiters: [],
			});

			return {
				[Symbol.asyncIterator]() {
					return {
						async next() {
							const reader = readers.get(readerId);
							if (!reader) {
								return { value: undefined, done: true };
							}

							while (true) {
								const frame = frames.find(
									(entry) => entry.seq === reader.nextSeq,
								);
								if (frame) {
									reader.nextSeq += 1;
									return { value: frame, done: false };
								}

								if (closed) {
									readers.delete(readerId);
									return { value: undefined, done: true };
								}

								const value = await new Promise<
									typeof END_OF_STREAM | StreamerFrame<TChunk>
								>((resolve) => {
									reader.waiters.push(resolve);
								});

								if (value === END_OF_STREAM) {
									readers.delete(readerId);
									return { value: undefined, done: true };
								}

								if (value.seq === reader.nextSeq) {
									reader.nextSeq += 1;
									return { value, done: false };
								}
							}
						},
					};
				},
			};
		},
		write(stream: StreamName, chunk: TChunk) {
			if (closed) {
				throw new StreamerClosedError(options.runId);
			}

			assertBackpressure();

			const frame = createStreamerFrame<TChunk>(
				{
					run_id: options.runId,
					seq: nextSeq,
					stream,
				},
				chunk,
			);
			frames.push(frame);
			nextSeq += 1;
			notifyReaders(frame);
			return frame;
		},
		close(result: StreamerRunResult) {
			if (closed) {
				// SAFETY: assertion to `closeResult as StreamerRunResult` is required at this boundary.
				return closeResult as StreamerRunResult;
			}

			closed = true;
			closeResult = result;
			lifecycleEvents.push({
				kind: "closed",
				runId: result.runId,
				status: result.status,
				reason: result.reason,
				closedAt: new Date(0).toISOString(),
			});

			if (result.status === "failed") {
				done.reject(new Error(result.reason));
			} else {
				done.resolve(result);
			}

			for (const reader of readers.values()) {
				for (const waiter of reader.waiters.splice(0)) {
					waiter(END_OF_STREAM);
				}
			}

			return result;
		},
	};

	function assertBackpressure(): void {
		if (readers.size === 0) {
			return;
		}

		const slowest = Math.min(
			...[...readers.values()].map((reader) => reader.nextSeq),
		);
		if (nextSeq - slowest >= journal.bufferLimit) {
			throw new StreamerBackpressureError(options.runId, journal.bufferLimit);
		}
	}

	function notifyReaders(frame: StreamerFrame<TChunk>): void {
		for (const reader of readers.values()) {
			if (reader.nextSeq === frame.seq) {
				const waiter = reader.waiters.shift();
				if (waiter) {
					waiter(frame);
				}
			}
		}
	}

	return journal;
}

export function foldLifecycleStatus(
	events: readonly LifecycleEvent[],
): "open" | StreamerRunStatus {
	let opened = false;
	let status: "open" | StreamerRunStatus = "open";

	for (const event of events) {
		if (event.kind === "opened") {
			opened = true;
			status = "open";
			continue;
		}
		if (!opened) {
			throw new Error("closed before opened");
		}
		status = event.status;
	}

	return status;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

export function defaultFromSeq(value?: Seq): Seq {
	return value ?? parseSeq(1);
}

export { DEFAULT_STREAM_NAME };
