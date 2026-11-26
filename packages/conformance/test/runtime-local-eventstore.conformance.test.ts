import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	collectStream,
	createManualClock,
	createRuntimeLocalEventStore,
} from "../../runtimes/runtime-local/src/index.js";

import { runEventStoreConformance } from "../src/suites/eventstore.js";

const crasherScript = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../runtimes/runtime-local/test/fixtures/append-crasher.mts",
);

describe("@hobo/conformance EventStore suite", () => {
	it("reports pass for every runtime-local assertion", async () => {
		const report = await runEventStoreConformance(
			(options) =>
				createRuntimeLocalEventStore({
					dataDir:
						options?.dataDir ??
						mkdtempSync(join(tmpdir(), "hobo-es-conformance-")),
					clock: createManualClock("2026-06-26T00:00:00.000Z"),
				}),
			{
				backend: "runtime-local",
				dataDirFactory: () =>
					mkdtempSync(join(tmpdir(), "hobo-es-conformance-")),
				removeDataDir: (dir) => rmSync(dir, { recursive: true, force: true }),
				crashProbe: async (createStore, dataDir) => {
					const acked = await runCrasher(crasherScript, dataDir);
					const store = createStore({ dataDir, clock: createManualClock() });
					try {
						const events = await collectStream(store, "durability:crash");
						for (const seq of acked) {
							if (!events.some((event) => event.seq === seq)) {
								return false;
							}
						}
						const groups = new Map<string, number>();
						for (const event of events) {
							if (!event.correlationId) {
								continue;
							}
							groups.set(
								event.correlationId,
								(groups.get(event.correlationId) ?? 0) + 1,
							);
						}
						for (const count of groups.values()) {
							if (count !== 0 && count !== 3) {
								return false;
							}
						}
						return events.every((event, index) => event.seq === index + 1);
					} finally {
						store.close();
					}
				},
			},
		);

		expect(report).toEqual({
			contract: "hobo.camp-eventstore-runtime-port/v1",
			backend: "runtime-local",
			assertions: {
				seqConditionalAppend: "pass",
				idempotencyKeyDedup: "pass",
				idempotencyCollisionScopedPerStream: "pass",
				poisonEventQuarantine: "pass",
				orderedReplayAfterReopen: "pass",
				dedupSurvivesReopen: "pass",
				replayEqualsLive: "pass",
				crashMidAppendAtomicity: "pass",
			},
		});
	}, 60_000);
});

async function runCrasher(script: string, dataDir: string): Promise<number[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", script, dataDir],
			{
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
		const acked: number[] = [];
		let buffer = "";

		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const match = /^ACKED seq=(\d+)$/.exec(line.trim());
				if (match) {
					acked.push(Number(match[1]));
					if (acked.length >= 3) {
						child.kill("SIGKILL");
					}
				}
			}
		});

		child.on("error", reject);
		child.on("close", () => resolve(acked));
	});
}
