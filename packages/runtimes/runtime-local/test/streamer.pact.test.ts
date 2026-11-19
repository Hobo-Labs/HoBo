import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseRunId,
	parseStreamName,
	StreamerBackpressureError,
	StreamerClosedError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createLocalStreamer } from "../src/streamer/local-streamer.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"streamer-port.pact.json",
);

describe("streamer-port pact", () => {
	it("satisfies hobo-logs-cli consumer interactions against runtime-local Streamer", async () => {
		const pact = JSON.parse(readFileSync(pactPath, "utf8"));

		expect(pact.consumer.name).toBe("hobo-logs-cli");
		expect(pact.provider.name).toBe("@hobo/runtime-local");

		const streamer = createLocalStreamer({
			bufferLimit: 2,
			runIdPrefix: "run",
		});
		const runId = parseRunId("run:logs-follow");
		const run = streamer.createRun({ runId });
		const logs = run.getWritable(parseStreamName("logs"));
		await logs.write({ line: "boot" });

		const attached = streamer.getRun(runId);
		const frames = [];
		for await (const frame of attached.read()) {
			frames.push(frame);
			break;
		}

		expect(frames[0]).toMatchObject({
			runId: "run:logs-follow",
			seq: 1,
			stream: "logs",
			chunk: { line: "boot" },
		});

		const backpressureRunId = parseRunId("run:backpressure");
		const backpressureRun = streamer.createRun({ runId: backpressureRunId });
		const stdout = backpressureRun.getWritable(parseStreamName("stdout"));
		backpressureRun.readable[Symbol.asyncIterator]();

		await stdout.write("one");
		await stdout.write("two");
		try {
			await stdout.write("overflow");
			throw new Error("expected backpressure");
		} catch (error) {
			expect(error).toBeInstanceOf(StreamerBackpressureError);
			expect((error as StreamerBackpressureError).code).toBe(
				"STREAMER_BACKPRESSURE",
			);
			expect((error as StreamerBackpressureError).runId).toBe(
				backpressureRunId,
			);
			expect((error as StreamerBackpressureError).bufferLimit).toBe(2);
		}

		const closedRunId = parseRunId("run:closed");
		const closedRun = streamer.createRun({ runId: closedRunId });
		const closedStdout = closedRun.getWritable(parseStreamName("stdout"));
		await closedStdout.write("before");
		streamer.teardownRun(closedRunId);

		try {
			await closedStdout.write("late");
			throw new Error("expected closed");
		} catch (error) {
			expect(error).toBeInstanceOf(StreamerClosedError);
			expect((error as StreamerClosedError).code).toBe("STREAMER_CLOSED");
			expect((error as StreamerClosedError).runId).toBe(closedRunId);
		}
	});
});
