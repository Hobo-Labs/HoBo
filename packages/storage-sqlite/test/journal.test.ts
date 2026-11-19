import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createMemoryNodeSqliteDriver,
	createNodeSqliteDriver,
	SqliteJournal,
} from "../src/index.js";

const clock = { now: () => "2026-07-27T12:00:00.000Z" };

function journal() {
	return new SqliteJournal(createMemoryNodeSqliteDriver(), {
		clock,
		nativePragmas: false,
	});
}

const actor = { kind: "system" as const, id: "test" };

describe("SqliteJournal", () => {
	it("uses stream heads not COUNT for revision CAS", async () => {
		const j = journal();
		await j.append("s1", [{ type: "a.A", data: {} }], {
			expectedSeq: 0,
			actor,
			tenant: "t",
		});
		await j.append("s1", [{ type: "a.B", data: {} }], {
			expectedSeq: 1,
			actor,
			tenant: "t",
		});
		expect(j.getStreamHead("s1")).toEqual({
			streamId: "s1",
			revision: 2,
			ownerEpoch: 0n,
		});
		j.close();
	});

	it("assigns contiguous positions and supports readAll", async () => {
		const j = journal();
		await j.append("a", [{ type: "x.A", data: { i: 1 } }], {
			expectedSeq: 0,
			actor,
			tenant: "t",
		});
		await j.append("b", [{ type: "x.B", data: { i: 2 } }], {
			expectedSeq: 0,
			actor,
			tenant: "t",
		});
		const all: bigint[] = [];
		for await (const pe of j.readAll()) {
			all.push(pe.position);
		}
		expect(all).toEqual([1n, 2n]);
		j.close();
	});

	it("idempotent retry returns deduped without requiring expectedSeq match", async () => {
		const j = journal();
		const event = {
			type: "pay.Captured",
			data: { amount: 10 },
			meta: { idempotencyKey: "k1" },
		};
		await j.append("pay", [event], { expectedSeq: 0, actor, tenant: "t" });
		const retry = await j.append("pay", [event], {
			expectedSeq: 0,
			actor,
			tenant: "t",
		});
		expect(retry.appended).toHaveLength(0);
		expect(retry.deduped).toHaveLength(1);
		expect(j.getStreamLength("pay")).toBe(1);
		j.close();
	});

	it("commits events + queue + outbox atomically", async () => {
		const j = journal();
		const result = await j.commit({
			streamId: "order:9",
			events: [{ type: "order.Placed", data: { sku: "x" } }],
			append: { expectedSeq: 0, actor, tenant: "t" },
			effects: [
				{
					kind: "queue",
					queueName: "orders",
					idempotencyKey: "q1",
					body: { hello: true },
				},
				{
					kind: "outbox",
					destination: "webhook:x",
					idempotencyKey: "o1",
					payload: { url: "https://example.test" },
				},
				{
					kind: "timer",
					timerKind: "sleep",
					subjectId: "run:1",
					idempotencyKey: "sleep-1",
					dueAt: "2026-07-27T13:00:00.000Z",
					payload: {},
				},
			],
		});
		expect(result.appended).toHaveLength(1);
		expect(result.effects).toHaveLength(3);
		expect(result.effects.every((e) => !e.deduped)).toBe(true);

		const leased = j.leaseMessages({
			queueName: "orders",
			maxMessages: 10,
			visibilityTimeoutMs: 5000,
			leaseId: "lease-1",
			leaseFence: 1n,
		});
		expect(leased).toHaveLength(1);
		j.close();
	});

	it("rolls back events when effect stage would violate uniqueness mid-batch is N/A; rollback on conflict", async () => {
		const j = journal();
		await j.append("s", [{ type: "a.A", data: {} }], {
			expectedSeq: 0,
			actor,
			tenant: "t",
		});
		await expect(
			j.commit({
				streamId: "s",
				events: [{ type: "a.B", data: {} }],
				append: { expectedSeq: 0, actor, tenant: "t" },
				effects: [
					{
						kind: "queue",
						queueName: "q",
						idempotencyKey: "only",
						body: {},
					},
				],
			}),
		).rejects.toMatchObject({ code: "OPTIMISTIC_SEQUENCE_CONFLICT" });

		const leased = j.leaseMessages({
			queueName: "q",
			maxMessages: 10,
			visibilityTimeoutMs: 5000,
			leaseId: "l",
			leaseFence: 1n,
		});
		expect(leased).toHaveLength(0);
		j.close();
	});

	it("durable subscription checkpoint is monotonic", async () => {
		const j = journal();
		await j.append("s", [{ type: "a.A", data: {} }], {
			expectedSeq: 0,
			actor,
			tenant: "t",
		});
		const lease = await j.claimSubscription({
			subscriptionId: "proj-1",
			partitionId: "default",
			holderId: "worker-a",
		});
		await j.commitCheckpoint({
			subscriptionId: "proj-1",
			partitionId: "default",
			position: 1n,
			fenceToken: lease.fenceToken,
		});
		await expect(
			j.commitCheckpoint({
				subscriptionId: "proj-1",
				partitionId: "default",
				position: 0n,
				fenceToken: lease.fenceToken,
			}),
		).rejects.toMatchObject({ code: "CHECKPOINT_REGRESSION" });
		j.close();
	});

	it("preserves bigint fence tokens beyond MAX_SAFE_INTEGER", async () => {
		const j = journal();
		const big = 9_007_199_254_740_993n;
		await j.append("fenced", [{ type: "a.A", data: {} }], {
			expectedSeq: 0,
			actor,
			tenant: "t",
			fenceToken: big,
		});
		expect(j.getStreamHead("fenced")?.ownerEpoch).toBe(big);
		j.close();
	});

	it("snapshot cannot advance past head", async () => {
		const j = journal();
		await expect(j.snapshot("empty", { x: 1 }, 1)).rejects.toMatchObject({
			code: "SNAPSHOT_AHEAD",
		});
		j.close();
	});
});

describe("durable journal", () => {
	it("persists on disk reopen", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sqlite-"));
		const path = join(dir, "store.sqlite");
		try {
			const j1 = new SqliteJournal(createNodeSqliteDriver({ path }), {
				clock,
			});
			await j1.append("s", [{ type: "a.A", data: { n: 1 } }], {
				expectedSeq: 0,
				actor,
				tenant: "t",
			});
			j1.close();

			const j2 = new SqliteJournal(createNodeSqliteDriver({ path }), {
				clock,
			});
			const events = [];
			for await (const e of j2.read("s")) events.push(e);
			expect(events).toHaveLength(1);
			expect(j2.getStreamLength("s")).toBe(1);
			j2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
