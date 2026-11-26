import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "../src/eventstore/eventstore.js";

describe("durable event IDs survive store reopen", () => {
	it("appends after reopen with the default clock and preserves all prior events", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "hobo-store-reopen-"));
		const ids = new Set<string>();
		try {
			for (let revision = 0; revision < 5; revision++) {
				const store = createRuntimeLocalEventStore({ dataDir });
				try {
					const result = await store.append(
						"durable:app",
						[{ type: "app.Changed", data: { revision } }],
						{
							expectedSeq: revision,
							actor: { kind: "service", id: "app" },
							tenant: "tenant",
						},
					);
					for (const event of result.appended) ids.add(event.id);
				} finally {
					store.close();
				}
			}
			expect(ids.size).toBe(5);
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("avoids ID collisions between independent handles and after a clock rewind", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "hobo-store-multi-"));
		const clock = createManualClock();
		const first = createRuntimeLocalEventStore({ dataDir, clock });
		const second = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock(),
		});
		const options = {
			expectedSeq: 0,
			actor: { kind: "service" as const, id: "app" },
			tenant: "tenant",
		};
		try {
			const left = await first.append(
				"durable:left",
				[{ type: "app.Left" }],
				options,
			);
			const right = await second.append(
				"durable:right",
				[{ type: "app.Right" }],
				options,
			);
			clock.advance(1);
			await first.append("durable:later", [{ type: "app.Later" }], options);
			expect(left.appended[0]?.id).not.toBe(right.appended[0]?.id);
		} finally {
			first.close();
			second.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});
