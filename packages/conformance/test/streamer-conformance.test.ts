/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this conformance test intentionally casts controlled fake-streamer values to exercise runtime contract failures. */

/**
 * The Streamer runtime-port conformance suite.
 *
 * A conformance suite is only worth what its assertions can *catch*. A suite
 * that reports six passes against every implementation, including a broken
 * one, is worse than no suite: it certifies backends that do not hold the
 * contract, and the certification is what downstream code trusts when it
 * assumes frames arrive in order and a torn-down run stops accepting writes.
 *
 * So this file does two things. It runs the suite against a faithful in-memory
 * Streamer and requires six passes — the reference direction. Then, for each
 * assertion, it runs the suite against an implementation broken in exactly the
 * way that assertion exists to detect, and requires *that* assertion to fail.
 * A regression that neuters one check shows up as a "fail" turning into a
 * "pass", which is the direction a normal test suite cannot see.
 *
 * The in-memory Streamer here is deliberately minimal rather than a copy of a
 * production one: the suite is the subject, and a faithful-enough reference is
 * all it needs.
 */
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

/** Knobs that each break exactly one contract guarantee. */
interface Defects {
	/** Emit frames in reverse order, breaking every ordering assertion. */
	reverseOrder?: boolean;
	/** Restart the seq counter per stream, so multiplexed frames collide. */
	perStreamSeq?: boolean;
	/** Accept writes without bound, so backpressure never triggers. */
	unboundedBuffer?: boolean;
	/** Keep accepting writes after teardown. */
	writeAfterTeardown?: boolean;
	/** Serve a late reader only frames written after it attached. */
	noBackfill?: boolean;
	/** Hand every reader the same iterator, so one reader consumes another's. */
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
					// The run is only ever torn down synchronously in these proofs, so
					// "no more frames and closed" is the terminal condition. A live
					// backend would await a wake here.
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
				// A late reader gets the backfill by default. `noBackfill` is the
				// defect that skips it.
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
		// All six, not "most". A reference implementation that could not pass the
		// suite would mean the suite encodes a contract nothing can satisfy, and
		// every subsequent failure would be dismissed as expected.
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
		// The contract id is what a consumer pins to know *which* version of the
		// port a report attests to. A report without it is unattributable.
		const report = await runStreamerConformance(() => createMemoryStreamer());
		expect(report.contract).toBe(STREAMER_CONFORMANCE_CONTRACT);
		expect(STREAMER_CONFORMANCE_CONTRACT).toBe("hobo.streamer-runtime-port/v1");
		expect(report.backend).toBe("runtime-local");
	});

	it("names every assertion in the report", async () => {
		// The report is a fixed-shape record, so a consumer can tell "this
		// assertion failed" from "this assertion was not run". A suite that
		// omitted a key on error would make a crash look like a pass.
		const report = await runStreamerConformance(() => createMemoryStreamer());
		expect(Object.keys(report.assertions).sort()).toEqual(
			[...ALL_ASSERTIONS].sort(),
		);
	});

	it("builds a fresh streamer for each assertion", async () => {
		// Each proof calls `createStreamer()` itself, so state cannot leak from
		// one assertion into the next. A shared instance would make the
		// backpressure proof's 32 buffered frames poison every later proof, and
		// the failures would look like unrelated ordering bugs.
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
		// The most basic guarantee: a consumer reading a run's output assumes the
		// bytes are in the order they were written. Out-of-order frames would
		// scramble a build log with no error anywhere.
		const assertions = await assertionsFor({ reverseOrder: true });
		expect(assertions.orderedRunReadable).toBe("fail");
	});

	it("multiplexedStreamsOrdered fails when seq restarts per stream", async () => {
		// The seq is per *run*, not per stream, precisely so that stdout and logs
		// can be interleaved back into the order they actually happened. A
		// per-stream counter makes two frames share a seq, and any consumer
		// merging them by seq would report a false interleaving.
		const assertions = await assertionsFor({ perStreamSeq: true });
		expect(assertions.multiplexedStreamsOrdered).toBe("fail");
	});

	it("boundedBackpressure fails when the buffer is unbounded", async () => {
		// An unbounded buffer does not look broken — it looks fast, until a run
		// whose reader stalled takes the process's memory with it. The proof
		// writes 256 frames and requires the implementation to refuse one.
		const assertions = await assertionsFor({ unboundedBuffer: true });
		expect(assertions.boundedBackpressure).toBe("fail");
	});

	it("teardownClosesStream fails when writes are accepted after teardown", async () => {
		// A write accepted after teardown is data appended to a run something
		// else has already reported as finished. Silently dropping it would be
		// nearly as bad; the contract requires a refusal so the writer learns.
		const assertions = await assertionsFor({ writeAfterTeardown: true });
		expect(assertions.teardownClosesStream).toBe("fail");
	});

	it("replayThenLive fails when a late reader gets no backfill", async () => {
		// This is the one an implementation is most likely to get wrong, because
		// it works perfectly for a reader that attached first. A client that
		// reconnects mid-run would silently miss everything before it reattached
		// and have no way to tell that from a quiet run.
		const assertions = await assertionsFor({ noBackfill: true });
		expect(assertions.replayThenLive).toBe("fail");
	});

	it("multiReaderIndependence fails when readers share one cursor", async () => {
		// Two readers sharing a cursor means each frame reaches exactly one of
		// them. Both would see a plausible-looking partial stream, and neither
		// would see a gap it could report.
		const assertions = await assertionsFor({ sharedReader: true });
		expect(assertions.multiReaderIndependence).toBe("fail");
	});
});

describe("failure isolation", () => {
	it("records a failure per assertion rather than aborting the run", async () => {
		// The `try/catch` around each proof. A suite that threw on the first
		// failure would report one defect at a time, turning a broken backend
		// into a six-round fix-and-rerun cycle instead of one report.
		const assertions = await runStreamerConformance(() =>
			createMemoryStreamer({ reverseOrder: true }),
		).then((report) => report.assertions);
		expect(Object.keys(assertions)).toHaveLength(ALL_ASSERTIONS.length);
		expect(Object.values(assertions)).toContain("fail");
	});

	it("reports a fail rather than throwing when the streamer cannot be built", async () => {
		// The catch is around the whole proof, including `createStreamer()`. An
		// implementation whose constructor throws is a failing implementation,
		// not a crashing test run.
		const report = await runStreamerConformance(() => {
			throw new Error("cannot construct");
		});
		expect(Object.values(report.assertions)).toEqual(
			ALL_ASSERTIONS.map(() => "fail"),
		);
	});

	it("does not let one defective implementation report any spurious pass", async () => {
		// A wholly broken implementation must not pass anything. If it did, the
		// passing assertion would be one that cannot fail — and a check that
		// cannot fail is worse than an absent one, because it is counted.
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
