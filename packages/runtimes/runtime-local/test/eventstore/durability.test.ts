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
} from "../../src/index.js";

const crasherScript = join(
	dirname(fileURLToPath(import.meta.url)),
	"../fixtures/append-crasher.mts",
);

describe("runtime-local EventStore durability", () => {
	it("orderedReplayAfterReopen keeps contiguous seq across streams", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "hobo-es-dur-"));
		const clock = createManualClock("2026-06-26T00:00:00.000Z");
		const first = createRuntimeLocalEventStore({ dataDir, clock });
		await first.append(
			"durability:stream-a",
			[{ type: "load.Started", data: { n: 1 } }],
			appendOptions(0),
		);
		await first.append(
			"durability:stream-b",
			[{ type: "load.Started", data: { n: 2 } }],
			appendOptions(0),
		);
		first.close();

		const reopened = createRuntimeLocalEventStore({ dataDir, clock });
		const streamA = await collectStream(reopened, "durability:stream-a");
		const streamB = await collectStream(reopened, "durability:stream-b");
		expect(streamA.map((event) => event.seq)).toEqual([1]);
		expect(streamB.map((event) => event.seq)).toEqual([1]);
		reopened.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("dedupSurvivesReopen", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "hobo-es-dedup-"));
		const clock = createManualClock();
		const event = {
			type: "payment.Captured",
			data: { amount: 99 },
			meta: { idempotencyKey: "pay-1" },
		};
		const first = createRuntimeLocalEventStore({ dataDir, clock });
		await first.append("durability:pay", [event], appendOptions(0));
		first.close();

		const reopened = createRuntimeLocalEventStore({ dataDir, clock });
		const retry = await reopened.append(
			"durability:pay",
			[event],
			appendOptions(0),
		);
		expect(retry.appended).toHaveLength(0);
		expect(retry.deduped).toHaveLength(1);
		reopened.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("replayEqualsLive", async () => {
		const { store } = tempStore();
		await store.append(
			"durability:fold",
			[
				{ type: "cart.ItemAdded", data: { sku: "a" } },
				{ type: "cart.ItemAdded", data: { sku: "b" } },
			],
			appendOptions(0),
		);
		const live = await store.fold("durability:fold", {
			initialState: { items: [] as string[] },
			handlers: {
				"cart.ItemAdded": (state, event) => ({
					items: [
						...state.items,
						String((event.data as { sku?: string }).sku ?? ""),
					],
				}),
			},
		});
		const replay = await store.fold("durability:fold", {
			initialState: { items: [] as string[] },
			handlers: {
				"cart.ItemAdded": (state, event) => ({
					items: [
						...state.items,
						String((event.data as { sku?: string }).sku ?? ""),
					],
				}),
			},
		});
		expect(replay.state).toEqual(live.state);
		expect(replay.seq).toBe(live.seq);
		store.close();
	});

	it("crashMidAppendAtomicity survives SIGKILL with whole batches only", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "hobo-es-crash-"));
		const acked = await runCrasher(crasherScript, dataDir);
		const store = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock(),
		});
		const events = await collectStream(store, "durability:crash");

		for (const seq of acked) {
			expect(events.some((event) => event.seq === seq)).toBe(true);
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
			expect([0, 3]).toContain(count);
		}

		expect(events.map((event) => event.seq)).toEqual(
			[...events.keys()].map((index) => index + 1),
		);
		store.close();
		rmSync(dataDir, { recursive: true, force: true });
	}, 30_000);
});

function tempStore() {
	const dataDir = mkdtempSync(join(tmpdir(), "hobo-es-temp-"));
	return {
		store: createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock("2026-06-26T00:00:00.000Z"),
		}),
		dataDir,
	};
}

function appendOptions(expectedSeq: number) {
	return {
		expectedSeq,
		actor: { kind: "system" as const, id: "durability" },
		tenant: "durability-tenant",
	};
}

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
