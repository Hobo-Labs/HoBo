import { runStreamerConformance } from "@hobo/conformance";
import {
	parseRunId,
	parseSeq,
	parseStreamName,
	StreamerBackpressureError,
	StreamerClosedError,
	StreamerHistoryExpiredError,
	StreamerParseError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createLocalStreamer } from "../src/streamer/local-streamer.js";

describe("createLocalStreamer", () => {
	it("rejects duplicate runId on createRun", () => {
		const streamer = createLocalStreamer();
		const runId = parseRunId("run:dup");
		streamer.createRun({ runId });
		expect(() => streamer.createRun({ runId })).toThrow(/already exists/);
	});

	it("skips active explicit IDs when generating an ID", () => {
		const streamer = createLocalStreamer();
		streamer.createRun({ runId: parseRunId("run-1") });
		const run = streamer.createRun();
		expect(run.runId).toBe("run-2");
		streamer.teardownRun(parseRunId("run-1"));
		streamer.teardownRun(run.runId);
	});

	it("starts workflows asynchronously and closes their streams on completion", async () => {
		const streamer = createLocalStreamer();
		let started = false;
		const run = streamer.start<string>(async ({ runId, getWritable }) => {
			started = true;
			expect(runId).toBe("run-1");
			await getWritable(parseStreamName("output")).write("one");
			await getWritable(parseStreamName("output")).write("two");
		});
		expect(started).toBe(false);
		const frames = [];
		for await (const frame of run.readable) frames.push(frame);
		expect(frames.map(({ chunk }) => chunk)).toEqual(["one", "two"]);
		expect(await run.done).toEqual({
			runId: run.runId,
			status: "completed",
			reason: "workflow completed",
		});
		expect(() => streamer.getRun(run.runId)).toThrow(/unknown streamer run/);
	});

	it("drains frames and rejects completion when a workflow fails", async () => {
		const streamer = createLocalStreamer();
		const run = streamer.start<string>(async ({ getWritable }) => {
			await getWritable().write("before failure");
			throw new Error("workflow broke");
		});
		const completion = expect(run.done).rejects.toThrow("workflow broke");
		const frames = [];
		for await (const frame of run.readable) frames.push(frame);
		expect(frames.map(({ chunk }) => chunk)).toEqual(["before failure"]);
		await completion;
		expect(() => streamer.getRun(run.runId)).toThrow(/unknown streamer run/);
	});

	it("settles failed workflows even when the thrown value cannot be converted", async () => {
		const streamer = createLocalStreamer();
		const run = streamer.start(() => {
			throw {
				toString: () => {
					throw new Error("cannot convert");
				},
			};
		});
		await expect(run.done).rejects.toThrow("workflow failed");
	});

	it("does not let a torn-down workflow remove a replacement run", async () => {
		const streamer = createLocalStreamer();
		const runId = parseRunId("run:reused");
		let markStarted = () => {};
		let release = () => {};
		let markEnded = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ended = new Promise<void>((resolve) => {
			markEnded = resolve;
		});
		const run = streamer.start<string>(
			async ({ getWritable }) => {
				markStarted();
				await gate;
				try {
					await getWritable().write("late");
				} finally {
					markEnded();
				}
			},
			{ runId },
		);
		await started;
		expect(streamer.teardownRun(runId).status).toBe("closed");
		const replacement = streamer.createRun({ runId });
		release();
		await ended;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(streamer.getRun(runId).runId).toBe(replacement.runId);
		expect((await run.done).status).toBe("closed");
		streamer.teardownRun(runId);
	});

	it("validates the workflow and explicit run ID before starting", () => {
		const streamer = createLocalStreamer();
		expect(() => streamer.start("invalid" as never)).toThrow(/workflow/);
		expect(() => streamer.createRun({ runId: " " as never })).toThrow(
			StreamerParseError,
		);
		expect(streamer.createRun().runId).toBe("run-1");
	});

	it("throws on unknown runId for getRun and teardownRun", () => {
		const streamer = createLocalStreamer();
		const missing = parseRunId("run:missing");
		expect(() => streamer.getRun(missing)).toThrow(/unknown streamer run/);
		expect(() => streamer.teardownRun(missing)).toThrow(/unknown streamer run/);
	});

	it("rejects empty-string inputs at parser boundaries", () => {
		expect(() => parseRunId("   ")).toThrow(StreamerParseError);
		expect(() => parseStreamName("")).toThrow(StreamerParseError);
		expect(() => parseSeq(0)).toThrow(StreamerParseError);
	});

	it("rejects writes after teardown while draining buffered frames", async () => {
		const streamer = createLocalStreamer();
		const runId = parseRunId("run:drain");
		const run = streamer.createRun({ runId });
		const stdout = run.getWritable(parseStreamName("stdout"));

		await stdout.write("keep");
		streamer.teardownRun(runId);
		await expect(stdout.write("late")).rejects.toBeInstanceOf(
			StreamerClosedError,
		);

		const chunks = [];
		for await (const frame of run.readable) {
			chunks.push(frame.chunk);
		}
		expect(chunks).toEqual(["keep"]);
	});

	it("applies bounded backpressure against the slowest attached reader", async () => {
		const streamer = createLocalStreamer({ bufferLimit: 2 });
		const runId = parseRunId("run:slow");
		const run = streamer.createRun({ runId });
		const stdout = run.getWritable(parseStreamName("stdout"));
		run.readable[Symbol.asyncIterator]();

		await stdout.write("one");
		await stdout.write("two");
		await expect(stdout.write("three")).rejects.toBeInstanceOf(
			StreamerBackpressureError,
		);
		streamer.teardownRun(runId);
	});

	it("does not attach readers until their iteration starts", async () => {
		const streamer = createLocalStreamer({ bufferLimit: 1 });
		const runId = parseRunId("run:lazy-readers");
		const run = streamer.createRun<string>({ runId });
		streamer.getRun(runId);
		run.read({ fromSeq: parseSeq(1) });
		const writer = run.getWritable();
		await writer.write("one");
		await writer.write("two");
		expect(() => run.readable[Symbol.asyncIterator]()).toThrow(
			StreamerHistoryExpiredError,
		);
		const reader = run.read({ fromSeq: parseSeq(2) })[Symbol.asyncIterator]();
		expect((await reader.next()).value?.chunk).toBe("two");
		await reader.return?.();
		streamer.teardownRun(runId);
	});

	it("releases backpressure when a reader stops early", async () => {
		const streamer = createLocalStreamer({ bufferLimit: 1 });
		const runId = parseRunId("run:reader-stop");
		const run = streamer.createRun<string>({ runId });
		const writer = run.getWritable();
		const reader = run.readable[Symbol.asyncIterator]();
		await writer.write("one");
		await expect(writer.write("two")).rejects.toBeInstanceOf(
			StreamerBackpressureError,
		);
		await reader.return?.();
		await expect(writer.write("two")).resolves.toBeUndefined();
		streamer.teardownRun(runId);
	});

	it("settles a pending read when its iterator is closed", async () => {
		const streamer = createLocalStreamer();
		const runId = parseRunId("run:reader-pending");
		const run = streamer.createRun({ runId });
		const reader = run.readable[Symbol.asyncIterator]();
		const pending = reader.next();
		await reader.return?.();
		expect(await pending).toEqual({ done: true, value: undefined });
		streamer.teardownRun(runId);
	});

	it("delivers consecutive writes to concurrent pending reads", async () => {
		const streamer = createLocalStreamer({ bufferLimit: 1 });
		const runId = parseRunId("run:concurrent-reads");
		const run = streamer.createRun<string>({ runId });
		const reader = run.readable[Symbol.asyncIterator]();
		const reads = Promise.all([reader.next(), reader.next()]);
		const writer = run.getWritable();
		try {
			await Promise.all([writer.write("one"), writer.write("two")]);
			expect((await reads).map((item) => item.value?.chunk)).toEqual([
				"one",
				"two",
			]);
		} finally {
			streamer.teardownRun(runId);
		}
	});

	it("passes the Streamer conformance assertions", async () => {
		const report = await runStreamerConformance(() =>
			createLocalStreamer({ runIdPrefix: "run:conf", bufferLimit: 32 }),
		);

		for (const [name, status] of Object.entries(report.assertions)) {
			expect(status, name).toBe("pass");
		}
	});
});
