import { expect, it, vi } from "vitest";
import {
	createInMemoryActorHost,
	createManualActorClock,
} from "../src/actor-host/in-memory.js";

it("snapshots on passivation and folds only later events on reactivation", () => {
	const host = createInMemoryActorHost();
	const fold = vi.fn((state: { count: number }, event: { type: string }) =>
		event.type === "incremented" ? { count: state.count + 1 } : state,
	);
	const first = host.state("counter", { initialState: { count: 0 }, fold });
	const lease = host.acquire("counter", { holderId: "first" });
	first.append(lease, { type: "incremented" });
	first.append(lease, { type: "incremented" });
	if (!first.passivate) throw new Error("snapshot passivation missing");
	const snapshot = first.passivate(lease);
	expect(snapshot).toEqual({
		streamId: "counter",
		seq: 2,
		state: { count: 2 },
	});
	snapshot.state.count = 100;
	fold.mockClear();
	const next = host.state("counter", { initialState: { count: 0 }, fold });
	const nextLease = host.acquire("counter", { holderId: "second" });
	expect(next.read().state).toEqual({ count: 2 });
	expect(fold).not.toHaveBeenCalled();
	next.append(nextLease, { type: "incremented" });
	expect(next.read().state).toEqual({ count: 3 });
	expect(fold).toHaveBeenCalledTimes(1);
});

it("replays from the initial state when the fold or initial state changes", () => {
	const host = createInMemoryActorHost();
	const fold = (state: number, event: { type: string }) =>
		event.type === "incremented" ? state + 1 : state;
	const first = host.state("counter", { initialState: 0, fold });
	const lease = host.acquire("counter", { holderId: "first" });
	first.append(lease, { type: "incremented" });
	if (!first.passivate) throw new Error("snapshot passivation missing");
	first.passivate(lease);
	expect(host.state("counter", { initialState: 10, fold }).read().state).toBe(
		11,
	);
	expect(
		host
			.state("counter", {
				initialState: 0,
				fold: (state, event) =>
					event.type === "incremented" ? state + 2 : state,
			})
			.read().state,
	).toBe(2);
});

it("restores a null snapshot without replaying its events", () => {
	const host = createInMemoryActorHost();
	const fold = vi.fn((_state: string | null) => null);
	function initialState(): string | null {
		return "initial";
	}
	const request = { initialState: initialState(), fold };
	const state = host.state("nullable", request);
	const lease = host.acquire("nullable", { holderId: "first" });
	state.append(lease, { type: "cleared" });
	if (!state.passivate) throw new Error("snapshot passivation missing");
	state.passivate(lease);
	fold.mockClear();
	expect(host.state("nullable", request).read().state).toBeNull();
	expect(fold).not.toHaveBeenCalled();
});

it("does not snapshot or release an expired lease", () => {
	const clock = createManualActorClock();
	const host = createInMemoryActorHost({ clock, leaseTtlMs: 10 });
	const state = host.state("counter", {
		initialState: 0,
		fold: (value) => value + 1,
	});
	const lease = host.acquire("counter", { holderId: "first" });
	state.append(lease, { type: "incremented" });
	clock.advance(10);
	if (!state.passivate) throw new Error("snapshot passivation missing");
	expect(() => state.passivate?.(lease)).toThrow(/expired/);
});

it("does not publish a snapshot if the lease is released during folding", () => {
	const host = createInMemoryActorHost();
	const lease = host.acquire("counter", { holderId: "first" });
	let releaseDuringFold = true;
	const fold = vi.fn((value: number) => {
		if (releaseDuringFold) lease.release();
		return value + 1;
	});
	const state = host.state("counter", { initialState: 0, fold });
	state.append(lease, { type: "incremented" });
	if (!state.passivate) throw new Error("snapshot passivation missing");
	expect(() => state.passivate?.(lease)).toThrow(/expired/);
	releaseDuringFold = false;
	host.acquire("counter", { holderId: "second" });
	fold.mockClear();
	expect(host.state("counter", { initialState: 0, fold }).read().state).toBe(1);
	expect(fold).toHaveBeenCalledTimes(1);
});
