import assert from "node:assert/strict";
import { test } from "vitest";

import { createRuntimeLocalEventStore } from "../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import {
  createLocalActorHost,
  createManualClock,
  LeaseConflictError,
  StaleFenceError,
} from "../src/actor-host-runtime-port.js";
import { ACTOR_STREAM_PREFIX } from "../src/local-actor-host.js";

function counterFold(state: { value: number }, event: { type: string; amount?: number }) {
  if (event.type === "counter.Added") {
    return { value: state.value + (event.amount ?? 0) };
  }
  return state;
}

test("createLocalActorHost keeps one writer per key and rejects stale-fence appends after expiry", async () => {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const eventStore = createRuntimeLocalEventStore({
    clock: { now: () => clock.now(), advance: (ms: number) => clock.advance(ms) },
  });
  const host = createLocalActorHost({ clock, eventStore, leaseTtlMs: 100 });
  const state = host.state("actor:counter:alpha", {
    initialState: { value: 0 },
    fold: counterFold,
  });

  const firstLease = await host.acquire("actor:counter:alpha", { holderId: "worker-a" });

  await assert.rejects(
    () => host.acquire("actor:counter:alpha", { holderId: "worker-b" }),
    LeaseConflictError,
  );

  await state.append(firstLease, { type: "counter.Added", amount: 1 });
  clock.advance(101);

  const secondLease = await host.acquire("actor:counter:alpha", { holderId: "worker-b" });

  assert.equal(secondLease.fenceToken, firstLease.fenceToken + 1n);
  await assert.rejects(
    () => state.append(firstLease, { type: "counter.Added", amount: 100 }),
    StaleFenceError,
  );

  await state.append(secondLease, { type: "counter.Added", amount: 2 });

  assert.deepEqual((await state.read()).state, { value: 3 });
});

test("createLocalActorHost passivates with snapshot and reactivates by replaying tail", async () => {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const eventStore = createRuntimeLocalEventStore({
    clock: { now: () => clock.now(), advance: (ms: number) => clock.advance(ms) },
  });
  const host = createLocalActorHost({ clock, eventStore, leaseTtlMs: 1_000 });
  const key = "actor:counter:beta";
  const firstActivation = host.state(key, {
    initialState: { value: 0 },
    fold: counterFold,
  });
  const firstLease = await host.acquire(key, { holderId: "worker-a" });

  await firstActivation.append(firstLease, { type: "counter.Added", amount: 1 });
  await firstActivation.append(firstLease, { type: "counter.Added", amount: 2 });

  const snapshot = await firstActivation.passivate(firstLease);

  assert.equal(snapshot.snapshotSeq, 3);
  assert.deepEqual(snapshot.state, { value: 3 });
  await assert.rejects(
    () => firstActivation.append(firstLease, { type: "counter.Added", amount: 100 }),
    /expired lease|stale fence/i,
  );

  const secondLease = await host.acquire(key, { holderId: "worker-b" });
  const reactivated = host.state(key, {
    initialState: { value: 0 },
    fold: counterFold,
  });

  assert.deepEqual(await reactivated.read(), {
    streamId: key,
    seq: 5,
    state: { value: 3 },
    activatedFromSnapshotSeq: 3,
    replayedEventCount: 0,
  });

  await reactivated.append(secondLease, { type: "counter.Added", amount: 4 });

  const tailReplay = host.state(key, {
    initialState: { value: 0 },
    fold: counterFold,
  }).read();

  assert.deepEqual((await tailReplay).state, { value: 7 });
  assert.equal((await tailReplay).activatedFromSnapshotSeq, 3);
  assert.equal((await tailReplay).replayedEventCount, 1);
});

test("createLocalActorHost records lifecycle events on actor stream", async () => {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const eventStore = createRuntimeLocalEventStore({
    clock: { now: () => clock.now(), advance: (ms: number) => clock.advance(ms) },
  });
  const host = createLocalActorHost({ clock, eventStore });
  const key = "actor:counter:gamma";
  const state = host.state(key, { initialState: { value: 0 }, fold: counterFold });
  const lease = await host.acquire(key, { holderId: "worker-a" });
  await state.append(lease, { type: "counter.Added", amount: 1 });
  await state.passivate(lease);

  const events = await eventStore.read(`${ACTOR_STREAM_PREFIX}${key}`);
  assert.deepEqual(
    events.map((event) => event.type),
    ["actor.Activated", "actor.StateAppended", "actor.Passivated"],
  );
});
