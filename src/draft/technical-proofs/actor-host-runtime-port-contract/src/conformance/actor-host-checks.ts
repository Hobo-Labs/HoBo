import { createRuntimeLocalEventStore } from "../../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import {
  createInMemoryActorHost,
  createManualClock,
  LeaseConflictError,
  LeaseExpiredError,
  StaleFenceError,
} from "../actor-host-runtime-port.js";
import { ACTOR_STREAM_PREFIX, createLocalActorHost } from "../local-actor-host.js";
import { isJsonObject, type JsonValue } from "../json.js";


export const ACTOR_HOST_CONFORMANCE_VERSION = "hobo.actor-host-runtime-port/v1";

export interface ActorHostConformanceReport {
  contract: string;
  backend: string;
  status: "pass" | "fail";
  checks: ReadonlyArray<{
    checkId: string;
    port: string;
    tag: string;
    status: "pass" | "fail";
  }>;
  failures: ReadonlyArray<{ checkId: string; message: string }>;
}

type ActorHostBackend = ReturnType<typeof createLocalActorHost> | ReturnType<typeof createInMemoryActorHost>;

export function createActorHostConformanceBackend() {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const eventStore = createRuntimeLocalEventStore({
    clock: {
      now: () => clock.now(),
      advance: (deltaMs: number) => clock.advance(deltaMs),
    },
  });
  return Object.freeze({
    name: "runtime-local",
    clock,
    eventStore,
    actorHost: createLocalActorHost({ clock, eventStore, leaseTtlMs: 100 }),
  });
}

export function createBrokenFenceActorHostBackend() {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  return Object.freeze({
    name: "runtime-local",
    clock,
    actorHost: createBrokenFenceActorHost(),
  });
}

export async function runActorHostConformance(
  createBackend: () => { name: string; clock?: ReturnType<typeof createManualClock>; eventStore?: JsonValue; actorHost: ActorHostBackend },
): Promise<ActorHostConformanceReport> {
  const probe = createBackend();
  const checks: ActorHostConformanceReport["checks"][number][] = [];
  const failures: ActorHostConformanceReport["failures"][number][] = [];

  for (const definition of CHECKS) {
    const backend = createBackend();
    let passed = false;
    let message = definition.failureMessage;

    try {
      passed = await definition.run(backend);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    checks.push(
      Object.freeze({
        checkId: definition.checkId,
        port: "ActorHost",
        tag: "local",
        status: passed ? "pass" : "fail",
      }),
    );

    if (!passed) {
      failures.push(Object.freeze({ checkId: definition.checkId, message }));
    }
  }

  return Object.freeze({
    contract: ACTOR_HOST_CONFORMANCE_VERSION,
    backend: probe.name,
    status: failures.length === 0 ? "pass" : "fail",
    checks: Object.freeze(checks),
    failures: Object.freeze(failures),
  });
}

const CHECKS = [
  {
    checkId: "actor-host.single-writer",
    failureMessage: "second acquirer was not refused while lease live",
    run: async (backend: { actorHost: ActorHostBackend }) => {
      const key = "conformance:single-writer";
      const lease = await backend.actorHost.acquire(key, { holderId: "worker-a" });
      try {
        await backend.actorHost.acquire(key, { holderId: "worker-b" });
        return false;
      } catch (error) {
        return error instanceof LeaseConflictError && lease.fenceToken === 1n;
      }
    },
  },
  {
    checkId: "actor-host.stale-fence-rejected",
    failureMessage: "stale lease append was accepted",
    run: async (backend: { actorHost: ActorHostBackend; clock?: ReturnType<typeof createManualClock> }) =>
      runDualActivationFixture(backend),
  },
  {
    checkId: "actor-host.expired-zombie-rejected",
    failureMessage: "expired zombie append was accepted",
    run: async (backend: { actorHost: ActorHostBackend; clock?: ReturnType<typeof createManualClock> }) => {
      const clock = backend.clock ?? createManualClock();
      const host =
        "clock" in backend && backend.clock
          ? backend.actorHost
          : createInMemoryActorHost({ clock, leaseTtlMs: 50 });
      const state = host.state("conformance:zombie", {
        initialState: { value: 0 },
        fold: counterFold,
      });
      const zombieLease = await host.acquire("conformance:zombie", { holderId: "worker-a" });
      clock.advance(101);
      try {
        await state.append(zombieLease, { type: "counter.Added", amount: 1 });
        return false;
      } catch (error) {
        const projection = await state.read();
        return error instanceof LeaseExpiredError && projection.state.value === 0;
      }
    },
  },
  {
    checkId: "actor-host.renewal-no-new-fence",
    failureMessage: "renewal minted a new fence token",
    run: async (backend: { actorHost: ActorHostBackend; clock?: ReturnType<typeof createManualClock> }) => {
      const clock = backend.clock ?? createManualClock();
      const host = backend.actorHost;
      const state = host.state("conformance:renewal", {
        initialState: { value: 0 },
        fold: counterFold,
      });
      const lease = await host.acquire("conformance:renewal", { holderId: "worker-a" });
      clock.advance(75);
      const renewal = lease.renew();
      clock.advance(75);
      try {
        await host.acquire("conformance:renewal", { holderId: "worker-b" });
        return false;
      } catch (error) {
        if (!(error instanceof LeaseConflictError)) {
          return false;
        }
        await state.append(lease, { type: "counter.Added", amount: 5 });
        const projection = await state.read();
        return renewal.fenceToken === lease.fenceToken && projection.state.value === 5;
      }
    },
  },
  {
    checkId: "actor-host.forged-lease-rejected",
    failureMessage: "forged lease append was accepted",
    run: async (backend: { actorHost: ActorHostBackend }) => {
      const host = backend.actorHost;
      const state = host.state("conformance:forged", {
        initialState: { value: 0 },
        fold: counterFold,
      });
      const lease = await host.acquire("conformance:forged", { holderId: "worker-a" });
      const forgedLease = {
        key: lease.key,
        holderId: lease.holderId,
        fenceToken: lease.fenceToken,
        expiresAt: lease.expiresAt,
        renew() {},
        release() {},
      };
      try {
        await state.append(forgedLease, { type: "counter.Added", amount: 1 });
        return false;
      } catch (error) {
        if (!(error instanceof StaleFenceError)) {
          return false;
        }
        await state.append(lease, { type: "counter.Added", amount: 2 });
        const projection = await state.read();
        return projection.state.value === 2;
      }
    },
  },
  {
    checkId: "actor-host.snapshot-replay-parity",
    failureMessage: "replayed state diverged from live folded state",
    run: async (backend: { actorHost: ActorHostBackend }) => {
      const host = backend.actorHost;
      const key = "conformance:replay";
      const firstActivation = host.state(key, {
        initialState: { value: 0 },
        fold: counterFold,
      });
      const firstLease = await host.acquire(key, { holderId: "worker-a" });
      await firstActivation.append(firstLease, { type: "counter.Added", amount: 1 });
      await firstActivation.append(firstLease, { type: "counter.Added", amount: 2 });
      const live = await firstActivation.read();
      await firstActivation.passivate(firstLease);

      const secondLease = await host.acquire(key, { holderId: "worker-b" });
      const reactivated = host.state(key, {
        initialState: { value: 0 },
        fold: counterFold,
      });
      const replayed = await reactivated.read();
      await reactivated.append(secondLease, { type: "counter.Added", amount: 4 });
      const tailReplay = host.state(key, {
        initialState: { value: 0 },
        fold: counterFold,
      });
      const tail = await tailReplay.read();

      return (
        replayed.state.value === live.state.value &&
        replayed.replayedEventCount === 0 &&
        tail.state.value === 7 &&
        tail.replayedEventCount === 1
      );
    },
  },
] as const;

export async function runDualActivationFixture(backend: {
  actorHost: ActorHostBackend;
  clock?: ReturnType<typeof createManualClock>;
  eventStore?: { read: (streamId: string) => Promise<unknown[]> };
}) {
  const clock = backend.clock ?? createManualClock("2026-06-25T12:00:00.000Z");
  const host = backend.actorHost;
  const key = "conformance:dual-activation";
  const streamId = `${ACTOR_STREAM_PREFIX}${key}`;
  const state = host.state(key, {
    initialState: { value: 0 },
    fold: counterFold,
  });

  const leaseA = await host.acquire(key, { holderId: "worker-a" });
  clock.advance(101);
  const leaseB = await host.acquire(key, { holderId: "worker-b" });

  if (leaseB.fenceToken !== leaseA.fenceToken + 1n) {
    return false;
  }

  try {
    await state.append(leaseA, { type: "counter.Added", amount: 100 });
    return false;
  } catch (error) {
    if (!(error instanceof StaleFenceError || error instanceof LeaseExpiredError)) {
      return false;
    }
  }

  await state.append(leaseB, { type: "counter.Added", amount: 2 });
  const projection = await state.read();
  if (projection.state.value !== 2) {
    return false;
  }

  if (backend.eventStore) {
    const events = await backend.eventStore.read(streamId);
    const domainEvents = events.filter(
      (event: { type: string }) => event.type === "actor.StateAppended",
    );
    return domainEvents.length === 1;
  }

  return true;
}

function counterFold(state: { value: number }, event: { type: string; amount?: number }) {
  if (event.type === "counter.Added") {
    return { value: state.value + (event.amount ?? 0) };
  }
  return state;
}

interface BrokenLease {
  fenceToken?: bigint;
  release(): void;
}

function createBrokenFenceActorHost() {
  const streams = new Map<string, { events: JsonValue[] }>();
  const leases = new Map<string, BrokenLease>();

  return Object.freeze({
    async acquire(key: string, request: { holderId: string }) {
      const prior = leases.get(key);
      const lease = Object.freeze({
        key,
        holderId: request.holderId,
        fenceToken: (prior?.fenceToken ?? 0n) + 1n,
        expiresAt: "9999-12-31T23:59:59.999Z",
        renew() {
          return this;
        },
        release() {},
      });
      leases.set(key, lease);
      return lease;
    },

    state(key: string, request: { initialState: JsonValue; fold: (state: JsonValue, event: JsonValue) => JsonValue }) {
      const stream = getBrokenStream(streams, key);
      const initialState = structuredClone(request.initialState);

      return Object.freeze({
        async append(_lease: BrokenLease, event: JsonValue) {
          const record = Object.freeze({
            ...(isJsonObject(event) ? event : { value: event }),
            streamId: key,
            seq: stream.events.length + 1,
          });
          stream.events.push(record);
          return Object.freeze({
            streamId: key,
            seq: record.seq,
            fenceToken: _lease.fenceToken,
          });
        },
        async read() {
          let state = structuredClone(initialState);
          for (const event of stream.events) {
            state = request.fold(state, structuredClone(event));
          }
          return Object.freeze({
            streamId: key,
            seq: stream.events.length,
            state,
            activatedFromSnapshotSeq: 0,
            replayedEventCount: stream.events.length,
          });
        },
        async passivate() {
          return this.read();
        },
      });
    },
  });
}

function getBrokenStream(streams: Map<string, { events: JsonValue[] }>, key: string) {
  if (!streams.has(key)) {
    streams.set(key, { events: [] });
  }
  return streams.get(key)!;
}
