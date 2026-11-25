/**
 * The frame journal: a run's output, buffered once and replayed to each reader.
 *
 * A run writes frames as it goes; readers attach at any point, from any
 * sequence, and every one of them sees the same frames in the same order. That
 * is the whole job — and the interesting behaviour is all at the edges, where
 * a reader is slower than the writer, or attaches after the run is over, or
 * the run fails.
 *
 * **Backpressure sheds, it does not buffer.** The buffer exists so a reader
 * that attaches late can catch up. If the writer were allowed to run
 * arbitrarily far ahead of the slowest reader, that buffer would grow without
 * bound — one stalled log tail turning into an out-of-memory kill of the
 * process running the build. So a write that would push the writer
 * `bufferLimit` frames past the slowest reader refuses with a typed error
 * instead. The measure is deliberately the *slowest* reader, not the average:
 * shedding based on an average would let one stalled reader miss frames
 * silently.
 *
 * **With no readers there is no backpressure.** Nobody is behind, so nothing
 * is being kept for anyone — a run whose output nobody is watching must not
 * fail because of a limit that exists to protect readers.
 *
 * **Closing ends every reader, and closing twice is the same close.** Readers
 * block on a promise waiting for the next frame; if closing did not release
 * them they would hang forever on a run that already finished. And a run's
 * outcome is decided once — a second `close` returning a different result
 * would let a late caller overwrite how the run is recorded.
 *
 * **A failed run rejects `done`.** Callers await `done` to find out how the
 * run went; resolving it on failure would make a failed build look successful
 * to everyone who did not separately inspect the status.
 */
import {
	DEFAULT_STREAM_NAME,
	parseRunId,
	parseSeq,
	StreamerBackpressureError,
	StreamerClosedError,
	type StreamerRunResult,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createFrameJournal, foldLifecycleStatus } from "../../src/index.js";
// Not re-exported from the package index — a reader default is an internal
// concern of the journal, not part of the runtime's public surface.
import { defaultFromSeq } from "../../src/streamer/frame-journal.js";

const RUN = parseRunId("01JQZX000000000000000RUN1");
const OPENED_AT = "2026-06-26T00:00:00.000Z";

function journalFor(bufferLimit = 8) {
	return createFrameJournal<string>({
		runId: RUN,
		bufferLimit,
		openedAt: OPENED_AT,
	});
}

const result = (
	status: "succeeded" | "failed" | "cancelled",
	reason = "done",
): StreamerRunResult => ({ run_id: RUN, runId: RUN, status, reason });

/** Take `count` frames from a reader attached at `fromSeq`. */
async function take(
	journal: ReturnType<typeof journalFor>,
	fromSeq: number,
	count: number,
) {
	const seen: string[] = [];
	for await (const frame of journal.attachReader(parseSeq(fromSeq))) {
		// SAFETY: the journal is constructed with a string chunk type.
		seen.push(frame.chunk as string);
		if (seen.length === count) break;
	}
	return seen;
}

describe("writing and reading", () => {
	it("numbers frames from one", () => {
		// Readers attach by sequence, so the first frame's number is part of
		// the contract rather than an implementation detail.
		const journal = journalFor();
		expect(journal.write(DEFAULT_STREAM_NAME, "a").seq).toBe(1);
		expect(journal.write(DEFAULT_STREAM_NAME, "b").seq).toBe(2);
	});

	it("replays frames written before a reader attached", async () => {
		// The buffer's purpose: attaching late must not mean missing the start
		// of the run's output.
		const journal = journalFor();
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		expect(await take(journal, 1, 2)).toStrictEqual(["a", "b"]);
	});

	it("starts a reader at the sequence it asked for", async () => {
		// A reader resuming from a checkpoint asks for the frame after the last
		// one it processed; replaying from the start would duplicate work.
		const journal = journalFor();
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		expect(await take(journal, 2, 1)).toStrictEqual(["b"]);
	});

	it("gives every reader the same frames", async () => {
		// One buffer, many readers. A reader that consumed a frame out of the
		// buffer would starve the others.
		const journal = journalFor();
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		const [first, second] = await Promise.all([
			take(journal, 1, 2),
			take(journal, 1, 2),
		]);
		expect(second).toStrictEqual(first);
	});

	it("delivers a frame written while a reader was waiting", async () => {
		// The live case: the reader is blocked on an empty buffer and the write
		// has to wake it, not merely land in the array.
		const journal = journalFor();
		const pending = take(journal, 1, 1);
		journal.write(DEFAULT_STREAM_NAME, "live");
		expect(await pending).toStrictEqual(["live"]);
	});

	it("keeps a waiting reader in order across several writes", async () => {
		const journal = journalFor();
		const pending = take(journal, 1, 3);
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		journal.write(DEFAULT_STREAM_NAME, "c");
		expect(await pending).toStrictEqual(["a", "b", "c"]);
	});

	it("carries the run id onto every frame", () => {
		const journal = journalFor();
		expect(journal.write(DEFAULT_STREAM_NAME, "a").run_id).toBe(RUN);
	});

	it("carries the stream name onto the frame", () => {
		// stdout and stderr are separate streams in one journal; losing the
		// name would merge them irreversibly.
		const journal = journalFor();
		expect(journal.write(DEFAULT_STREAM_NAME, "a").stream).toBe(
			DEFAULT_STREAM_NAME,
		);
	});
});

describe("backpressure", () => {
	it("refuses a write that would outrun the slowest reader", () => {
		// An unbounded buffer turns one stalled log tail into an out-of-memory
		// kill of the process running the build.
		const journal = journalFor(2);
		journal.attachReader(parseSeq(1));
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		expect(() => journal.write(DEFAULT_STREAM_NAME, "c")).toThrow(
			StreamerBackpressureError,
		);
	});

	it("names the limit it hit", () => {
		// An operator tuning the buffer needs to know which limit refused, not
		// merely that one did.
		const journal = journalFor(2);
		journal.attachReader(parseSeq(1));
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		try {
			journal.write(DEFAULT_STREAM_NAME, "c");
			expect.unreachable("write should have shed");
		} catch (error) {
			if (!(error instanceof StreamerBackpressureError)) throw error;
			expect(error.message).toMatch(/2/);
		}
	});

	it("does not shed when nobody is reading", () => {
		// Nothing is being kept for anyone. A run whose output nobody is
		// watching must not fail because of a limit that protects readers.
		const journal = journalFor(2);
		for (const chunk of ["a", "b", "c", "d", "e"]) {
			journal.write(DEFAULT_STREAM_NAME, chunk);
		}
		expect(journal.write(DEFAULT_STREAM_NAME, "f").seq).toBe(6);
	});

	it("measures the slowest reader, not the fastest", async () => {
		// Shedding against the fastest — or an average — would let a stalled
		// reader silently miss frames, which is the failure the buffer exists
		// to prevent. Here one reader stays at frame 1 while another advances;
		// the limit is judged against the one that never moved.
		const journal = journalFor(3);
		journal.attachReader(parseSeq(1));
		journal.write(DEFAULT_STREAM_NAME, "a");
		await take(journal, 1, 1);
		journal.write(DEFAULT_STREAM_NAME, "b");
		journal.write(DEFAULT_STREAM_NAME, "c");
		expect(() => journal.write(DEFAULT_STREAM_NAME, "d")).toThrow(
			StreamerBackpressureError,
		);
	});

	it("accepts writes again once the slow reader catches up", async () => {
		// Shedding is a stall signal, not a terminal state; a journal that
		// stayed shut would end the run over a momentarily slow reader.
		const journal = journalFor(2);
		const reader = journal.attachReader(parseSeq(1));
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		expect(() => journal.write(DEFAULT_STREAM_NAME, "c")).toThrow();
		const iterator = reader[Symbol.asyncIterator]();
		await iterator.next();
		await iterator.next();
		expect(journal.write(DEFAULT_STREAM_NAME, "c").seq).toBe(3);
	});
});

describe("closing", () => {
	it("refuses a write after close", () => {
		// The run is over. A frame accepted afterwards would never reach a
		// reader, because closing already released them all.
		const journal = journalFor();
		journal.close(result("succeeded"));
		expect(() => journal.write(DEFAULT_STREAM_NAME, "a")).toThrow(
			StreamerClosedError,
		);
	});

	it("returns the first result on a second close", async () => {
		// A run's outcome is decided once. A second close overwriting it would
		// let a late caller change how the run is recorded.
		const journal = journalFor();
		const first = journal.close(result("succeeded", "all good"));
		expect(journal.close(result("failed", "actually no"))).toBe(first);
		await expect(journal.done).resolves.toBe(first);
	});

	it("records only one closed lifecycle event", () => {
		const journal = journalFor();
		journal.close(result("succeeded"));
		journal.close(result("failed"));
		expect(
			journal.lifecycleEvents.filter((e) => e.kind === "closed"),
		).toHaveLength(1);
	});

	it("ends a reader that was waiting for a frame", async () => {
		// Readers block on a promise. If closing did not release them they
		// would hang forever on a run that already finished.
		const journal = journalFor();
		const iterator = journal.attachReader(parseSeq(1))[Symbol.asyncIterator]();
		const pending = iterator.next();
		journal.close(result("succeeded"));
		expect(await pending).toStrictEqual({ value: undefined, done: true });
	});

	it("ends a reader that attaches after close", async () => {
		// A reader arriving after the run is over drains the buffer and then
		// stops, rather than waiting for frames that will never come.
		const journal = journalFor();
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.close(result("succeeded"));
		const seen: unknown[] = [];
		for await (const frame of journal.attachReader(parseSeq(1))) {
			seen.push(frame.chunk);
		}
		expect(seen).toStrictEqual(["a"]);
	});

	it("resolves done with the result on success", async () => {
		const journal = journalFor();
		const outcome = result("succeeded", "all good");
		journal.close(outcome);
		await expect(journal.done).resolves.toBe(outcome);
	});

	it("rejects done on a failed run", async () => {
		// Callers await `done` to find out how the run went. Resolving on
		// failure would make a failed build look successful to everyone who
		// did not separately inspect the status.
		const journal = journalFor();
		const settled = journal.done.catch((error: Error) => error);
		journal.close(result("failed", "compiler exploded"));
		expect((await settled).message).toMatch(/compiler exploded/);
	});

	it("allows frame-only readers and late completion waiters on a failed run", async () => {
		const journal = journalFor();
		journal.write(DEFAULT_STREAM_NAME, "compiler output");
		journal.close(result("failed", "compiler exploded"));
		const chunks: unknown[] = [];
		for await (const frame of journal.attachReader(parseSeq(1))) {
			chunks.push(frame.chunk);
		}
		// Completion is a separate optional channel. Draining output must not
		// cause an unhandled rejection before a caller chooses to await it.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(chunks).toEqual(["compiler output"]);
		await expect(journal.done).rejects.toThrow("compiler exploded");
		// The original promise stays rejected for every explicit waiter.
		await expect(journal.done).rejects.toThrow("compiler exploded");
	});

	it("resolves done on a cancelled run", async () => {
		// Cancellation is an outcome, not an error: the caller asked for it,
		// so there is nothing to throw at them.
		const journal = journalFor();
		journal.close(result("cancelled", "user stopped it"));
		await expect(journal.done).resolves.toMatchObject({ status: "cancelled" });
	});
});

describe("the lifecycle log", () => {
	it("opens with an opened event", () => {
		expect(journalFor().lifecycleEvents).toStrictEqual([
			{ kind: "opened", runId: RUN, openedAt: OPENED_AT },
		]);
	});

	it("appends a closed event carrying the status and reason", async () => {
		const journal = journalFor();
		journal.close(result("failed", "compiler exploded"));
		await expect(journal.done).rejects.toThrow("compiler exploded");
		expect(journal.lifecycleEvents[1]).toMatchObject({
			kind: "closed",
			status: "failed",
			reason: "compiler exploded",
		});
	});

	it("folds an open run to open", () => {
		expect(foldLifecycleStatus(journalFor().lifecycleEvents)).toBe("open");
	});

	it("folds a closed run to its status", () => {
		const journal = journalFor();
		journal.close(result("succeeded"));
		expect(foldLifecycleStatus(journal.lifecycleEvents)).toBe("succeeded");
	});

	it("folds an empty log to open", () => {
		// Nothing has happened yet, which is not the same as a run that
		// finished with an unknown outcome.
		expect(foldLifecycleStatus([])).toBe("open");
	});

	it("refuses a close with no open before it", () => {
		// A truncated or reordered log. Reporting a status from it would state
		// an outcome for a run there is no evidence ever started.
		expect(() =>
			foldLifecycleStatus([
				{
					kind: "closed",
					runId: RUN,
					status: "succeeded",
					reason: "done",
					closedAt: OPENED_AT,
				},
			]),
		).toThrow(/closed before opened/);
	});

	it("takes the last status when a run reopens", () => {
		// Re-running under the same id: the latest close is the current
		// outcome, and the earlier one is history.
		expect(
			foldLifecycleStatus([
				{ kind: "opened", runId: RUN, openedAt: OPENED_AT },
				{
					kind: "closed",
					runId: RUN,
					status: "failed",
					reason: "first try",
					closedAt: OPENED_AT,
				},
				{ kind: "opened", runId: RUN, openedAt: OPENED_AT },
				{
					kind: "closed",
					runId: RUN,
					status: "succeeded",
					reason: "retry",
					closedAt: OPENED_AT,
				},
			]),
		).toBe("succeeded");
	});

	it("reports a reopened run as open again", () => {
		expect(
			foldLifecycleStatus([
				{ kind: "opened", runId: RUN, openedAt: OPENED_AT },
				{
					kind: "closed",
					runId: RUN,
					status: "failed",
					reason: "first try",
					closedAt: OPENED_AT,
				},
				{ kind: "opened", runId: RUN, openedAt: OPENED_AT },
			]),
		).toBe("open");
	});
});

describe("defaultFromSeq", () => {
	it("starts at one when no sequence is given", () => {
		// A reader that did not name a checkpoint wants the whole run, not the
		// tail from wherever the writer happens to be.
		expect(defaultFromSeq()).toBe(parseSeq(1));
	});

	it("keeps an explicit sequence", () => {
		expect(defaultFromSeq(parseSeq(7))).toBe(parseSeq(7));
	});
});
