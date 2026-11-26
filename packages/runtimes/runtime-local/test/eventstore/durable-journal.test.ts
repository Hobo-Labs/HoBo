import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingFenceError, StaleFenceError } from "@hobo/core";
import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "../../src/index.js";

function storeForTest() {
	const dataDir = mkdtempSync(join(tmpdir(), "hobo-durable-"));
	const clock = createManualClock("2026-07-27T00:00:00.000Z");
	const store = createRuntimeLocalEventStore({ dataDir, clock });
	return { store, dataDir, clock };
}

describe("durable journal integration", () => {
	it("supports positioned readAll and atomic effects", async () => {
		const { store, dataDir } = storeForTest();
		try {
			const result = await store.commit({
				streamId: "order:atomic",
				events: [{ type: "order.Placed", data: { sku: "a" } }],
				append: {
					expectedSeq: 0,
					actor: { kind: "system", id: "test" },
					tenant: "t",
				},
				effects: [
					{
						kind: "queue",
						queueName: "orders",
						idempotencyKey: "q-1",
						body: { ok: true },
					},
					{
						kind: "outbox",
						destination: "http:hook",
						idempotencyKey: "o-1",
						payload: { n: 1 },
					},
				],
			});
			expect(result.appended).toHaveLength(1);
			expect(result.firstPosition).toBe(1n);
			expect(result.effects).toHaveLength(2);

			const positions: bigint[] = [];
			for await (const pe of store.readAll()) {
				positions.push(pe.position);
			}
			expect(positions).toEqual([1n]);
		} finally {
			store.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("enforces fencing and rejects unfenced after fenced mode", async () => {
		const { store, dataDir } = storeForTest();
		try {
			await store.append("actor:x", [{ type: "actor.Opened", data: {} }], {
				expectedSeq: 0,
				actor: { kind: "system", id: "test" },
				tenant: "t",
				fenceToken: 2n,
			});

			await expect(
				store.append("actor:x", [{ type: "actor.Stale", data: {} }], {
					expectedSeq: 1,
					actor: { kind: "system", id: "test" },
					tenant: "t",
					fenceToken: 1n,
				}),
			).rejects.toBeInstanceOf(StaleFenceError);

			await expect(
				store.append("actor:x", [{ type: "actor.Unfenced", data: {} }], {
					expectedSeq: 1,
					actor: { kind: "system", id: "test" },
					tenant: "t",
				}),
			).rejects.toBeInstanceOf(MissingFenceError);
		} finally {
			store.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("durable subscription resumes from checkpoint", async () => {
		const { store, dataDir } = storeForTest();
		try {
			await store.append(
				"s",
				[
					{ type: "a.A", data: {} },
					{ type: "a.B", data: {} },
				],
				{
					expectedSeq: 0,
					actor: { kind: "system", id: "test" },
					tenant: "t",
				},
			);
			const claimSubscription = must(
				store.claimSubscription,
				"store.claimSubscription",
			);
			const lease = await claimSubscription({
				subscriptionId: "proj",
				partitionId: "default",
				holderId: "w1",
			});
			const commitCheckpoint = must(
				store.commitCheckpoint,
				"store.commitCheckpoint",
			);
			await commitCheckpoint({
				subscriptionId: "proj",
				partitionId: "default",
				position: 1n,
				fenceToken: lease.fenceToken,
			});
			const loadCheckpoint = must(store.loadCheckpoint, "store.loadCheckpoint");
			const cp = await loadCheckpoint({
				subscriptionId: "proj",
				partitionId: "default",
			});
			expect(cp?.position).toBe(1n);

			const remaining: number[] = [];
			for await (const pe of store.readAll({
				after: must(cp, "cp").position,
			})) {
				remaining.push(pe.event.seq);
			}
			expect(remaining).toEqual([2]);
		} finally {
			store.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
