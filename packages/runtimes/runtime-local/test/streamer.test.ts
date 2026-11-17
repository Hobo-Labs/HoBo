import { runStreamerConformance } from "@hobo/conformance";
import {
	parseRunId,
	parseSeq,
	parseStreamName,
	StreamerBackpressureError,
	StreamerClosedError,
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
		const reader = run.readable[Symbol.asyncIterator]();
		expect((await reader.next()).value?.chunk).toBe("one");
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

	it("passes all seven Streamer conformance assertions", async () => {
		const report = await runStreamerConformance(() =>
			createLocalStreamer({ runIdPrefix: "run:conf", bufferLimit: 32 }),
		);

		for (const [name, status] of Object.entries(report.assertions)) {
			expect(status, name).toBe("pass");
		}
	});
});
