import { expect, it } from "vitest";
import { describeLive, freshSchema, liveStore, manualClock } from "./support/live.js";

const KEY = { subscriptionId: "hobo.cd.camp", partitionId: "camp-1" };

describeLive("subscription leases and checkpoints", () => {
	it("grants a free lease with fence 1 and refuses a second live holder with lease-held", async () => {
		const store = liveStore();
		const lease = await store.claimSubscription({ ...KEY, holderId: "a" });
		expect(lease).toMatchObject({ holderId: "a", fenceToken: 1n, expiresAt: "2026-11-12T00:00:30.000Z" });
		await expect(store.claimSubscription({ ...KEY, holderId: "b" })).rejects.toMatchObject({
			code: "SUBSCRIPTION_LEASE_CONFLICT",
			failure: "lease-held",
			remediation: expect.stringContaining("Wait for it to expire"),
		});
	});

	it("hands an expired lease to a new holder with a higher fence; tokens never repeat", async () => {
		const clock = manualClock();
		const store = liveStore({ clock });
		await store.claimSubscription({ ...KEY, holderId: "a", leaseTtlMs: 1_000 });
		clock.advance(1_001);
		const taken = await store.claimSubscription({ ...KEY, holderId: "b" });
		expect(taken.fenceToken).toBe(2n);
		await store.releaseSubscription({ ...KEY, holderId: "b", fenceToken: 2n });
		const again = await store.claimSubscription({ ...KEY, holderId: "a" });
		expect(again.fenceToken).toBe(3n);
	});

	it("renews without rotating the fence, and refuses a renewal after takeover", async () => {
		const clock = manualClock();
		const store = liveStore({ clock });
		const lease = await store.claimSubscription({ ...KEY, holderId: "a", leaseTtlMs: 1_000 });
		clock.advance(500);
		const renewed = await store.renewSubscription({ ...KEY, holderId: "a", fenceToken: lease.fenceToken, leaseTtlMs: 1_000 });
		expect(renewed).toMatchObject({ fenceToken: 1n, expiresAt: "2026-11-12T00:00:01.500Z" });
		clock.advance(2_000);
		await store.claimSubscription({ ...KEY, holderId: "b" });
		await expect(
			store.renewSubscription({ ...KEY, holderId: "a", fenceToken: 1n }),
		).rejects.toMatchObject({ code: "STALE_FENCE", provided: 1n, stored: 2n });
	});

	it("refuses to release a lease one does not hold, and treats a repeated release as done", async () => {
		const store = liveStore();
		await store.claimSubscription({ ...KEY, holderId: "a" });
		await expect(
			store.releaseSubscription({ ...KEY, holderId: "b", fenceToken: 1n }),
		).rejects.toMatchObject({ code: "STALE_FENCE" });
		await store.releaseSubscription({ ...KEY, holderId: "a", fenceToken: 1n });
		await store.releaseSubscription({ ...KEY, holderId: "a", fenceToken: 1n });
		await expect(
			store.commitCheckpoint({ ...KEY, position: 1n, fenceToken: 1n }),
		).rejects.toMatchObject({ code: "SUBSCRIPTION_LEASE_CONFLICT", failure: "lease-not-held" });
	});

	it("commits checkpoints forward only, logs each advance once, and records administrative resets", async () => {
		const store = liveStore();
		const lease = await store.claimSubscription({ ...KEY, holderId: "a" });
		await store.commitCheckpoint({ ...KEY, position: 3n, fenceToken: lease.fenceToken });
		await store.commitCheckpoint({ ...KEY, position: 3n, fenceToken: lease.fenceToken });
		await store.commitCheckpoint({ ...KEY, position: 7n, fenceToken: lease.fenceToken });
		await expect(
			store.commitCheckpoint({ ...KEY, position: 5n, fenceToken: lease.fenceToken }),
		).rejects.toMatchObject({ code: "CHECKPOINT_REGRESSION", attempted: 5n, current: 7n });
		await expect(
			store.commitCheckpoint({ ...KEY, position: 9n, fenceToken: 9n }),
		).rejects.toMatchObject({ code: "STALE_FENCE" });
		expect(await store.loadCheckpoint(KEY)).toMatchObject({ position: 7n, fenceToken: 1n });

		const reset = await store.resetCheckpoint({ ...KEY, position: 2n, administrative: true, holderId: "operator" });
		expect(reset.position).toBe(2n);
		await store.commitCheckpoint({ ...KEY, position: 4n, fenceToken: lease.fenceToken });
		const log = await store.checkpointLog(KEY);
		expect(log.map((entry) => [entry.entry, entry.kind, entry.position, entry.holderId])).toEqual([
			[1n, "advance", 3n, "a"],
			[2n, "advance", 7n, "a"],
			[3n, "reset", 2n, "operator"],
			[4n, "advance", 4n, "a"],
		]);
	});

	it("refuses a checkpoint for a subscription that was never leased", async () => {
		const store = liveStore();
		await expect(
			store.commitCheckpoint({ ...KEY, position: 1n, fenceToken: 1n }),
		).rejects.toMatchObject({ code: "STALE_FENCE", stored: 0n });
		await expect(store.loadCheckpoint(KEY)).resolves.toBeUndefined();
	});

	it("grants exactly one of many concurrent claimants from separate pools", async () => {
		const schema = freshSchema();
		const stores = Array.from({ length: 8 }, () => liveStore({ schema, config: { poolSize: 1 } }));
		await stores[0]?.ready();
		const results = await Promise.allSettled(
			stores.map((store, index) => store.claimSubscription({ ...KEY, holderId: `h${index}` })),
		);
		const granted = results.filter((result) => result.status === "fulfilled");
		expect(granted).toHaveLength(1);
		for (const result of results) {
			if (result.status === "rejected") {
				expect(result.reason).toMatchObject({ code: "SUBSCRIPTION_LEASE_CONFLICT" });
			}
		}
	});

	it("validates lease inputs at the boundary", async () => {
		const store = liveStore();
		await expect(store.claimSubscription({ ...KEY, holderId: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(store.claimSubscription({ ...KEY, holderId: "a", leaseTtlMs: 0 })).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		await expect(
			store.claimSubscription({ subscriptionId: "", partitionId: "p", holderId: "a" }),
		).rejects.toMatchObject({ code: "HOBO_CORE_EVENTSTORE_PARSE" });
	});
});
