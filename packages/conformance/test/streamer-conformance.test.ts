/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this conformance test intentionally casts controlled fake-streamer values to exercise runtime contract failures. */

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
	type StreamerRunHandle,
	type StreamerRunResult,
	type StreamerWritable,
	type StreamName,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	runStreamerConformance,
	STREAMER_CONFORMANCE_CONTRACT,
	type StreamerAssertionName,
} from "../src/streamer.js";

interface Defects {
	reverseOrder?: boolean;
	perStreamSeq?: boolean;
	unboundedBuffer?: boolean;
	writeAfterTeardown?: boolean;
	noBackfill?: boolean;
	sharedReader?: boolean;
}

const BUFFER_LIMIT = 32;

function createMemoryStreamer(defects: Defects = {}): Streamer {
	const runs = new Map<RunId, RunState>();

	interface RunState {
		readonly runId: RunId;
		frames: StreamerFrame<unknown>[];
		seq: number;
		perStream: Map<string, number>;
		closed: boolean;
		sharedIterator?: AsyncIterator<StreamerFrame<unknown>>;
	}

	function stateFor(runId: RunId): RunState {
		const existing = runs.get(runId);
		if (existing) return existing;
		const created: RunState = {
			runId,
			frames: [],
			seq: 0,
			perStream: new Map(),
			closed: false,
		};
		runs.set(runId, created);
		return created;
	}

	function framesFor(state: RunState): StreamerFrame<unknown>[] {
		return defects.reverseOrder ? [...state.frames].reverse() : state.frames;
	}

	function handleFor(runId: RunId): StreamerRunHandle<unknown> {
		const state = stateFor(runId);

		function iterate(fromIndex: number): AsyncIterable<StreamerFrame<unknown>> {
			if (defects.sharedReader) {
				state.sharedIterator ??= makeIterator(0);
				const shared = state.sharedIterator;
				return { [Symbol.asyncIterator]: () => shared };
			}
			return { [Symbol.asyncIterator]: () => makeIterator(fromIndex) };
		}

		function makeIterator(
			fromIndex: number,
		): AsyncIterator<StreamerFrame<unknown>> {
			let index = fromIndex;
			return {
				async next() {
					const available = framesFor(state);
					if (index < available.length) {
						const value = available[index] as StreamerFrame<unknown>;
						index += 1;
						return { value, done: false };
					}
					return { value: undefined as never, done: true };
				},
			};
		}

		return {
			runId,
			get readable() {
				return iterate(0);
			},
			read(options?: { fromSeq?: Seq }) {
				const from = defects.noBackfill
					? framesFor(state).length
					: (options?.fromSeq ?? 1) - 1;
				return iterate(from);
			},
			getWritable<T>(stream?: StreamName): StreamerWritable<T> {
				const name = stream ?? parseStreamName("default");
				return {
					stream: name,
					async write(chunk: T) {
						if (state.closed && !defects.writeAfterTeardown) {
							throw new StreamerClosedError(runId);
						}
						if (
							!defects.unboundedBuffer &&
							state.frames.length >= BUFFER_LIMIT
						) {
							throw new StreamerBackpressureError(runId, BUFFER_LIMIT);
						}
						const next = defects.perStreamSeq
							? (state.perStream.get(name) ?? 0) + 1
							: state.seq + 1;
						if (defects.perStreamSeq) state.perStream.set(name, next);
						else state.seq = next;
						state.frames.push({
							run_id: runId,
							runId,
							seq: parseSeq(next),
							stream: name,
							chunk,
						});
					},
				};
			},
			done: Promise.resolve({
				run_id: runId,
				runId,
				status: "completed",
				reason: "done",
			} as StreamerRunResult),
		};
	}

	return {
		createRun<TChunk>(options?: { runId?: RunId }) {
			const runId = options?.runId ?? parseRunId(`run-${runs.size + 1}`);
			stateFor(runId);
			return handleFor(runId) as StreamerRunHandle<TChunk>;
		},
		getRun<TChunk>(runId: RunId) {
			return handleFor(runId) as StreamerRunHandle<TChunk>;
		},
		teardownRun(runId: RunId, reason = "teardown"): StreamerRunResult {
			const state = stateFor(runId);
			state.closed = true;
			return {
				run_id: runId,
				runId,
				status: "closed",
				reason,
			};
		},
	};
}

const ALL_ASSERTIONS: StreamerAssertionName[] = [
	"orderedRunReadable",
	"multiplexedStreamsOrdered",
	"boundedBackpressure",
	"teardownClosesStream",
	"replayThenLive",
	"multiReaderIndependence",
];

describe("runStreamerConformance against a faithful implementation", () => {
	it("passes every assertion", async () => {
		const report = await runStreamerConformance(() => createMemoryStreamer());
		expect(report.assertions).toEqual({
			orderedRunReadable: "pass",
			multiplexedStreamsOrdered: "pass",
			boundedBackpressure: "pass",
			teardownClosesStream: "pass",
			replayThenLive: "pass",
			multiReaderIndependence: "pass",
		});
	});

	it("reports the contract id and the backend it ran against", async () => {
		const report = await runStreamerConformance(() => createMemoryStreamer());
		expect(report.contract).toBe(STREAMER_CONFORMANCE_CONTRACT);
		expect(STREAMER_CONFORMANCE_CONTRACT).toBe("hobo.streamer-runtime-port/v1");
		expect(report.backend).toBe("runtime-local");
	});

	it("names every assertion in the report", async () => {
		const report = await runStreamerConformance(() => createMemoryStreamer());
		expect(Object.keys(report.assertions).sort()).toEqual(
			[...ALL_ASSERTIONS].sort(),
		);
	});

	it("builds a fresh streamer for each assertion", async () => {
		let constructed = 0;
		await runStreamerConformance(() => {
			constructed += 1;
			return createMemoryStreamer();
		});
		expect(constructed).toBe(ALL_ASSERTIONS.length);
	});
});

describe("each assertion catches the defect it exists to catch", () => {
	async function assertionsFor(defects: Defects) {
		const report = await runStreamerConformance(() =>
			createMemoryStreamer(defects),
		);
		return report.assertions;
	}

	it("orderedRunReadable fails when frames arrive out of order", async () => {
		const assertions = await assertionsFor({ reverseOrder: true });
		expect(assertions.orderedRunReadable).toBe("fail");
	});

	it("multiplexedStreamsOrdered fails when seq restarts per stream", async () => {
		const assertions = await assertionsFor({ perStreamSeq: true });
		expect(assertions.multiplexedStreamsOrdered).toBe("fail");
	});

	it("boundedBackpressure fails when the buffer is unbounded", async () => {
		const assertions = await assertionsFor({ unboundedBuffer: true });
		expect(assertions.boundedBackpressure).toBe("fail");
	});

	it("teardownClosesStream fails when writes are accepted after teardown", async () => {
		const assertions = await assertionsFor({ writeAfterTeardown: true });
		expect(assertions.teardownClosesStream).toBe("fail");
	});

	it("replayThenLive fails when a late reader gets no backfill", async () => {
		const assertions = await assertionsFor({ noBackfill: true });
		expect(assertions.replayThenLive).toBe("fail");
	});

	it("multiReaderIndependence fails when readers share one cursor", async () => {
		const assertions = await assertionsFor({ sharedReader: true });
		expect(assertions.multiReaderIndependence).toBe("fail");
	});
});

describe("failure isolation", () => {
	it("records a failure per assertion rather than aborting the run", async () => {
		const assertions = await runStreamerConformance(() =>
			createMemoryStreamer({ reverseOrder: true }),
		).then((report) => report.assertions);
		expect(Object.keys(assertions)).toHaveLength(ALL_ASSERTIONS.length);
		expect(Object.values(assertions)).toContain("fail");
	});

	it("reports a fail rather than throwing when the streamer cannot be built", async () => {
		const report = await runStreamerConformance(() => {
			throw new Error("cannot construct");
		});
		expect(Object.values(report.assertions)).toEqual(
			ALL_ASSERTIONS.map(() => "fail"),
		);
	});

	it("does not let one defective implementation report any spurious pass", async () => {
		const report = await runStreamerConformance(() =>
			createMemoryStreamer({
				reverseOrder: true,
				perStreamSeq: true,
				unboundedBuffer: true,
				writeAfterTeardown: true,
				noBackfill: true,
				sharedReader: true,
			}),
		);
		expect(Object.values(report.assertions)).not.toContain("pass");
	});
});
