/**
 * Runnable example for actor-host-runtime-port-contract. The draft-artifact gate
 * EXECUTES this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Proves HOBO-21: the ActorHost runtime port keeps ONE writer per actor key via
 * fencing-token leases — a live lease blocks rival acquires, an expired holder's
 * appends are rejected as stale, and passivation snapshots state so reactivation
 * replays only the tail. Deterministic manual clock.
 */
import { strict as assert } from "node:assert";

import {
	createInMemoryActorHost,
	createManualClock,
	LeaseConflictError,
	StaleFenceError,
} from "../src/actor-host-runtime-port.ts";

type CounterState = { value: number };
type CounterEvent = { type: string; amount?: number };

function counterFold(state: CounterState, event: CounterEvent): CounterState {
	if (event.type === "counter.Added") {
		return { value: state.value + (event.amount ?? 0) };
	}
	return state;
}

const clock = createManualClock("2026-06-25T12:00:00.000Z");
const host = createInMemoryActorHost({ clock, leaseTtlMs: 100 });
const key = "actor:counter:alpha";
const state = host.state(key, { initialState: { value: 0 }, fold: counterFold });

// 1) Single-writer: worker-a holds the lease; worker-b's acquire conflicts.
const leaseA = host.acquire(key, { holderId: "worker-a" });
console.log(`leaseA: holder=${leaseA.holderId} fence=${leaseA.fenceToken}`);
assert.throws(() => host.acquire(key, { holderId: "worker-b" }), LeaseConflictError);
console.log("worker-b acquire while leaseA live: LeaseConflictError");

state.append(leaseA, { type: "counter.Added", amount: 1 });

// 2) After TTL expiry, worker-b takes over with a HIGHER fence token.
clock.advance(101);
const leaseB = host.acquire(key, { holderId: "worker-b" });
assert.equal(leaseB.fenceToken, leaseA.fenceToken + 1n);
console.log(`leaseB: holder=${leaseB.holderId} fence=${leaseB.fenceToken}`);

// 3) The zombie holder's append is fenced out; the new holder's lands.
assert.throws(() => state.append(leaseA, { type: "counter.Added", amount: 100 }), StaleFenceError);
console.log("zombie worker-a append: StaleFenceError");
state.append(leaseB, { type: "counter.Added", amount: 2 });
const projected = state.read();
assert.deepEqual(projected.state, { value: 3 });
console.log(`state after fenced appends: value=${projected.state.value} seq=${projected.seq}`);

// 4) Passivate snapshots; reactivation replays only the tail past the snapshot.
const snapshot = state.passivate(leaseB);
assert.equal(snapshot.snapshotSeq, 2);
console.log(`passivated: snapshotSeq=${snapshot.snapshotSeq} state=${snapshot.state.value}`);

const leaseC = host.acquire(key, { holderId: "worker-c" });
const reactivated = host.state(key, { initialState: { value: 0 }, fold: counterFold });
const activation = reactivated.read();
assert.equal(activation.activatedFromSnapshotSeq, 2);
assert.equal(activation.replayedEventCount, 0);
console.log(
	`reactivated: fromSnapshotSeq=${activation.activatedFromSnapshotSeq} replayed=${activation.replayedEventCount} state=${activation.state.value}`,
);

reactivated.append(leaseC, { type: "counter.Added", amount: 4 });
const final = reactivated.read();
assert.deepEqual(final.state, { value: 7 });
assert.equal(final.replayedEventCount, 1);
console.log(`tail replay: state=${final.state.value} replayed=${final.replayedEventCount}`);

console.log("CONTRACT HELD: fenced single-writer leases + snapshot/tail-replay activation");
