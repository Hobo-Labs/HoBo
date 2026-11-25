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

	it("passes all seven Streamer conformance assertions", async () => {
		const report = await runStreamerConformance(() =>
			createLocalStreamer({ runIdPrefix: "run:conf", bufferLimit: 32 }),
		);

		for (const [name, status] of Object.entries(report.assertions)) {
			expect(status, name).toBe("pass");
		}
	});
});
