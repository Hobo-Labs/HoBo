import { afterEach, expect, it } from "vitest";
import { adminQuery, describeLive, freshSchema, T0 } from "./support/live.js";
import {
	type StoreProcess,
	startStoreProcess,
} from "./support/worker-process.js";

/**
 * Plan 0024 WP17 Accept: "Two-process fence test". Two OS processes, each
 * with its own pool and clock, contend for one Camp's lease and the Camp's
 * fenced stream (I4: one writer per Camp; a stale fence is refused).
 */
describeLive("WP17 two-process fence", () => {
	const processes: StoreProcess[] = [];
	afterEach(async () => {
		await Promise.all(processes.splice(0).map((p) => p.stop()));
	});

	function start(schema: string): StoreProcess {
		const handle = startStoreProcess(schema, T0);
		processes.push(handle);
		return handle;
	}

	it("lets exactly one of two racing processes claim the Camp lease", async () => {
		const schema = freshSchema();
		const a = start(schema);
		const b = start(schema);
		await Promise.all([a.call("ready"), b.call("ready")]);
		const key = { subscriptionId: "hobo.cd.camp", partitionId: "camp-1" };
		const [ra, rb] = await Promise.all([
			a.send("claim", { ...key, holderId: "replica-a" }),
			b.send("claim", { ...key, holderId: "replica-b" }),
		]);
		const winners = [ra, rb].filter((reply) => reply.ok);
		const losers = [ra, rb].filter((reply) => !reply.ok);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		expect(losers[0]).toMatchObject({
			code: "SUBSCRIPTION_LEASE_CONFLICT",
			failure: "lease-held",
		});
		expect(winners[0]).toMatchObject({ value: { fence: "1" } });
	});

	it("refuses the stale process's appends and checkpoints after the other takes over", async () => {
		const schema = freshSchema();
		const a = start(schema);
		const b = start(schema);
		const key = { subscriptionId: "hobo.cd.camp", partitionId: "camp-1" };
		const stream = "cd:camp:camp-1:status";

		const leaseA = await a.lease("claim", {
			...key,
			holderId: "replica-a",
			ttlMs: 30_000,
		});
		expect(leaseA.fence).toBe("1");
		await a.call("append", {
			streamId: stream,
			expectedSeq: 0,
			fence: leaseA.fence,
			holderId: "replica-a",
		});
		await a.call("checkpoint", { ...key, position: 1, fence: leaseA.fence });

		// B cannot take over a live lease ...
		expect(
			await b.send("claim", { ...key, holderId: "replica-b" }),
		).toMatchObject({
			ok: false,
			code: "SUBSCRIPTION_LEASE_CONFLICT",
		});
		// ... but can once A's lease has expired on B's clock (A is paused, not dead).
		await b.call("clock", { at: "2026-11-12T00:00:31.000Z" });
		const leaseB = await b.lease("claim", {
			...key,
			holderId: "replica-b",
			ttlMs: 30_000,
		});
		expect(leaseB.fence).toBe("2");
		await b.call("append", {
			streamId: stream,
			expectedSeq: 1,
			fence: leaseB.fence,
			holderId: "replica-b",
		});

		// A wakes up and keeps going with its old fence: every write is refused.
		expect(
			await a.send("append", {
				streamId: stream,
				expectedSeq: 2,
				fence: leaseA.fence,
				holderId: "replica-a",
			}),
		).toMatchObject({ ok: false, code: "STALE_FENCE" });
		expect(
			await a.send("append", {
				streamId: stream,
				expectedSeq: 2,
				holderId: "replica-a",
			}),
		).toMatchObject({
			ok: false,
			code: "MISSING_FENCE",
		});
		expect(
			await a.send("checkpoint", { ...key, position: 2, fence: leaseA.fence }),
		).toMatchObject({
			ok: false,
			code: "STALE_FENCE",
		});
		expect(
			await a.send("renew", {
				...key,
				holderId: "replica-a",
				fence: leaseA.fence,
			}),
		).toMatchObject({
			ok: false,
			code: "STALE_FENCE",
		});

		// Only B's write landed after the takeover, and the stream carries B's epoch.
		const rows = await adminQuery(
			`SELECT seq, data FROM "${schema}".events WHERE stream_id = $1 ORDER BY seq`,
			[stream],
		);
		expect(
			rows.map((row) => [row.seq, JSON.parse(String(row.data)).by]),
		).toEqual([
			[1, "replica-a"],
			[2, "replica-b"],
		]);
		const [head] = await adminQuery(
			`SELECT owner_epoch FROM "${schema}".streams WHERE stream_id = $1`,
			[stream],
		);
		expect(head?.owner_epoch).toBe("2");
	});

	it("serialises concurrent appends from two processes: one wins each expectedSeq", async () => {
		const schema = freshSchema();
		const a = start(schema);
		const b = start(schema);
		await Promise.all([a.call("ready"), b.call("ready")]);
		const stream = "cd:camp:camp-2:status";
		let seq = 0;
		for (let round = 0; round < 10; round += 1) {
			const replies = await Promise.all([
				a.send("append", { streamId: stream, expectedSeq: seq, holderId: "a" }),
				b.send("append", { streamId: stream, expectedSeq: seq, holderId: "b" }),
			]);
			const ok = replies.filter((reply) => reply.ok);
			expect(ok).toHaveLength(1);
			expect(replies.find((reply) => !reply.ok)).toMatchObject({
				code: "OPTIMISTIC_SEQUENCE_CONFLICT",
			});
			seq += 1;
		}
		const positions = await a.strings("positions");
		expect(positions).toEqual(
			Array.from({ length: 10 }, (_, i) => String(i + 1)),
		);
	});
});
