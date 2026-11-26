import {
	parseRunId,
	parseSeq,
	parseStreamName,
	type RunId,
	type Seq,
	type Streamer,
	StreamerBackpressureError,
	StreamerClosedError,
	type StreamerFrame,
	type StreamName,
} from "@hobo/core";

export const STREAMER_CONFORMANCE_CONTRACT = "hobo.streamer-runtime-port/v1";

export type StreamerAssertionName =
	| "orderedRunReadable"
	| "multiplexedStreamsOrdered"
	| "boundedBackpressure"
	| "teardownClosesStream"
	| "replayThenLive"
	| "multiReaderIndependence";

export type StreamerConformanceReport = {
	readonly contract: typeof STREAMER_CONFORMANCE_CONTRACT;
	readonly backend: string;
	readonly assertions: Record<StreamerAssertionName, "pass" | "fail">;
};

export async function runStreamerConformance(
	createStreamer: () => Streamer,
): Promise<StreamerConformanceReport> {
	// SAFETY: assertion to `{} as Record<StreamerAssertionName, "pass" | "fail">` is required at this boundary.
	const assertions = {} as Record<StreamerAssertionName, "pass" | "fail">;

	const runAssertion = async (
		name: StreamerAssertionName,
		fn: () => Promise<void>,
	) => {
		try {
			await fn();
			assertions[name] = "pass";
		} catch {
			assertions[name] = "fail";
		}
	};

	await runAssertion("orderedRunReadable", () =>
		provesOrderedRunReadable(createStreamer),
	);
	await runAssertion("multiplexedStreamsOrdered", () =>
		provesMultiplexedStreamsOrdered(createStreamer),
	);
	await runAssertion("boundedBackpressure", () =>
		provesBoundedBackpressure(createStreamer),
	);
	await runAssertion("teardownClosesStream", () =>
		provesTeardownClosesStream(createStreamer),
	);
	await runAssertion("replayThenLive", () =>
		provesReplayThenLive(createStreamer),
	);
	await runAssertion("multiReaderIndependence", () =>
		provesMultiReaderIndependence(createStreamer),
	);

	return {
		contract: STREAMER_CONFORMANCE_CONTRACT,
		backend: "runtime-local",
		assertions,
	};
}

async function collect<TChunk>(
	readable: AsyncIterable<StreamerFrame<TChunk>>,
): Promise<StreamerFrame<TChunk>[]> {
	const frames: StreamerFrame<TChunk>[] = [];
	for await (const frame of readable) {
		frames.push(frame);
	}
	return frames;
}

async function provesOrderedRunReadable(
	createStreamer: () => Streamer,
): Promise<void> {
	const streamer = createStreamer();
	const runId = parseRunId("run:ordered");
	const run = streamer.createRun({ runId });
	const stdout = run.getWritable(parseStreamName("stdout"));

	await stdout.write("first");
	await stdout.write("second");
	streamer.teardownRun(runId);

	const frames = await collect(run.readable);
	assertFramesEqual(frames, [
		{
			runId,
			seq: parseSeq(1),
			stream: parseStreamName("stdout"),
			chunk: "first",
		},
		{
			runId,
			seq: parseSeq(2),
			stream: parseStreamName("stdout"),
			chunk: "second",
		},
	]);
}

async function provesMultiplexedStreamsOrdered(
	createStreamer: () => Streamer,
): Promise<void> {
	const streamer = createStreamer();
	const runId = parseRunId("run:multiplexed");
	const run = streamer.createRun({ runId });
	const stdout = run.getWritable(parseStreamName("stdout"));
	const logs = run.getWritable(parseStreamName("logs"));

	await stdout.write("one");
	await logs.write({ level: "debug" });
	await stdout.write("two");
	streamer.teardownRun(runId);

	const frames = await collect(run.readable);
	assertSequence(
		frames.map(({ seq, stream, chunk }) => ({ seq, stream, chunk })),
		[
			{ seq: parseSeq(1), stream: parseStreamName("stdout"), chunk: "one" },
			{
				seq: parseSeq(2),
				stream: parseStreamName("logs"),
				chunk: { level: "debug" },
			},
			{ seq: parseSeq(3), stream: parseStreamName("stdout"), chunk: "two" },
		],
	);
}

async function provesBoundedBackpressure(
	createStreamer: () => Streamer,
): Promise<void> {
	const streamer = createStreamer();
	const runId = parseRunId("run:backpressure");
	const run = streamer.createRun({ runId });
	const writable = run.getWritable(parseStreamName("stdout"));
	const reader = run.readable[Symbol.asyncIterator]();

	let backpressured = false;
	for (let index = 0; index < 256; index += 1) {
		try {
			await writable.write(`held-${index}`);
		} catch (error) {
			if (!(error instanceof StreamerBackpressureError)) {
				throw error;
			}
			backpressured = true;
			break;
		}
	}

	if (!backpressured) {
		throw new Error("expected StreamerBackpressureError");
	}

	streamer.teardownRun(runId);
	await drainIterator(reader);
}

async function provesTeardownClosesStream(
	createStreamer: () => Streamer,
): Promise<void> {
	const streamer = createStreamer();
	const runId = parseRunId("run:closed");
	const run = streamer.createRun({ runId });
	const writable = run.getWritable(parseStreamName("stdout"));

	await writable.write("final");
	streamer.teardownRun(runId);

	await expectRejected(writable.write("after"), StreamerClosedError);
	const frames = await collect(run.readable);
	assertChunks(frames, ["final"]);
}

async function provesReplayThenLive(
	createStreamer: () => Streamer,
): Promise<void> {
	const streamer = createStreamer();
	const runId = parseRunId("run:replay-then-live");
	const run = streamer.createRun({ runId });
	const writable = run.getWritable(parseStreamName("stdout"));

	for (let index = 1; index <= 10; index += 1) {
		await writable.write(`backfill-${index}`);
	}

	const attached = streamer.getRun(runId);
	const liveIterator = attached.read()[Symbol.asyncIterator]();

	await writable.write("live-11");
	await writable.write("live-12");
	streamer.teardownRun(runId);

	const frames = await collectFromIterator(liveIterator);
	assertStrictSeqOrder(frames);
	assertChunks(frames, [
		"backfill-1",
		"backfill-2",
		"backfill-3",
		"backfill-4",
		"backfill-5",
		"backfill-6",
		"backfill-7",
		"backfill-8",
		"backfill-9",
		"backfill-10",
		"live-11",
		"live-12",
	]);
}

async function provesMultiReaderIndependence(
	createStreamer: () => Streamer,
): Promise<void> {
	const streamer = createStreamer();
	const runId = parseRunId("run:multi-reader");
	const run = streamer.createRun({ runId });
	const writable = run.getWritable(parseStreamName("stdout"));

	await writable.write("a");
	await writable.write("b");

	const earlyReader = run.read();
	await writable.write("c");

	const lateReader = streamer.getRun(runId).read();
	await writable.write("d");
	streamer.teardownRun(runId);

	const earlyFrames = await collect(earlyReader);
	const lateFrames = await collect(lateReader);

	assertChunks(earlyFrames, ["a", "b", "c", "d"]);
	assertChunks(lateFrames, ["a", "b", "c", "d"]);
	assertStrictSeqOrder(earlyFrames);
	assertStrictSeqOrder(lateFrames);
}

function assertFramesEqual<TChunk>(
	frames: StreamerFrame<TChunk>[],
	expected: Array<{
		runId: RunId;
		seq: Seq;
		stream: StreamName;
		chunk: TChunk;
	}>,
): void {
	if (frames.length !== expected.length) {
		throw new Error(`expected ${expected.length} frames, got ${frames.length}`);
	}
	for (let index = 0; index < expected.length; index += 1) {
		const frame = frames[index];
		const want = expected[index];
		if (
			frame?.runId !== want?.runId ||
			frame?.seq !== want?.seq ||
			frame?.stream !== want?.stream ||
			frame?.chunk !== want?.chunk
		) {
			throw new Error(`frame mismatch at index ${index}`);
		}
	}
}

function assertSequence<T>(actual: T[], expected: T[]): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error("sequence mismatch");
	}
}

function assertChunks<TChunk>(
	frames: StreamerFrame<TChunk>[],
	chunks: TChunk[],
): void {
	const actual = frames.map((frame) => frame.chunk);
	if (JSON.stringify(actual) !== JSON.stringify(chunks)) {
		throw new Error("chunk sequence mismatch");
	}
}

function assertStrictSeqOrder<TChunk>(frames: StreamerFrame<TChunk>[]): void {
	const seen = new Set<number>();
	for (let index = 0; index < frames.length; index += 1) {
		const frame = frames[index];
		if (!frame) {
			throw new Error("missing frame");
		}
		const expectedSeq = index + 1;
		if (frame.seq !== expectedSeq) {
			throw new Error(
				`seq gap or duplicate at index ${index}: expected ${expectedSeq}, got ${frame.seq}`,
			);
		}
		if (seen.has(frame.seq)) {
			throw new Error(`duplicate seq ${frame.seq}`);
		}
		seen.add(frame.seq);
	}
}

async function expectRejected<T>(
	promise: Promise<T>,
	ErrorClass: new (...args: never[]) => Error,
): Promise<void> {
	try {
		await promise;
		throw new Error(`expected ${ErrorClass.name}`);
	} catch (error) {
		if (!(error instanceof ErrorClass)) {
			throw error;
		}
	}
}

async function collectFromIterator<T>(
	iterator: AsyncIterator<T>,
): Promise<T[]> {
	const values: T[] = [];
	while (true) {
		const next = await iterator.next();
		if (next.done) {
			break;
		}
		values.push(next.value);
	}
	return values;
}

async function drainIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
	while (true) {
		const next = await iterator.next();
		if (next.done) {
			break;
		}
	}
}
