/**
 * Durable subscription leases and checkpoints.
 *
 * A checkpoint is a promise that everything before a position has been
 * processed. Two failures make that promise a lie without throwing anything at
 * the time: a checkpoint written by a holder that no longer owns the
 * partition, and a checkpoint that moves backwards so already-processed events
 * are replayed as new. Both are guarded by the fence, and both are what these
 * assertions are about.
 */
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
			// A worker that restarted but kept its identity must be able to resume
			// immediately; the guard is `heldBy !== holderId`, so re-claiming is
			// allowed and the fence still advances to invalidate any in-flight
			// write from the previous incarnation.
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
			// The fence is what stops the stalled worker's next checkpoint from
			// landing — without a bump, the two workers would be indistinguishable.
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
			// Renewal extends the window without changing the fence, so work in
			// flight under that fence stays valid.
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
			// A worker that was fenced out must not be able to extend a lease it
			// no longer holds — that would let it keep processing indefinitely
			// alongside its replacement.
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
			// Undefined, not position zero: "never started" and "processed up to
			// the first event" are different states, and only one of them means a
			// projector should replay from the beginning.
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
			// The position must survive as a bigint. Narrowing it to a number
			// would silently cap a long-lived partition at 2^53 events.
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
			// `position < current` is the guard, so equality is permitted. A
			// worker that crashed after processing but before committing will
			// re-commit the same position on restart, and refusing that would
			// wedge it.
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
				// Regression means already-processed events are delivered again as
				// new. For a non-idempotent projector that is double-application,
				// and nothing downstream would notice.
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
				// This is the case the fence exists for: the first worker stalled,
				// lost the partition, and woke up believing it was still processing.
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
			// Committing without ever claiming would let two unclaimed workers
			// interleave checkpoints with no ownership between them.
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
			// A replay is the one legitimate way to move a checkpoint backwards,
			// which is why it is a separate method requiring `administrative: true`
			// rather than a flag on the normal commit path.
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
			// Upsert, not update: an operator seeding a projector's starting
			// position must not have to run it once first.
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
			// Partitions are processed in parallel by design; a shared checkpoint
			// would make the slowest one dictate every other one's progress.
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
