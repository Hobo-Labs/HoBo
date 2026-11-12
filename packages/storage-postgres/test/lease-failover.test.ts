import { afterEach, expect, it } from "vitest";
import {
	describeLive,
	freshSchema,
	liveStore,
	OPTS,
	T0,
} from "./support/live.js";
import {
	type StoreProcess,
	startStoreProcess,
} from "./support/worker-process.js";

/**
 * Plan 0024 WP17 Accept: "Lease failover with no lost or duplicate
 * checkpoint"; §10 row "Postgres lease holder dies → Another resumes; no lost
 * or duplicate checkpoint".
 *
 * A consumer process holds the subscription lease and checkpoints after each
 * event. It is SIGKILLed mid-stream. A second process takes over after the
 * lease expires, resumes from the committed checkpoint and finishes. The
 * checkpoint audit log must then hold every position exactly once, strictly
 * increasing, with the fence rising at the handover and never falling.
 */
describeLive("WP17 lease failover (§10: Postgres lease holder dies)", () => {
	const processes: StoreProcess[] = [];
	afterEach(async () => {
		await Promise.all(
			processes.splice(0).map((p) => p.stop().catch(() => undefined)),
		);
	});

	it("resumes in another process with no lost or duplicate checkpoint", async () => {
		const schema = freshSchema();
		const inspector = liveStore({ schema });
		const total = 12;
		for (let n = 0; n < total; n += 1) {
			await inspector.append(
				`camp:${n % 3}`,
				[{ type: "camp.Desired", data: { n } }],
				{
					...OPTS,
					expectedSeq: Math.floor(n / 3),
				},
			);
		}
		const key = { subscriptionId: "hobo.cd.camp", partitionId: "fleet" };

		const first = startStoreProcess(schema, T0);
		processes.push(first);
		const leaseA = await first.lease("claim", {
			...key,
			holderId: "replica-a",
			ttlMs: 30_000,
		});
		const positions = await first.strings("positions");
		expect(positions).toHaveLength(total);
		// Process (and checkpoint) the first five, then die without releasing.
		for (const position of positions.slice(0, 5)) {
			await first.call("checkpoint", { ...key, position, fence: leaseA.fence });
		}
		await first.kill();

		const second = startStoreProcess(schema, T0);
		processes.push(second);
		// The dead holder's lease is still live: no early takeover.
		expect(
			await second.send("claim", { ...key, holderId: "replica-b" }),
		).toMatchObject({
			ok: false,
			code: "SUBSCRIPTION_LEASE_CONFLICT",
			failure: "lease-held",
		});
		await second.call("clock", { at: "2026-11-12T00:00:30.001Z" });
		const leaseB = await second.lease("claim", {
			...key,
			holderId: "replica-b",
			ttlMs: 30_000,
		});
		expect(BigInt(leaseB.fence)).toBeGreaterThan(BigInt(leaseA.fence));
		const resumeFrom = await second.text("loadCheckpoint", key);
		expect(resumeFrom).toBe(positions[4]);
		const rest = await second.strings("positions", {
			after: resumeFrom,
		});
		expect(rest).toEqual(positions.slice(5));
		for (const position of rest) {
			await second.call("checkpoint", {
				...key,
				position,
				fence: leaseB.fence,
			});
		}

		const log = await inspector.checkpointLog(key);
		const advanced = log
			.filter((entry) => entry.kind === "advance")
			.map((entry) => entry.position.toString());
		expect(advanced).toEqual(positions);
		expect(new Set(advanced).size).toBe(advanced.length);
		for (let index = 1; index < log.length; index += 1) {
			const previous = log[index - 1];
			const current = log[index];
			expect(current?.position).toBeGreaterThan(previous?.position ?? -1n);
			expect(current?.fenceToken).toBeGreaterThanOrEqual(
				previous?.fenceToken ?? 0n,
			);
		}
		expect(log.map((entry) => entry.holderId)).toEqual([
			...Array(5).fill("replica-a"),
			...Array(total - 5).fill("replica-b"),
		]);
		expect((await inspector.loadCheckpoint(key))?.position.toString()).toBe(
			positions.at(-1),
		);
	});

	it("refuses a zombie holder's late checkpoint after takeover, leaving the log untouched", async () => {
		const schema = freshSchema();
		const inspector = liveStore({ schema });
		for (let n = 0; n < 4; n += 1) {
			await inspector.append(
				"camp:z",
				[{ type: "camp.Desired", data: { n } }],
				{ ...OPTS, expectedSeq: n },
			);
		}
		const key = { subscriptionId: "hobo.cd.camp", partitionId: "camp-z" };
		const zombie = startStoreProcess(schema, T0);
		const heir = startStoreProcess(schema, "2026-11-12T00:01:00.000Z");
		processes.push(zombie, heir);
		const old = await zombie.lease("claim", {
			...key,
			holderId: "zombie",
			ttlMs: 30_000,
		});
		await zombie.call("checkpoint", { ...key, position: 1, fence: old.fence });
		const fresh = await heir.lease("claim", {
			...key,
			holderId: "heir",
			ttlMs: 30_000,
		});
		await heir.call("checkpoint", { ...key, position: 2, fence: fresh.fence });

		const late = await zombie.send("checkpoint", {
			...key,
			position: 3,
			fence: old.fence,
		});
		expect(late).toMatchObject({ ok: false, code: "STALE_FENCE" });
		const log = await inspector.checkpointLog(key);
		expect(
			log.map((entry) => [entry.position.toString(), entry.holderId]),
		).toEqual([
			["1", "zombie"],
			["2", "heir"],
		]);
	});
});
