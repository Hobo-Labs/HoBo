/**
 * The in-memory actor host — leases, fencing, and event-sourced state.
 *
 * A single-writer guarantee is the whole product of an actor host: exactly one
 * holder may append to an actor's stream at a time. That guarantee is
 * enforced three ways, and each one exists because the others are not enough
 * on their own.
 *
 * **A live lease blocks acquisition.** Two holders appending concurrently is
 * the failure the host exists to prevent, so `acquire` refuses while a lease
 * is unexpired and unreleased — and the refusal names who holds it and until
 * when, because the caller's next move differs depending on whether the holder
 * is a live peer or a crashed one.
 *
 * **A fence token monotonically increases across handovers.** After a holder
 * is presumed dead and its lease taken over, the old holder may still be alive
 * and about to append. The fence is what makes that append fail: it carries a
 * token the host has already moved past.
 *
 * **Expiry is checked at append, not only at acquire.** A holder that took a
 * lease and then stalled past its TTL is no longer the writer, whatever it
 * believes. Checking only at acquisition would let a resumed process write
 * behind whoever took over.
 *
 * The clock is manual by construction: a lease host whose tests depend on wall
 * time would either be slow or flaky, and the expiry behaviour is exactly what
 * has to be pinned.
 */
import { describe, expect, it } from "vitest";

import {
	createInMemoryActorHost,
	createManualActorClock,
	LeaseConflictError,
	LeaseExpiredError,
	StaleFenceError,
} from "../src/actor-host/in-memory.js";

/** A host with a clock the test drives. */
function host(options: { leaseTtlMs?: number; start?: string } = {}) {
	const clock = createManualActorClock(options.start);
	return {
		clock,
		port: createInMemoryActorHost({
			clock,
			...(options.leaseTtlMs !== undefined
				? { leaseTtlMs: options.leaseTtlMs }
				: {}),
		}),
	};
}

/** A counter fold, for state tests. */
const counter = {
	initialState: { count: 0 },
	fold: (state: { count: number }, event: { type: string }) =>
		event.type === "incremented" ? { count: state.count + 1 } : state,
};

describe("createManualActorClock", () => {
	it("starts at the documented default and reports both forms", () => {
		const clock = createManualActorClock();
		expect(clock.now()).toBe("2026-06-25T00:00:00.000Z");
		expect(clock.nowMs()).toBe(Date.parse("2026-06-25T00:00:00.000Z"));
	});

	it("advances by whole milliseconds and returns the new instant", () => {
		const clock = createManualActorClock("2026-01-01T00:00:00.000Z");
		expect(clock.advance(1_500)).toBe("2026-01-01T00:00:01.500Z");
		expect(clock.nowMs()).toBe(Date.parse("2026-01-01T00:00:01.500Z"));
	});

	it("allows a zero advance", () => {
		// Advancing by zero is a legitimate no-op in a test that wants to assert
		// nothing changed at the boundary.
		const clock = createManualActorClock();
		expect(clock.advance(0)).toBe(clock.now());
	});

	it("refuses to move backwards or by a fraction", () => {
		// A clock that could go backwards would let an expired lease become live
		// again — the fence would be the only thing left holding the guarantee.
		const clock = createManualActorClock();
		for (const delta of [-1, 0.5, Number.NaN]) {
			expect(() => clock.advance(delta)).toThrow(/non-negative integer/);
		}
	});

	it("refuses an unparseable start instant", () => {
		expect(() => createManualActorClock("soon")).toThrow(/startInstant/);
	});

	it("is frozen so a caller cannot substitute its methods", () => {
		// The clock is the determinism anchor. A caller replacing `nowMs` would
		// break expiry for every lease in the host at once.
		expect(Object.isFrozen(createManualActorClock())).toBe(true);
	});
});

describe("acquire", () => {
	it("grants a lease naming the key, holder, and expiry", () => {
		const { port, clock } = host({ leaseTtlMs: 30_000 });
		const lease = port.acquire("actor:a", { holderId: "worker-1" });
		expect(lease.key).toBe("actor:a");
		expect(lease.holderId).toBe("worker-1");
		expect(lease.fenceToken).toBe(1n);
		expect(lease.expiresAt).toBe(
			new Date(clock.nowMs() + 30_000).toISOString(),
		);
	});

	it("refuses while another holder's lease is live, naming holder and expiry", () => {
		// The caller's next move differs depending on whether the holder is a
		// live peer (back off) or one it is waiting out (retry after expiry).
		// Both facts have to be in the message.
		const { port } = host();
		port.acquire("actor:a", { holderId: "worker-1" });
		expect(() => port.acquire("actor:a", { holderId: "worker-2" })).toThrow(
			LeaseConflictError,
		);
		expect(() => port.acquire("actor:a", { holderId: "worker-2" })).toThrow(
			/held by worker-1 until/,
		);
	});

	it("refuses a re-acquire by the same holder", () => {
		// Even the same worker must not hold two leases: the second would bump
		// the fence and invalidate the first, which the worker is still using.
		const { port } = host();
		port.acquire("actor:a", { holderId: "worker-1" });
		expect(() => port.acquire("actor:a", { holderId: "worker-1" })).toThrow(
			LeaseConflictError,
		);
	});

	it("grants a lease on a different key while one is held", () => {
		// Actors are independent. Serializing across keys would make the host a
		// global lock.
		const { port } = host();
		port.acquire("actor:a", { holderId: "worker-1" });
		expect(port.acquire("actor:b", { holderId: "worker-2" }).key).toBe(
			"actor:b",
		);
	});

	it("grants a lease once the previous one has expired", () => {
		// This is the recovery path for a crashed holder — without it a dead
		// worker would strand its actor permanently.
		const { port, clock } = host({ leaseTtlMs: 1_000 });
		port.acquire("actor:a", { holderId: "worker-1" });
		clock.advance(1_000);
		expect(port.acquire("actor:a", { holderId: "worker-2" }).holderId).toBe(
			"worker-2",
		);
	});

	it("grants a lease immediately after release", () => {
		const { port } = host();
		port.acquire("actor:a", { holderId: "worker-1" }).release();
		expect(port.acquire("actor:a", { holderId: "worker-2" }).fenceToken).toBe(
			2n,
		);
	});

	it("increases the fence token on every handover", () => {
		// The fence is what makes a resurrected holder's append fail. A reused
		// token would let it write behind whoever took over.
		const { port } = host();
		const tokens: bigint[] = [];
		for (let i = 0; i < 3; i += 1) {
			const lease = port.acquire("actor:a", { holderId: `w-${i}` });
			tokens.push(lease.fenceToken);
			lease.release();
		}
		expect(tokens).toEqual([1n, 2n, 3n]);
	});

	it("refuses an empty key or holder id", () => {
		// An unnamed actor would collect appends nobody can address; an unnamed
		// holder makes the conflict message useless.
		const { port } = host();
		expect(() => port.acquire("", { holderId: "w" })).toThrow(/key/);
		expect(() => port.acquire("actor:a", { holderId: "" })).toThrow(/holderId/);
	});

	it("refuses a non-positive lease TTL at construction", () => {
		// A zero TTL would expire every lease the instant it was granted,
		// turning the single-writer guarantee off entirely.
		for (const ttl of [0, -1, 1.5]) {
			expect(() => createInMemoryActorHost({ leaseTtlMs: ttl })).toThrow(
				/leaseTtlMs/,
			);
		}
	});
});

describe("renew", () => {
	it("extends the lease from the current time", () => {
		// Renewal is relative to now, not to the original grant — otherwise a
		// holder that renewed late would get a shorter extension than asked for.
		const { port, clock } = host({ leaseTtlMs: 1_000 });
		const lease = port.acquire("actor:a", { holderId: "w" });
		clock.advance(500);
		lease.renew();
		expect(lease.expiresAt).toBe(new Date(clock.nowMs() + 1_000).toISOString());
	});

	it("returns the same lease so a caller can chain", () => {
		const { port } = host();
		const lease = port.acquire("actor:a", { holderId: "w" });
		expect(lease.renew()).toBe(lease);
	});

	it("refuses to renew an expired lease", () => {
		// A holder that stalled past its TTL is no longer the writer, whatever
		// it believes. Renewing would hand the guarantee back to a process
		// another holder may already have replaced.
		const { port, clock } = host({ leaseTtlMs: 1_000 });
		const lease = port.acquire("actor:a", { holderId: "w" });
		clock.advance(1_000);
		expect(() => lease.renew()).toThrow(LeaseExpiredError);
	});

	it("refuses to renew a lease another holder has taken over", () => {
		// The fence has moved past this lease. Renewing it would resurrect a
		// writer the host has already replaced.
		const { port, clock } = host({ leaseTtlMs: 1_000 });
		const first = port.acquire("actor:a", { holderId: "w-1" });
		clock.advance(1_000);
		port.acquire("actor:a", { holderId: "w-2" });
		expect(() => first.renew()).toThrow(StaleFenceError);
	});

	it("refuses to renew after release", () => {
		const { port } = host();
		const lease = port.acquire("actor:a", { holderId: "w" });
		lease.release();
		port.acquire("actor:a", { holderId: "w-2" });
		expect(() => lease.renew()).toThrow(StaleFenceError);
	});
});

describe("release", () => {
	it("frees the actor for the next holder", () => {
		const { port } = host();
		port.acquire("actor:a", { holderId: "w-1" }).release();
		expect(() => port.acquire("actor:a", { holderId: "w-2" })).not.toThrow();
	});

	it("is idempotent", () => {
		// Release runs from teardown paths that cannot know whether it already
		// happened. Throwing there would mask the error being unwound from.
		const { port } = host();
		const lease = port.acquire("actor:a", { holderId: "w" });
		expect(() => {
			lease.release();
			lease.release();
		}).not.toThrow();
	});

	it("does not release a lease another holder now owns", () => {
		// A late release from a replaced holder must not free the actor out from
		// under its current writer — that would be a single-writer violation
		// caused by the cleanup path itself.
		const { port, clock } = host({ leaseTtlMs: 1_000 });
		const first = port.acquire("actor:a", { holderId: "w-1" });
		clock.advance(1_000);
		port.acquire("actor:a", { holderId: "w-2" });
		first.release();
		expect(() => port.acquire("actor:a", { holderId: "w-3" })).toThrow(
			LeaseConflictError,
		);
	});
});

describe("state — append", () => {
	function withLease(options: { leaseTtlMs?: number } = {}) {
		const h = host(options);
		const lease = h.port.acquire("actor:a", { holderId: "w" });
		return { ...h, lease, state: h.port.state("actor:a", counter) };
	}

	it("appends under the lease's fence and holder", () => {
		// Every record carries who wrote it and under which fence, which is what
		// makes a stream auditable after a handover.
		const { state, lease } = withLease();
		const result = state.append(lease, { type: "incremented" });
		expect(result).toEqual({
			streamId: "actor:a",
			seq: 1,
			fenceToken: lease.fenceToken,
		});
	});

	it("numbers appends from one, in order", () => {
		const { state, lease } = withLease();
		expect(state.append(lease, { type: "incremented" }).seq).toBe(1);
		expect(state.append(lease, { type: "incremented" }).seq).toBe(2);
	});

	it("refuses an append under an expired lease", () => {
		// Checking only at acquire would let a resumed process write behind
		// whoever took over while it was stalled.
		const { state, lease, clock } = withLease({ leaseTtlMs: 1_000 });
		clock.advance(1_000);
		expect(() => state.append(lease, { type: "incremented" })).toThrow(
			LeaseExpiredError,
		);
	});

	it("refuses an append from a fenced-out holder", () => {
		// The resurrected-holder case. Its token is behind the host's, and that
		// is exactly what the fence is for.
		const { state, lease, clock, port } = withLease({ leaseTtlMs: 1_000 });
		clock.advance(1_000);
		port.acquire("actor:a", { holderId: "w-2" });
		expect(() => state.append(lease, { type: "incremented" })).toThrow(
			StaleFenceError,
		);
	});

	it("refuses an append under a released lease", () => {
		const { state, lease } = withLease();
		lease.release();
		expect(() => state.append(lease, { type: "incremented" })).toThrow(
			LeaseExpiredError,
		);
	});

	it("refuses a lease belonging to a different actor", () => {
		// A caller holding two leases could otherwise write one actor's events
		// into the other's stream — a corruption no later read could detect.
		const { port } = host();
		const other = port.acquire("actor:b", { holderId: "w" });
		port.acquire("actor:a", { holderId: "w" });
		expect(() =>
			port.state("actor:a", counter).append(other, { type: "incremented" }),
		).toThrow(/lease key mismatch/);
	});

	it("refuses an event that is not an object, or has no type", () => {
		// The type is what the fold dispatches on. An event without one would
		// be folded as an unknown and silently ignored on every replay.
		const { state, lease } = withLease();
		for (const event of [null, "incremented", [], 7] as unknown[]) {
			expect(() => state.append(lease, event as { type: string })).toThrow(
				/event must be an object/,
			);
		}
		expect(() => state.append(lease, { type: "" })).toThrow(/event\.type/);
	});

	it("copies the event so a caller cannot rewrite an appended record", () => {
		// The stream is the durable record. A caller mutating the object it
		// appended would rewrite history after the fact.
		const { state, lease } = withLease();
		const event = { type: "incremented", payload: { n: 1 } };
		state.append(lease, event);
		event.payload.n = 99;
		expect(state.read().state.count).toBe(1);
	});
});

describe("state — read", () => {
	function withLease() {
		const h = host();
		const lease = h.port.acquire("actor:a", { holderId: "w" });
		return { ...h, lease, state: h.port.state("actor:a", counter) };
	}

	it("returns the initial state for an empty stream", () => {
		const { state } = withLease();
		expect(state.read()).toEqual({
			streamId: "actor:a",
			seq: 0,
			state: { count: 0 },
		});
	});

	it("folds every appended event", () => {
		const { state, lease } = withLease();
		state.append(lease, { type: "incremented" });
		state.append(lease, { type: "ignored" });
		state.append(lease, { type: "incremented" });
		expect(state.read()).toEqual({
			streamId: "actor:a",
			seq: 3,
			state: { count: 2 },
		});
	});

	it("copies the initial state so two handles do not share it", () => {
		// A fold that mutates its input would otherwise corrupt the caller's
		// declared initial state for every later read.
		const initial = { count: 0 };
		const { port, lease } = (() => {
			const h = host();
			return { ...h, lease: h.port.acquire("actor:a", { holderId: "w" }) };
		})();
		const state = port.state("actor:a", { ...counter, initialState: initial });
		state.append(lease, { type: "incremented" });
		state.read();
		expect(initial.count).toBe(0);
	});

	it("keeps separate streams for separate actors", () => {
		const { port } = host();
		const a = port.acquire("actor:a", { holderId: "w" });
		const b = port.acquire("actor:b", { holderId: "w" });
		port.state("actor:a", counter).append(a, { type: "incremented" });
		port.state("actor:b", counter).append(b, { type: "incremented" });
		expect(port.state("actor:a", counter).read().seq).toBe(1);
		expect(port.state("actor:b", counter).read().seq).toBe(1);
	});

	it("shares one stream across two handles for the same actor", () => {
		// Two callers asking for the same actor's state must see one history —
		// separate streams would each fold half the events.
		const { port } = host();
		const lease = port.acquire("actor:a", { holderId: "w" });
		port.state("actor:a", counter).append(lease, { type: "incremented" });
		expect(port.state("actor:a", counter).read().state.count).toBe(1);
	});

	it("refuses a state handle with no key, no fold, or no initial state", () => {
		// Each missing piece produces a different silent wrong answer: an
		// unnamed stream, a fold that cannot run, or a replay that starts from
		// `undefined`.
		const { port } = host();
		expect(() => port.state("", counter)).toThrow(/key/);
		expect(() =>
			port.state("actor:a", { initialState: {}, fold: undefined as never }),
		).toThrow(/fold/);
		expect(() =>
			port.state("actor:a", { fold: counter.fold } as never),
		).toThrow(/initialState/);
	});
});
