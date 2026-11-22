import { describe, expect, it } from "vitest";

import {
	createMemoryNodeSqliteDriver,
	SqliteJournal,
	StaleFenceError,
} from "../src/index.js";

function controllableClock(startMs = Date.parse("2026-07-27T12:00:00.000Z")) {
	let ms = startMs;
	return {
		now: () => new Date(ms).toISOString(),
		advance: (byMs: number) => {
			ms += byMs;
		},
	};
}

function journal(clock = controllableClock()) {
	return {
		j: new SqliteJournal(createMemoryNodeSqliteDriver(), {
			clock,
			nativePragmas: false,
		}),
		clock,
	};
}

describe("enqueueMessage", () => {
	it("returns a deterministic id derived from queue and key", () => {
		const { j } = journal();
		const first = j.enqueueMessage({
			queueName: "q",
			idempotencyKey: "k1",
			body: { a: 1 },
		});
		expect(first.messageId).toBeTruthy();
		expect(first.deduped).toBe(false);
		j.close();
	});

	it("dedupes a repeat of the same key", () => {
		const { j } = journal();
		const first = j.enqueueMessage({
			queueName: "q",
			idempotencyKey: "k1",
			body: { a: 1 },
		});
		const second = j.enqueueMessage({
			queueName: "q",
			idempotencyKey: "k1",
			body: { a: 2 },
		});
		expect(second.deduped).toBe(true);
		expect(second.messageId).toBe(first.messageId);
		j.close();
	});

	it("says it deduped rather than silently returning a new id", () => {
		const { j } = journal();
		j.enqueueMessage({ queueName: "q", idempotencyKey: "k1", body: {} });
		expect(
			j.enqueueMessage({ queueName: "q", idempotencyKey: "k1", body: {} })
				.deduped,
		).toBe(true);
		j.close();
	});

	it("treats the same key in a different queue as a distinct message", () => {
		const { j } = journal();
		const a = j.enqueueMessage({
			queueName: "q1",
			idempotencyKey: "k",
			body: {},
		});
		const b = j.enqueueMessage({
			queueName: "q2",
			idempotencyKey: "k",
			body: {},
		});
		expect(b.deduped).toBe(false);
		expect(b.messageId).not.toBe(a.messageId);
		j.close();
	});

	it("accepts an explicit message id", () => {
		const { j } = journal();
		expect(
			j.enqueueMessage({
				queueName: "q",
				idempotencyKey: "k",
				body: {},
				messageId: "chosen",
			}).messageId,
		).toBe("chosen");
		j.close();
	});
});

describe("leaseMessages", () => {
	function seeded() {
		const { j, clock } = journal();
		j.enqueueMessage({ queueName: "q", idempotencyKey: "k1", body: { n: 1 } });
		return { j, clock };
	}

	it("leases a pending message and returns its body", () => {
		const { j } = seeded();
		const leased = j.leaseMessages({
			queueName: "q",
			maxMessages: 10,
			visibilityTimeoutMs: 1000,
			leaseId: "w1",
			leaseFence: 1n,
		});
		expect(leased).toHaveLength(1);
		expect(leased[0]?.body).toEqual({ n: 1 });
		j.close();
	});

	it("does not lease the same message twice while the lease holds", () => {
		const { j } = seeded();
		j.leaseMessages({
			queueName: "q",
			maxMessages: 10,
			visibilityTimeoutMs: 60_000,
			leaseId: "w1",
			leaseFence: 1n,
		});
		expect(
			j.leaseMessages({
				queueName: "q",
				maxMessages: 10,
				visibilityTimeoutMs: 60_000,
				leaseId: "w2",
				leaseFence: 2n,
			}),
		).toEqual([]);
		j.close();
	});

	it("reclaims a message whose lease expired", () => {
		const { j, clock } = seeded();
		j.leaseMessages({
			queueName: "q",
			maxMessages: 10,
			visibilityTimeoutMs: 1000,
			leaseId: "w1",
			leaseFence: 1n,
		});
		clock.advance(5000);
		const second = j.leaseMessages({
			queueName: "q",
			maxMessages: 10,
			visibilityTimeoutMs: 1000,
			leaseId: "w2",
			leaseFence: 2n,
		});
		expect(second).toHaveLength(1);
		j.close();
	});

	it("increments the delivery attempt on redelivery", () => {
		const { j, clock } = seeded();
		const first = j.leaseMessages({
			queueName: "q",
			maxMessages: 10,
			visibilityTimeoutMs: 1000,
			leaseId: "w1",
			leaseFence: 1n,
		});
		clock.advance(5000);
		const second = j.leaseMessages({
			queueName: "q",
			maxMessages: 10,
			visibilityTimeoutMs: 1000,
			leaseId: "w2",
			leaseFence: 2n,
		});
		expect(second[0]?.deliveryAttempt).toBe(
			(first[0]?.deliveryAttempt ?? 0) + 1,
		);
		j.close();
	});

	it("respects the message limit", () => {
		const { j } = journal();
		for (const key of ["k1", "k2", "k3"])
			j.enqueueMessage({ queueName: "q", idempotencyKey: key, body: {} });
		expect(
			j.leaseMessages({
				queueName: "q",
				maxMessages: 2,
				visibilityTimeoutMs: 1000,
				leaseId: "w1",
				leaseFence: 1n,
			}),
		).toHaveLength(2);
		j.close();
	});

	it("does not lease a message that is not yet available", () => {
		const { j, clock } = journal();
		const later = new Date(Date.parse(clock.now()) + 60_000).toISOString();
		j.enqueueMessage({
			queueName: "q",
			idempotencyKey: "k",
			body: {},
			availableAt: later,
		});
		expect(
			j.leaseMessages({
				queueName: "q",
				maxMessages: 10,
				visibilityTimeoutMs: 1000,
				leaseId: "w1",
				leaseFence: 1n,
			}),
		).toEqual([]);
		j.close();
	});

	it("leases a delayed message once its time arrives", () => {
		const { j, clock } = journal();
		const later = new Date(Date.parse(clock.now()) + 60_000).toISOString();
		j.enqueueMessage({
			queueName: "q",
			idempotencyKey: "k",
			body: {},
			availableAt: later,
		});
		clock.advance(90_000);
		expect(
			j.leaseMessages({
				queueName: "q",
				maxMessages: 10,
				visibilityTimeoutMs: 1000,
				leaseId: "w1",
				leaseFence: 1n,
			}),
		).toHaveLength(1);
		j.close();
	});

	it("leases nothing from an empty queue", () => {
		const { j } = journal();
		expect(
			j.leaseMessages({
				queueName: "empty",
				maxMessages: 10,
				visibilityTimeoutMs: 1000,
				leaseId: "w1",
				leaseFence: 1n,
			}),
		).toEqual([]);
		j.close();
	});

	it("does not lease across queues", () => {
		const { j } = journal();
		j.enqueueMessage({ queueName: "q1", idempotencyKey: "k", body: {} });
		expect(
			j.leaseMessages({
				queueName: "q2",
				maxMessages: 10,
				visibilityTimeoutMs: 1000,
				leaseId: "w1",
				leaseFence: 1n,
			}),
		).toEqual([]);
		j.close();
	});
});

describe("completeMessage is fenced", () => {
	function leased() {
		const { j, clock } = journal();
		j.enqueueMessage({ queueName: "q", idempotencyKey: "k", body: {} });
		const [message] = j.leaseMessages({
			queueName: "q",
			maxMessages: 1,
			visibilityTimeoutMs: 1000,
			leaseId: "w1",
			leaseFence: 7n,
		});
		return { j, clock, messageId: message?.messageId ?? "" };
	}

	it("completes work held at the right lease and fence", () => {
		const { j, messageId } = leased();
		expect(j.completeMessage(messageId, "w1", 7n, 1)).toBe(true);
		j.close();
	});

	it("refuses completion from a different holder", () => {
		const { j, messageId } = leased();
		expect(j.completeMessage(messageId, "w2", 7n, 1)).toBe(false);
		j.close();
	});

	it("refuses completion at a stale fence", () => {
		const { j, messageId } = leased();
		expect(j.completeMessage(messageId, "w1", 6n, 1)).toBe(false);
		j.close();
	});

	it("reports false rather than throwing for an unknown message", () => {
		const { j } = journal();
		expect(j.completeMessage("absent", "w1", 1n, 1)).toBe(false);
		j.close();
	});

	it("refuses a second completion of the same message", () => {
		const { j, messageId } = leased();
		j.completeMessage(messageId, "w1", 7n, 1);
		expect(j.completeMessage(messageId, "w1", 7n, 1)).toBe(false);
		j.close();
	});

	it("does not redeliver a completed message", () => {
		const { j, clock, messageId } = leased();
		j.completeMessage(messageId, "w1", 7n, 1);
		clock.advance(60_000);
		expect(
			j.leaseMessages({
				queueName: "q",
				maxMessages: 10,
				visibilityTimeoutMs: 1000,
				leaseId: "w2",
				leaseFence: 8n,
			}),
		).toEqual([]);
		j.close();
	});
});

describe("actor leases", () => {
	it("grants a fresh lease at fence 1", () => {
		const { j } = journal();
		const lease = j.acquireActorLease({ key: "a1", holderId: "h1" });
		expect(lease.fenceToken).toBe(1n);
		expect(lease.holderId).toBe("h1");
		j.close();
	});

	it("refuses a second holder while the lease is live", () => {
		const { j } = journal();
		j.acquireActorLease({ key: "a1", holderId: "h1" });
		expect(() => j.acquireActorLease({ key: "a1", holderId: "h2" })).toThrow(
			StaleFenceError,
		);
	});

	it("refuses even the same holder while the lease is live", () => {
		const { j } = journal();
		j.acquireActorLease({ key: "a1", holderId: "h1" });
		expect(() => j.acquireActorLease({ key: "a1", holderId: "h1" })).toThrow(
			StaleFenceError,
		);
	});

	it("grants the lease to a new holder once it expires", () => {
		const { j, clock } = journal();
		j.acquireActorLease({ key: "a1", holderId: "h1", leaseTtlMs: 1000 });
		clock.advance(5000);
		expect(j.acquireActorLease({ key: "a1", holderId: "h2" }).holderId).toBe(
			"h2",
		);
		j.close();
	});

	it("increments the fence on takeover", () => {
		const { j, clock } = journal();
		j.acquireActorLease({ key: "a1", holderId: "h1", leaseTtlMs: 1000 });
		clock.advance(5000);
		expect(j.acquireActorLease({ key: "a1", holderId: "h2" }).fenceToken).toBe(
			2n,
		);
		j.close();
	});

	it("keeps incrementing across repeated takeovers", () => {
		const { j, clock } = journal();
		for (let i = 0; i < 3; i += 1) {
			j.acquireActorLease({ key: "a1", holderId: `h${i}`, leaseTtlMs: 1000 });
			clock.advance(5000);
		}
		expect(j.acquireActorLease({ key: "a1", holderId: "hn" }).fenceToken).toBe(
			4n,
		);
		j.close();
	});

	it("grants immediately after an explicit release", () => {
		const { j } = journal();
		const lease = j.acquireActorLease({ key: "a1", holderId: "h1" });
		j.releaseActorLease("a1", "h1", lease.fenceToken);
		expect(() =>
			j.acquireActorLease({ key: "a1", holderId: "h2" }),
		).not.toThrow();
		j.close();
	});

	it("still bumps the fence after a clean release", () => {
		const { j } = journal();
		const lease = j.acquireActorLease({ key: "a1", holderId: "h1" });
		j.releaseActorLease("a1", "h1", lease.fenceToken);
		expect(j.acquireActorLease({ key: "a1", holderId: "h2" }).fenceToken).toBe(
			2n,
		);
		j.close();
	});

	it("ignores a release from a different holder", () => {
		const { j } = journal();
		const lease = j.acquireActorLease({ key: "a1", holderId: "h1" });
		j.releaseActorLease("a1", "impostor", lease.fenceToken);
		expect(() => j.acquireActorLease({ key: "a1", holderId: "h2" })).toThrow(
			StaleFenceError,
		);
	});

	it("ignores a release at the wrong fence", () => {
		const { j } = journal();
		j.acquireActorLease({ key: "a1", holderId: "h1" });
		j.releaseActorLease("a1", "h1", 99n);
		expect(() => j.acquireActorLease({ key: "a1", holderId: "h2" })).toThrow(
			StaleFenceError,
		);
	});

	it("keeps separate keys independent", () => {
		const { j } = journal();
		j.acquireActorLease({ key: "a1", holderId: "h1" });
		expect(() =>
			j.acquireActorLease({ key: "a2", holderId: "h1" }),
		).not.toThrow();
		j.close();
	});

	it("reports an expiry derived from the ttl", () => {
		const { j, clock } = journal();
		const lease = j.acquireActorLease({
			key: "a1",
			holderId: "h1",
			leaseTtlMs: 1000,
		});
		expect(Date.parse(lease.expiresAt) - Date.parse(clock.now())).toBe(1000);
		j.close();
	});

	it("defaults the ttl rather than granting an unbounded lease", () => {
		const { j, clock } = journal();
		const lease = j.acquireActorLease({ key: "a1", holderId: "h1" });
		expect(Date.parse(lease.expiresAt)).toBeGreaterThan(
			Date.parse(clock.now()),
		);
		j.close();
	});

	it("tolerates releasing a lease that was never taken", () => {
		const { j } = journal();
		expect(() => j.releaseActorLease("never", "h1", 1n)).not.toThrow();
		j.close();
	});
});
