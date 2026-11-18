import { describe, expect, it } from "vitest";

import {
	createInMemoryActorHost,
	createManualActorClock,
	LeaseConflictError,
	LeaseExpiredError,
	StaleFenceError,
} from "../src/actor-host/in-memory.js";

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
		const clock = createManualActorClock();
		expect(clock.advance(0)).toBe(clock.now());
	});

	it("refuses to move backwards or by a fraction", () => {
		const clock = createManualActorClock();
		for (const delta of [-1, 0.5, Number.NaN]) {
			expect(() => clock.advance(delta)).toThrow(/non-negative integer/);
		}
	});

	it("refuses an unparseable start instant", () => {
		expect(() => createManualActorClock("soon")).toThrow(/startInstant/);
	});

	it("is frozen so a caller cannot substitute its methods", () => {
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
		const { port } = host();
		port.acquire("actor:a", { holderId: "worker-1" });
		expect(() => port.acquire("actor:a", { holderId: "worker-1" })).toThrow(
			LeaseConflictError,
		);
	});

	it("grants a lease on a different key while one is held", () => {
		const { port } = host();
		port.acquire("actor:a", { holderId: "worker-1" });
		expect(port.acquire("actor:b", { holderId: "worker-2" }).key).toBe(
			"actor:b",
		);
	});

	it("grants a lease once the previous one has expired", () => {
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
		const { port } = host();
		expect(() => port.acquire("", { holderId: "w" })).toThrow(/key/);
		expect(() => port.acquire("actor:a", { holderId: "" })).toThrow(/holderId/);
	});

	it("refuses a non-positive lease TTL at construction", () => {
		for (const ttl of [0, -1, 1.5]) {
			expect(() => createInMemoryActorHost({ leaseTtlMs: ttl })).toThrow(
				/leaseTtlMs/,
			);
		}
	});
});

describe("renew", () => {
	it("extends the lease from the current time", () => {
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
		const { port, clock } = host({ leaseTtlMs: 1_000 });
		const lease = port.acquire("actor:a", { holderId: "w" });
		clock.advance(1_000);
		expect(() => lease.renew()).toThrow(LeaseExpiredError);
	});

	it("refuses to renew a lease another holder has taken over", () => {
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
		const { port } = host();
		const lease = port.acquire("actor:a", { holderId: "w" });
		expect(() => {
			lease.release();
			lease.release();
		}).not.toThrow();
	});

	it("does not release a lease another holder now owns", () => {
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
		const { state, lease, clock } = withLease({ leaseTtlMs: 1_000 });
		clock.advance(1_000);
		expect(() => state.append(lease, { type: "incremented" })).toThrow(
			LeaseExpiredError,
		);
	});

	it("refuses an append from a fenced-out holder", () => {
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
		const { port } = host();
		const other = port.acquire("actor:b", { holderId: "w" });
		port.acquire("actor:a", { holderId: "w" });
		expect(() =>
			port.state("actor:a", counter).append(other, { type: "incremented" }),
		).toThrow(/lease key mismatch/);
	});

	it("refuses an event that is not an object, or has no type", () => {
		const { state, lease } = withLease();
		for (const event of [null, "incremented", [], 7] as unknown[]) {
			expect(() => state.append(lease, event as { type: string })).toThrow(
				/event must be an object/,
			);
		}
		expect(() => state.append(lease, { type: "" })).toThrow(/event\.type/);
	});

	it("copies the event so a caller cannot rewrite an appended record", () => {
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
		const { port } = host();
		const lease = port.acquire("actor:a", { holderId: "w" });
		port.state("actor:a", counter).append(lease, { type: "incremented" });
		expect(port.state("actor:a", counter).read().state.count).toBe(1);
	});

	it("refuses a state handle with no key, no fold, or no initial state", () => {
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
