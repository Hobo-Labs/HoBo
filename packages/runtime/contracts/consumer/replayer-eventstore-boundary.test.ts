import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { nextEnvelope, recordEffect } from "../../src/replay/recorder.js";
import {
	createEventStoreReader,
	createInMemoryEventStore,
} from "../../src/replay/store.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/replayer_eventstore.pact.json"),
		"utf8",
	),
);

describe("replayer EventStore consumer boundary", () => {
	it("reads a run stream matching consumer pact expectations", async () => {
		const memory = createInMemoryEventStore();
		await recordEffect(memory, nextEnvelope("run/run-1", 1, "run.Started", {}));

		const events = await memory.readStream("run/run-1");
		const interaction = pact.interactions[0];

		expect(events[0]?.streamId).toBe(
			interaction.response.body.events[0].streamId,
		);
		expect(events[0]?.seq).toBe(interaction.response.body.events[0].seq);
		expect(events[0]?.type).toBe(interaction.response.body.events[0].type);
	});

	it("reads a single event by seq matching consumer pact expectations", async () => {
		const memory = createInMemoryEventStore();
		await recordEffect(memory, nextEnvelope("run/run-1", 1, "run.Started", {}));

		const event = await memory.readBySeq("run/run-1", 1);
		const interaction = pact.interactions[1];

		expect(event?.streamId).toBe(interaction.response.body.streamId);
		expect(event?.seq).toBe(interaction.response.body.seq);
		expect(event?.type).toBe(interaction.response.body.type);
	});

	it("adapts @hobo/core EventStore read port through createEventStoreReader", async () => {
		const memory = createInMemoryEventStore();
		await recordEffect(
			memory,
			nextEnvelope("run/run-1", 1, "run.Started", { seed: "seed" }),
		);

		const reader = createEventStoreReader({
			read(streamId, fromSeq) {
				return (async function* () {
					const events = await memory.readStream(streamId);
					for (const event of events) {
						if (fromSeq === undefined || event.seq >= fromSeq) {
							yield {
								id: event.id,
								type: event.type,
								v: event.v ?? 1,
								streamId: event.streamId,
								seq: event.seq,
								ts: event.ts ?? "2026-01-01T00:00:00.000Z",
								actor: { kind: "system" as const, id: "replay-test" },
								tenant: "tenant-test",
								data: event.data,
								meta: event.meta,
							};
						}
					}
				})();
			},
			append: async () => {
				throw new Error("not implemented");
			},
			subscribe: () => ({ unsubscribe() {} }),
			snapshot: async () => {
				throw new Error("not implemented");
			},
		});

		const events = await reader.readStream("run/run-1");
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("run.Started");
	});
});
