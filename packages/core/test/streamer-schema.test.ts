import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromJson, toJson } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import {
	StreamerFrameSchema,
	StreamerRunResultSchema,
} from "../src/_generated/streamer_port_pb.js";
import {
	createStreamerFrame,
	createStreamerRunResult,
} from "../src/ports/streamer.js";

it("round-trips current frames and run results through their schemas", () => {
	const frame = createStreamerFrame(
		{ runId: " run-1 ", seq: 1, stream: "events" },
		{ orderId: "order-1", quantities: [1, 2] },
	);
	const result = createStreamerRunResult({
		runId: " run-1 ",
		status: "closed",
		reason: "teardown",
	});
	expect(Object.keys(frame)).toEqual(["runId", "seq", "stream", "chunk"]);
	expect(Object.keys(result)).toEqual(["runId", "status", "reason"]);
	expect(
		toJson(StreamerFrameSchema, fromJson(StreamerFrameSchema, { ...frame })),
	).toEqual(frame);
	expect(
		toJson(
			StreamerRunResultSchema,
			fromJson(StreamerRunResultSchema, { ...result }),
		),
	).toEqual(result);
	const directory = mkdtempSync(join(tmpdir(), "hobo-streamer-schema-"));
	try {
		const schema = fileURLToPath(
			new URL("../data-models/streamer_port.cue", import.meta.url),
		);
		const input = join(directory, "value.json");
		for (const [definition, value] of [
			["#StreamerFrame", frame],
			["#StreamerRunResult", result],
		] as const) {
			writeFileSync(input, JSON.stringify(value));
			const checked = spawnSync(
				"cue",
				["vet", schema, input, "-d", definition],
				{ encoding: "utf8" },
			);
			expect(checked.status, checked.stderr).toBe(0);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
