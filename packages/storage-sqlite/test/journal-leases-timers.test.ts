/**
 * Actor leases and durable timers.
 *
 * A lease is what makes an actor single-writer, and a fence token is what
 * makes a *stale* holder detectable after a pause. The failure being guarded
 * is the classic one: a holder that stalls past its expiry, a second holder
 * takes over, and then the first wakes up and writes. Nothing throws at the
 * moment of the double-write — the fence is the only thing that separates the
 * two, so every assertion here is about the fence being monotonic and the
 * takeover being refused while the lease is genuinely live.
 */
import { describe, expect, it } from "vitest";

import { createMemoryNodeSqliteDriver, SqliteJournal } from "../src/index.js";

const actor = { kind: "system" as const, id: "test" };

/** A clock the test drives, so expiry is exercised without sleeping. */
function movableClock(start = "2026-07-27T12:00:00.000Z") {
	let iso = start;
	return {
		now: () => iso,
		advanceMs(ms: number) {
			iso = new Date(Date.parse(iso) + ms).toISOString();
		},
		set(next: string) {
			iso = next;
		},
	};
}

function journal(clock: { now: () => string }): SqliteJournal {
	return new SqliteJournal(createMemoryNodeSqliteDriver(), {
		clock,
		nativePragmas: false,
	});
}

describe("actor leases", () => {
	it("issues fence token 1 for a key nobody has held", () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const lease = j.acquireActorLease({ key: "a1", holderId: "h1" });
			// Fence tokens start at 1, not 0: a zero would be indistinguishable
			// from "no fence supplied" everywhere a fence is compared.
			expect(lease.fenceToken).toBe(1n);
			expect(lease.key).toBe("a1");
			expect(lease.holderId).toBe("h1");
			expect(Date.parse(lease.expiresAt)).toBeGreaterThan(
				Date.parse(clock.now()),
			);
		} finally {
			j.close();
		}
	});

	it("refuses a second holder while the lease is live", () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			j.acquireActorLease({ key: "a1", holderId: "h1" });
			try {
				j.acquireActorLease({ key: "a1", holderId: "h2" });
				expect.unreachable("a live lease must not be stolen");
			} catch (error) {
				// This is the single-writer guarantee. Handing the key to a second
				// holder while the first is still running is exactly the
				// concurrent-mutation case the whole EventStore design forbids.
				expect((error as { code?: string }).code).toBe("STALE_FENCE");
			}
		} finally {
			j.close();
		}
	});

	it("refuses even the same holder re-acquiring a live lease", () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			j.acquireActorLease({ key: "a1", holderId: "h1" });
			// Deliberately strict: a holder that lost track of its own lease has a
			// bug, and silently re-issuing would bump the fence and invalidate the
			// work it is currently doing under the old one.
			expect(() =>
				j.acquireActorLease({ key: "a1", holderId: "h1" }),
			).toThrow();
		} finally {
			j.close();
		}
	});

	it("allows takeover once the lease has expired, with a higher fence", () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const first = j.acquireActorLease({
				key: "a1",
				holderId: "h1",
				leaseTtlMs: 1000,
			});
			clock.advanceMs(1001);
			const second = j.acquireActorLease({ key: "a1", holderId: "h2" });
			// Strictly higher, so a write from the stalled first holder can be
			// recognized as stale rather than merely "not the current holder".
			expect(second.fenceToken).toBeGreaterThan(first.fenceToken);
			expect(second.fenceToken).toBe(first.fenceToken + 1n);
			expect(second.holderId).toBe("h2");
		} finally {
			j.close();
		}
	});

	it("treats the expiry instant itself as takeable", () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const first = j.acquireActorLease({
				key: "a1",
				holderId: "h1",
				leaseTtlMs: 1000,
			});
			clock.advanceMs(999);
			// One millisecond before expiry the lease is unambiguously live.
			expect(() =>
				j.acquireActorLease({ key: "a1", holderId: "h2" }),
			).toThrow();

			clock.advanceMs(1);
			// At exactly `expiresAt` the guard is `exp > nowMs`, so takeover
			// succeeds. Pinning the boundary rather than assuming it goes the
			// other way: for one millisecond the outgoing holder may still
			// believe it holds the lease while a new one is issued.
			//
			// That is survivable precisely because the fence bumps — a write from
			// the old holder carries the lower token and is rejected downstream —
			// which is why this is a boundary worth recording rather than a race
			// worth changing. Holders are expected to renew well before expiry.
			const second = j.acquireActorLease({ key: "a1", holderId: "h2" });
			expect(second.fenceToken).toBe(first.fenceToken + 1n);
		} finally {
			j.close();
		}
	});

	it("allows immediate takeover after an explicit release", () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const first = j.acquireActorLease({ key: "a1", holderId: "h1" });
			j.releaseActorLease("a1", "h1", first.fenceToken);
			const second = j.acquireActorLease({ key: "a1", holderId: "h2" });
			// A clean handoff must not wait out the TTL — that is the difference
			// between a graceful shutdown and a crash.
			expect(second.fenceToken).toBe(first.fenceToken + 1n);
		} finally {
			j.close();
		}
	});

	it("ignores a release from the wrong holder or the wrong fence", () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const first = j.acquireActorLease({ key: "a1", holderId: "h1" });
			j.releaseActorLease("a1", "impostor", first.fenceToken);
			j.releaseActorLease("a1", "h1", first.fenceToken + 5n);
			// Both no-ops. A release keyed only on the lease name would let a
			// stalled holder from a previous generation drop the *current*
			// holder's lease when it finally woke up.
			expect(() =>
				j.acquireActorLease({ key: "a1", holderId: "h2" }),
			).toThrow();
		} finally {
			j.close();
		}
	});

	it("keeps leases for different keys independent", () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const a = j.acquireActorLease({ key: "a1", holderId: "h1" });
			const b = j.acquireActorLease({ key: "a2", holderId: "h1" });
			// Each key has its own fence sequence; a shared counter would make a
			// busy actor invalidate a quiet one's fence.
			expect(a.fenceToken).toBe(1n);
			expect(b.fenceToken).toBe(1n);
		} finally {
			j.close();
		}
	});

	it("keeps the fence monotonic across many generations", () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			let previous = 0n;
			for (let generation = 0; generation < 5; generation += 1) {
				const lease = j.acquireActorLease({
					key: "a1",
					holderId: `h${generation}`,
					leaseTtlMs: 1000,
				});
				// Monotonicity is the entire contract. One repeat anywhere in the
				// sequence and two generations become indistinguishable.
				expect(lease.fenceToken).toBeGreaterThan(previous);
				previous = lease.fenceToken;
				clock.advanceMs(1001);
			}
			expect(previous).toBe(5n);
		} finally {
			j.close();
		}
	});
});

describe("durable timers", () => {
	async function withTimer(
		j: SqliteJournal,
		dueAt: string,
		idempotencyKey = "k1",
	) {
		return j.commit({
			streamId: "s1",
			events: [{ type: "a.A", data: {} }],
			append: { expectedSeq: 0, actor, tenant: "t" },
			effects: [
				{
					kind: "timer",
					timerKind: "reminder",
					subjectId: "subj",
					idempotencyKey,
					dueAt,
					payload: { note: "wake up" },
				},
			],
		} as never);
	}

	it("claims a timer that is due and decodes its payload", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			await withTimer(j, clock.now());
			const due = j.claimDueTimers({ limit: 10 });
			expect(due).toHaveLength(1);
			expect(due[0]?.timerKind).toBe("reminder");
			expect(due[0]?.subjectId).toBe("subj");
			// The payload goes through the codec on the way out, so a timer
			// scheduled by one build is readable by the next.
			expect(due[0]?.payload).toEqual({ note: "wake up" });
		} finally {
			j.close();
		}
	});

	it("does not claim a timer that is not due yet", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const later = new Date(Date.parse(clock.now()) + 60_000).toISOString();
			await withTimer(j, later);
			// Firing early is worse than firing late: the effect happens before
			// the condition it was scheduled for.
			expect(j.claimDueTimers({ limit: 10 })).toEqual([]);
			clock.advanceMs(60_000);
			expect(j.claimDueTimers({ limit: 10 })).toHaveLength(1);
		} finally {
			j.close();
		}
	});

	it("honours the claim limit", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			await j.commit({
				streamId: "s1",
				events: [{ type: "a.A", data: {} }],
				append: { expectedSeq: 0, actor, tenant: "t" },
				effects: [1, 2, 3].map((n) => ({
					kind: "timer",
					timerKind: "reminder",
					subjectId: `subj${n}`,
					idempotencyKey: `k${n}`,
					dueAt: clock.now(),
					payload: {},
				})),
			} as never);
			// A worker asks for what it can process; handing back more would
			// silently exceed its own concurrency budget.
			expect(j.claimDueTimers({ limit: 2 })).toHaveLength(2);
		} finally {
			j.close();
		}
	});

	it("marks a timer fired exactly once", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			await withTimer(j, clock.now());
			const timerId = j.claimDueTimers({ limit: 1 })[0]?.timerId ?? "";
			expect(j.markTimerFired(timerId)).toBe(true);
			// The second call reports false rather than throwing: two workers
			// racing the same timer is expected, and exactly one must win.
			expect(j.markTimerFired(timerId)).toBe(false);
			expect(j.claimDueTimers({ limit: 10 })).toEqual([]);
		} finally {
			j.close();
		}
	});

	it("reports false for a timer that does not exist", () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			// False, not a throw — a worker retrying after a crash may hold an id
			// whose row was already reaped.
			expect(j.markTimerFired("no-such-timer")).toBe(false);
		} finally {
			j.close();
		}
	});

	it("accepts an explicit fired-at instant", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			await withTimer(j, clock.now());
			const timerId = j.claimDueTimers({ limit: 1 })[0]?.timerId ?? "";
			// The caller knows when the work actually completed; the journal's
			// clock only knows when it was told.
			expect(j.markTimerFired(timerId, "2026-07-27T12:00:05.000Z")).toBe(true);
		} finally {
			j.close();
		}
	});

	it("orders due timers by due time, then id", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			const base = Date.parse(clock.now());
			await j.commit({
				streamId: "s1",
				events: [{ type: "a.A", data: {} }],
				append: { expectedSeq: 0, actor, tenant: "t" },
				effects: [3, 1, 2].map((n) => ({
					kind: "timer",
					timerKind: "reminder",
					subjectId: `subj${n}`,
					idempotencyKey: `k${n}`,
					dueAt: new Date(base - n * 1000).toISOString(),
					payload: {},
				})),
			} as never);
			const due = j.claimDueTimers({ limit: 10 });
			// Oldest first: a queue that fired newest-first would starve the
			// timer that has been waiting longest.
			const dueTimes = due.map((timer) => Date.parse(timer.dueAt));
			expect([...dueTimes].sort((a, b) => a - b)).toEqual(dueTimes);
		} finally {
			j.close();
		}
	});

	it("dedups a timer scheduled twice with the same idempotency key", async () => {
		const clock = movableClock();
		const j = journal(clock);
		try {
			await withTimer(j, clock.now(), "same-key");
			await j.commit({
				streamId: "s1",
				events: [{ type: "a.B", data: {} }],
				append: { expectedSeq: 1, actor, tenant: "t" },
				effects: [
					{
						kind: "timer",
						timerKind: "reminder",
						subjectId: "subj",
						idempotencyKey: "same-key",
						dueAt: clock.now(),
						payload: {},
					},
				],
			} as never);
			// A retried command must not schedule the effect twice — that is what
			// makes the commit-plus-effects call safe to retry at all.
			expect(j.claimDueTimers({ limit: 10 })).toHaveLength(1);
		} finally {
			j.close();
		}
	});
});
