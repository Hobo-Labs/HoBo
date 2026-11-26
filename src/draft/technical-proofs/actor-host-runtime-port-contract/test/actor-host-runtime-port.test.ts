import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createInMemoryActorHost,
  createManualClock,
} from "../src/actor-host-runtime-port.js";

function counterFold(state, event) {
  if (event.type === "counter.Added") {
    return { value: state.value + event.amount };
  }
  return state;
}

test("ActorHost keeps one writer per key and rejects stale-fence appends after expiry", () => {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const host = createInMemoryActorHost({ clock, leaseTtlMs: 100 });
  const state = host.state("actor:counter:alpha", {
    initialState: { value: 0 },
    fold: counterFold,
  });

  const firstLease = host.acquire("actor:counter:alpha", { holderId: "worker-a" });

  assert.throws(
    () => host.acquire("actor:counter:alpha", { holderId: "worker-b" }),
    /lease conflict/i,
  );

  state.append(firstLease, { type: "counter.Added", amount: 1 });
  clock.advance(101);

  const secondLease = host.acquire("actor:counter:alpha", { holderId: "worker-b" });

  assert.equal(secondLease.fenceToken, firstLease.fenceToken + 1n);
  assert.throws(
    () => state.append(firstLease, { type: "counter.Added", amount: 100 }),
    /stale fence/i,
  );

  state.append(secondLease, { type: "counter.Added", amount: 2 });

  assert.deepEqual(state.read().state, { value: 3 });
});

test("ActorHost passivates with a snapshot and reactivates by replaying the tail", () => {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const host = createInMemoryActorHost({ clock, leaseTtlMs: 1_000 });
  const key = "actor:counter:beta";
  const firstActivation = host.state(key, {
    initialState: { value: 0 },
    fold: counterFold,
  });
  const firstLease = host.acquire(key, { holderId: "worker-a" });

  firstActivation.append(firstLease, { type: "counter.Added", amount: 1 });
  firstActivation.append(firstLease, { type: "counter.Added", amount: 2 });

  const snapshot = firstActivation.passivate(firstLease);

  assert.equal(snapshot.snapshotSeq, 2);
  assert.deepEqual(snapshot.state, { value: 3 });
  assert.throws(
    () => firstActivation.append(firstLease, { type: "counter.Added", amount: 100 }),
    /expired lease|stale fence/i,
  );

  const secondLease = host.acquire(key, { holderId: "worker-b" });
  const reactivated = host.state(key, {
    initialState: { value: 0 },
    fold: counterFold,
  });

  assert.deepEqual(reactivated.read(), {
    streamId: key,
    seq: 2,
    state: { value: 3 },
    activatedFromSnapshotSeq: 2,
    replayedEventCount: 0,
  });

  reactivated.append(secondLease, { type: "counter.Added", amount: 4 });

  const tailReplay = host.state(key, {
    initialState: { value: 0 },
    fold: counterFold,
  }).read();

  assert.deepEqual(tailReplay.state, { value: 7 });
  assert.equal(tailReplay.activatedFromSnapshotSeq, 2);
  assert.equal(tailReplay.replayedEventCount, 1);
});

test("ActorHost rejects an expired zombie writer even before a new fence is issued", () => {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const host = createInMemoryActorHost({ clock, leaseTtlMs: 50 });
  const state = host.state("actor:counter:gamma", {
    initialState: { value: 0 },
    fold: counterFold,
  });
  const zombieLease = host.acquire("actor:counter:gamma", { holderId: "worker-a" });

  clock.advance(51);

  assert.throws(
    () => state.append(zombieLease, { type: "counter.Added", amount: 1 }),
    /expired lease/i,
  );
  assert.deepEqual(state.read().state, { value: 0 });
});

test("ActorHost rejects a forged copy of the current live lease", () => {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const host = createInMemoryActorHost({ clock, leaseTtlMs: 1_000 });
  const state = host.state("actor:counter:forged", {
    initialState: { value: 0 },
    fold: counterFold,
  });
  const lease = host.acquire("actor:counter:forged", { holderId: "worker-a" });
  const forgedLease = {
    key: lease.key,
    holderId: lease.holderId,
    fenceToken: lease.fenceToken,
    expiresAt: lease.expiresAt,
    renew() {},
    release() {},
  };

  assert.throws(
    () => state.append(forgedLease, { type: "counter.Added", amount: 1 }),
    /stale fence/i,
  );

  state.append(lease, { type: "counter.Added", amount: 2 });

  assert.deepEqual(state.read().state, { value: 2 });
});

test("ActorHost does not let holders mutate live lease fencing metadata", () => {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const host = createInMemoryActorHost({ clock, leaseTtlMs: 1_000 });
  const state = host.state("actor:counter:immutable", {
    initialState: { value: 0 },
    fold: counterFold,
  });
  const lease = host.acquire("actor:counter:immutable", { holderId: "worker-a" });

  assert.throws(() => {
    lease.fenceToken = 999n;
  }, TypeError);
  assert.throws(() => {
    lease.holderId = "worker-b";
  }, TypeError);

  const appended = state.append(lease, { type: "counter.Added", amount: 3 });

  assert.equal(appended.fenceToken, 1n);
  assert.deepEqual(state.read().state, { value: 3 });
});

test("ActorHost renewal extends the active lease without minting a second fence", () => {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const host = createInMemoryActorHost({ clock, leaseTtlMs: 100 });
  const state = host.state("actor:counter:delta", {
    initialState: { value: 0 },
    fold: counterFold,
  });
  const lease = host.acquire("actor:counter:delta", { holderId: "worker-a" });

  clock.advance(75);
  const renewal = lease.renew();
  clock.advance(75);

  assert.equal(renewal.fenceToken, lease.fenceToken);
  assert.throws(
    () => host.acquire("actor:counter:delta", { holderId: "worker-b" }),
    /lease conflict/i,
  );

  state.append(lease, { type: "counter.Added", amount: 5 });

  assert.deepEqual(state.read().state, { value: 5 });
});
