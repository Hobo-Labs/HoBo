import {
	DEFAULT_STREAM_NAME,
	parseRunId,
	parseSeq,
	StreamerBackpressureError,
	StreamerClosedError,
	type StreamerRunResult,
} from "@hobo/core";
import { describe, expect, it, vi } from "vitest";

import { createFrameJournal, foldLifecycleStatus } from "../../src/index.js";
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
	status: "completed" | "failed" | "closed",
	reason = "done",
): StreamerRunResult => ({ run_id: RUN, runId: RUN, status, reason });

async function take(
	journal: ReturnType<typeof journalFor>,
	fromSeq: number,
	count: number,
) {
	const seen: string[] = [];
	for await (const frame of journal.attachReader(parseSeq(fromSeq))) {
		seen.push(frame.chunk);
		if (seen.length === count) break;
	}
	return seen;
}

describe("writing and reading", () => {
	it("numbers frames from one", () => {
		const journal = journalFor();
		expect(journal.write(DEFAULT_STREAM_NAME, "a").seq).toBe(1);
		expect(journal.write(DEFAULT_STREAM_NAME, "b").seq).toBe(2);
	});

	it("replays frames written before a reader attached", async () => {
		const journal = journalFor();
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		expect(await take(journal, 1, 2)).toStrictEqual(["a", "b"]);
	});

	it("starts a reader at the sequence it asked for", async () => {
		const journal = journalFor();
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		expect(await take(journal, 2, 1)).toStrictEqual(["b"]);
	});

	it("gives every reader the same frames", async () => {
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

	it("settles concurrent pending reads when consecutive frames arrive", async () => {
		const journal = journalFor();
		const reader = journal.attachReader(parseSeq(1))[Symbol.asyncIterator]();
		const delivered: (string | undefined)[] = [];
		const first = reader
			.next()
			.then((item) => delivered.push(item.value?.chunk));
		const second = reader
			.next()
			.then((item) => delivered.push(item.value?.chunk));
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		try {
			await vi.waitFor(() => expect(delivered).toEqual(["a", "b"]), {
				timeout: 1_000,
				interval: 25,
			});
			await Promise.all([first, second]);
		} finally {
			journal.close(result("closed"));
		}
	});

	it("carries the run id onto every frame", () => {
		const journal = journalFor();
		expect(journal.write(DEFAULT_STREAM_NAME, "a").run_id).toBe(RUN);
	});

	it("carries the stream name onto the frame", () => {
		const journal = journalFor();
		expect(journal.write(DEFAULT_STREAM_NAME, "a").stream).toBe(
			DEFAULT_STREAM_NAME,
		);
	});
});

describe("backpressure", () => {
	it("refuses a write that would outrun the slowest reader", () => {
		const journal = journalFor(2);
		journal.attachReader(parseSeq(1));
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.write(DEFAULT_STREAM_NAME, "b");
		expect(() => journal.write(DEFAULT_STREAM_NAME, "c")).toThrow(
			StreamerBackpressureError,
		);
	});

	it("names the limit it hit", () => {
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
		const journal = journalFor(2);
		for (const chunk of ["a", "b", "c", "d", "e"]) {
			journal.write(DEFAULT_STREAM_NAME, chunk);
		}
		expect(journal.write(DEFAULT_STREAM_NAME, "f").seq).toBe(6);
	});

	it("measures the slowest reader, not the fastest", async () => {
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
		const journal = journalFor();
		journal.close(result("completed"));
		expect(() => journal.write(DEFAULT_STREAM_NAME, "a")).toThrow(
			StreamerClosedError,
		);
	});

	it("returns the first result on a second close", async () => {
		const journal = journalFor();
		const first = journal.close(result("completed", "all good"));
		expect(journal.close(result("failed", "actually no"))).toBe(first);
		await expect(journal.done).resolves.toBe(first);
	});

	it("records only one closed lifecycle event", () => {
		const journal = journalFor();
		journal.close(result("completed"));
		journal.close(result("failed"));
		expect(
			journal.lifecycleEvents.filter((e) => e.kind === "closed"),
		).toHaveLength(1);
	});

	it("ends a reader that was waiting for a frame", async () => {
		const journal = journalFor();
		const iterator = journal.attachReader(parseSeq(1))[Symbol.asyncIterator]();
		const pending = iterator.next();
		journal.close(result("completed"));
		expect(await pending).toStrictEqual({ value: undefined, done: true });
	});

	it("ends a reader that attaches after close", async () => {
		const journal = journalFor();
		journal.write(DEFAULT_STREAM_NAME, "a");
		journal.close(result("completed"));
		const seen: unknown[] = [];
		for await (const frame of journal.attachReader(parseSeq(1))) {
			seen.push(frame.chunk);
		}
		expect(seen).toStrictEqual(["a"]);
	});

	it("resolves done with the result on success", async () => {
		const journal = journalFor();
		const outcome = result("completed", "all good");
		journal.close(outcome);
		await expect(journal.done).resolves.toBe(outcome);
	});

	it("rejects done on a failed run", async () => {
		const journal = journalFor();
		const settled = expect(journal.done).rejects.toThrow("compiler exploded");
		journal.close(result("failed", "compiler exploded"));
		await settled;
	});

	it("allows frame-only readers and late completion waiters on a failed run", async () => {
		const journal = journalFor();
		journal.write(DEFAULT_STREAM_NAME, "compiler output");
		journal.close(result("failed", "compiler exploded"));
		const chunks: unknown[] = [];
		for await (const frame of journal.attachReader(parseSeq(1))) {
			chunks.push(frame.chunk);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(chunks).toEqual(["compiler output"]);
		await expect(journal.done).rejects.toThrow("compiler exploded");
		await expect(journal.done).rejects.toThrow("compiler exploded");
	});

	it("resolves done on a closed run", async () => {
		const journal = journalFor();
		journal.close(result("closed", "user stopped it"));
		await expect(journal.done).resolves.toMatchObject({ status: "closed" });
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
		journal.close(result("completed"));
		expect(foldLifecycleStatus(journal.lifecycleEvents)).toBe("completed");
	});

	it("folds an empty log to open", () => {
		expect(foldLifecycleStatus([])).toBe("open");
	});

	it("refuses a close with no open before it", () => {
		expect(() =>
			foldLifecycleStatus([
				{
					kind: "closed",
					runId: RUN,
					status: "completed",
					reason: "done",
					closedAt: OPENED_AT,
				},
			]),
		).toThrow(/closed before opened/);
	});

	it("takes the last status when a run reopens", () => {
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
					status: "completed",
					reason: "retry",
					closedAt: OPENED_AT,
				},
			]),
		).toBe("completed");
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
		expect(defaultFromSeq()).toBe(parseSeq(1));
	});

	it("keeps an explicit sequence", () => {
		expect(defaultFromSeq(parseSeq(7))).toBe(parseSeq(7));
	});
});
