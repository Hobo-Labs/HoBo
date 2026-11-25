import { describe, expect, it } from "vitest";

import { createMemoryNodeSqliteDriver, SqliteJournal } from "../src/index.js";

const NOW = "2026-07-27T12:00:00.000Z";

function movableClock(start = NOW) {
	let iso = start;
	return {
		now: () => iso,
		advanceMs(ms: number) {
			iso = new Date(Date.parse(iso) + ms).toISOString();
		},
	};
}

function journal(clock: { now: () => string }): SqliteJournal {
	return new SqliteJournal(createMemoryNodeSqliteDriver(), {
		clock,
		nativePragmas: false,
	});
}

const SUB = { subscriptionId: "projector", partitionId: "p0" };

describe("subscription leases", () => {
	it("claims a free partition with fence 1", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const lease = await j.claimSubscription({ ...SUB, holderId: "w1" });
			expect(lease.fenceToken).toBe(1n);
			expect(lease.holderId).toBe("w1");
			expect(lease.subscriptionId).toBe("projector");
			expect(lease.partitionId).toBe("p0");
		} finally {
			j.close();
		}
	});

	it("refuses a second holder while the lease is live", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			await j.claimSubscription({ ...SUB, holderId: "w1" });
			await expect(
				j.claimSubscription({ ...SUB, holderId: "w2" }),
			).rejects.toThrow();
		} finally {
			j.close();
		}
	});

	it("lets the current holder re-claim without waiting out the lease", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const first = await j.claimSubscription({ ...SUB, holderId: "w1" });
			const again = await j.claimSubscription({ ...SUB, holderId: "w1" });
			expect(again.fenceToken).toBeGreaterThan(first.fenceToken);
		} finally {
			j.close();
		}
	});

	it("allows takeover once the lease expires, with a higher fence", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const first = await j.claimSubscription({
				...SUB,
				holderId: "w1",
				leaseTtlMs: 1000,
			});
			clock.advanceMs(1001);
			const second = await j.claimSubscription({ ...SUB, holderId: "w2" });
			expect(second.fenceToken).toBe(first.fenceToken + 1n);
		} finally {
			j.close();
		}
	});

	it("renews a lease held with the right fence", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const lease = await j.claimSubscription({ ...SUB, holderId: "w1" });
			clock.advanceMs(100);
			const renewed = await j.renewSubscription({
				...SUB,
				holderId: "w1",
				fenceToken: lease.fenceToken,
			});
			expect(renewed.fenceToken).toBe(lease.fenceToken);
			expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(
				Date.parse(lease.expiresAt),
			);
		} finally {
			j.close();
		}
	});

	it("refuses a renewal with the wrong fence or the wrong holder", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const lease = await j.claimSubscription({ ...SUB, holderId: "w1" });
			await expect(
				j.renewSubscription({
					...SUB,
					holderId: "w1",
					fenceToken: lease.fenceToken + 1n,
				}),
			).rejects.toThrow();
			await expect(
				j.renewSubscription({
					...SUB,
					holderId: "impostor",
					fenceToken: lease.fenceToken,
				}),
			).rejects.toThrow();
		} finally {
			j.close();
		}
	});

	it("refuses a renewal for a partition nobody has claimed", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			await expect(
				j.renewSubscription({ ...SUB, holderId: "w1", fenceToken: 1n }),
			).rejects.toThrow();
		} finally {
			j.close();
		}
	});
});

describe("checkpoints", () => {
	async function claimed(j: SqliteJournal) {
		return j.claimSubscription({ ...SUB, holderId: "w1" });
	}

	it("reports no checkpoint for a partition never processed", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			expect(await j.loadCheckpoint(SUB)).toBeUndefined();
		} finally {
			j.close();
		}
	});

	it("round-trips a committed checkpoint", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const lease = await claimed(j);
			const committed = await j.commitCheckpoint({
				...SUB,
				position: 42n,
				fenceToken: lease.fenceToken,
			});
			expect(committed.position).toBe(42n);
			const loaded = await j.loadCheckpoint(SUB);
			expect(loaded?.position).toBe(42n);
			expect(loaded?.fenceToken).toBe(lease.fenceToken);
		} finally {
			j.close();
		}
	});

	it("advances a checkpoint forward", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const lease = await claimed(j);
			await j.commitCheckpoint({
				...SUB,
				position: 10n,
				fenceToken: lease.fenceToken,
			});
			await j.commitCheckpoint({
				...SUB,
				position: 20n,
				fenceToken: lease.fenceToken,
			});
			expect((await j.loadCheckpoint(SUB))?.position).toBe(20n);
		} finally {
			j.close();
		}
	});

	it("allows a checkpoint to be re-committed at the same position", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const lease = await claimed(j);
			await j.commitCheckpoint({
				...SUB,
				position: 10n,
				fenceToken: lease.fenceToken,
			});
			await expect(
				j.commitCheckpoint({
					...SUB,
					position: 10n,
					fenceToken: lease.fenceToken,
				}),
			).resolves.toBeDefined();
		} finally {
			j.close();
		}
	});

	it("refuses a checkpoint that moves backwards", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const lease = await claimed(j);
			await j.commitCheckpoint({
				...SUB,
				position: 20n,
				fenceToken: lease.fenceToken,
			});
			try {
				await j.commitCheckpoint({
					...SUB,
					position: 10n,
					fenceToken: lease.fenceToken,
				});
				expect.unreachable("a regressing checkpoint must be refused");
			} catch (error) {
				expect((error as { code?: string }).code).toBe("CHECKPOINT_REGRESSION");
			}
			expect((await j.loadCheckpoint(SUB))?.position).toBe(20n);
		} finally {
			j.close();
		}
	});

	it("refuses a checkpoint from a stale fence", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const first = await j.claimSubscription({
				...SUB,
				holderId: "w1",
				leaseTtlMs: 1000,
			});
			clock.advanceMs(1001);
			await j.claimSubscription({ ...SUB, holderId: "w2" });
			try {
				await j.commitCheckpoint({
					...SUB,
					position: 5n,
					fenceToken: first.fenceToken,
				});
				expect.unreachable("a fenced-out holder must not checkpoint");
			} catch (error) {
				expect((error as { code?: string }).code).toBe("STALE_FENCE");
			}
		} finally {
			j.close();
		}
	});

	it("refuses a checkpoint when no lease exists at all", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			await expect(
				j.commitCheckpoint({ ...SUB, position: 1n, fenceToken: 1n }),
			).rejects.toThrow();
		} finally {
			j.close();
		}
	});

	it("resets a checkpoint administratively, including backwards", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const lease = await claimed(j);
			await j.commitCheckpoint({
				...SUB,
				position: 100n,
				fenceToken: lease.fenceToken,
			});
			const reset = await j.resetCheckpoint({
				...SUB,
				position: 0n,
				administrative: true,
				holderId: "admin",
			});
			expect(reset.position).toBe(0n);
			expect((await j.loadCheckpoint(SUB))?.position).toBe(0n);
		} finally {
			j.close();
		}
	});

	it("creates a checkpoint on reset when none existed", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const reset = await j.resetCheckpoint({
				...SUB,
				position: 7n,
				administrative: true,
				holderId: "admin",
			});
			expect(reset.position).toBe(7n);
			expect(reset.fenceToken).toBe(1n);
		} finally {
			j.close();
		}
	});

	it("keeps partitions of one subscription independent", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const p0 = await j.claimSubscription({ ...SUB, holderId: "w1" });
			const p1 = await j.claimSubscription({
				subscriptionId: "projector",
				partitionId: "p1",
				holderId: "w2",
			});
			await j.commitCheckpoint({
				...SUB,
				position: 5n,
				fenceToken: p0.fenceToken,
			});
			await j.commitCheckpoint({
				subscriptionId: "projector",
				partitionId: "p1",
				position: 9n,
				fenceToken: p1.fenceToken,
			});
			expect((await j.loadCheckpoint(SUB))?.position).toBe(5n);
			expect(
				(
					await j.loadCheckpoint({
						subscriptionId: "projector",
						partitionId: "p1",
					})
				)?.position,
			).toBe(9n);
		} finally {
			j.close();
		}
	});
});
