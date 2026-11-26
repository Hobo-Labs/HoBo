import { createRuntimeLocalEventStore } from "../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import {
  LeaseConflictError,
  LeaseExpiredError,
  StaleFenceError,
} from "./actor-host-runtime-port.js";
import { createManualClock } from "./actor-host-runtime-port.js";
import { parseActorKey, parseHolderId, type ActorKey, type HolderId } from "./parse.js";
import { isJsonNumber, isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const ACTOR_STREAM_PREFIX = "actor:";

export interface ActorLease {
  key: ActorKey;
  holderId: HolderId;
  fenceToken: bigint;
  readonly expiresAt: string;
  renew(): {
    key: ActorKey;
    holderId: HolderId;
    fenceToken: bigint;
    expiresAt: string;
  };
  release(): void;
}

export interface LocalActorHostOptions {
  clock?: ReturnType<typeof createManualClock>;
  eventStore?: ReturnType<typeof createRuntimeLocalEventStore>;
  leaseTtlMs?: number;
}

export function createLocalActorHost(options: LocalActorHostOptions = {}) {
  const clock = options.clock ?? createManualClock();
  const eventStore =
    options.eventStore ??
    createRuntimeLocalEventStore({
      clock: {
        now: () => clock.now(),
        advance: (deltaMs: number) => clock.advance(deltaMs),
      },
    });
  const leaseTtlMs = requirePositiveInteger(options.leaseTtlMs ?? 30_000, "leaseTtlMs");
  const leases = new Map<string, LeaseRecord>();
  const leaseRecords = new WeakMap<ActorLease, LeaseRecord>();
  const snapshots = new Map<string, SnapshotRecord>();

  return {
    async acquire(key: string, request: { holderId: string }) {
      const actorKey = parseActorKey(key);
      const holderId = parseHolderId(request.holderId);
      const nowMs = clock.nowMs();
      const current = leases.get(actorKey);

      if (current && !current.released && current.expiresAtMs > nowMs) {
        throw new LeaseConflictError(
          `lease conflict for ${actorKey}: held by ${current.holderId} until ${formatInstant(current.expiresAtMs)}`,
        );
      }

      const next: LeaseRecord = {
        key: actorKey,
        holderId,
        fenceToken: (current?.fenceToken ?? 0n) + 1n,
        expiresAtMs: nowMs + leaseTtlMs,
        released: false,
      };
      leases.set(actorKey, next);

      const streamId = actorStreamId(actorKey);
      const events = await eventStore.read(streamId);
      await eventStore.append(
        streamId,
        [
          {
            type: "actor.Activated",
            data: {
              key: actorKey,
              holderId,
              fenceToken: next.fenceToken.toString(),
            },
          },
        ],
        appendOptions(events.length, holderId),
      );

      return createLeaseFacade(next, { clock, leaseTtlMs, leases, leaseRecords });
    },

    state<S>(key: string, request: { initialState: S; fold: (state: S, event: DomainEvent) => S }) {
      const actorKey = parseActorKey(key);
      if (!(request.fold instanceof Function)) {
        throw new TypeError("request.fold must be a function");
      }
      if (!("initialState" in request)) {
        throw new TypeError("request.initialState is required");
      }

      return new EventStoreActorState({
        key: actorKey,
        fold: request.fold,
        initialState: structuredClone(request.initialState),
        streamId: actorStreamId(actorKey),
        eventStore,
        clock,
        snapshots,
        validateLease(lease: ActorLease) {
          return validateLeaseForAppend(leases, leaseRecords, clock, actorKey, lease);
        },
      });
    },
  };
}

interface LeaseRecord {
  key: ActorKey;
  holderId: HolderId;
  fenceToken: bigint;
  expiresAtMs: number;
  released: boolean;
}

interface SnapshotRecord {
  seq: number;
  state: JsonValue;
  savedAt: string;
}

interface DomainEvent {
  type: string;
  [key: string]: JsonValue;
}

class EventStoreActorState<S> {
  constructor(private readonly config: {
    key: ActorKey;
    fold: (state: S, event: DomainEvent) => S;
    initialState: S;
    streamId: string;
    eventStore: ReturnType<typeof createRuntimeLocalEventStore>;
    clock: ReturnType<typeof createManualClock>;
    snapshots: Map<string, SnapshotRecord>;
    validateLease: (lease: ActorLease) => LeaseRecord;
  }) {}

  async append(lease: ActorLease, event: DomainEvent) {
    const leaseRecord = this.config.validateLease(lease);
    const body = normalizeDomainEvent(event);
    const events = await this.config.eventStore.read(this.config.streamId);
    const result = await this.config.eventStore.append(
      this.config.streamId,
      [
        {
          type: "actor.StateAppended",
          data: {
            key: this.config.key,
            holderId: leaseRecord.holderId,
            fenceToken: leaseRecord.fenceToken.toString(),
            domainEvent: body,
          },
        },
      ],
      appendOptions(events.length, leaseRecord.holderId),
    );

    const appended = result.appended[0];
    return {
      streamId: this.config.streamId,
      seq: appended?.seq ?? events.length + 1,
      fenceToken: leaseRecord.fenceToken,
    };
  }

  async read() {
    const snapshot = this.config.snapshots.get(this.config.key);
    const snapshotSeq = snapshot?.seq ?? 0;
    const events = await this.config.eventStore.read(this.config.streamId, snapshotSeq + 1);
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    let state = structuredClone(snapshot?.state ?? this.config.initialState) as S;
    const domainEvents = extractDomainEvents(events);

    for (const domainEvent of domainEvents) {
      state = this.config.fold(state, structuredClone(domainEvent));
    }

    const allEvents = await this.config.eventStore.read(this.config.streamId);
    return {
      streamId: this.config.key,
      seq: allEvents.length,
      state,
      activatedFromSnapshotSeq: snapshotSeq,
      replayedEventCount: domainEvents.length,
    };
  }

  async passivate(lease: ActorLease) {
    if (!lease) {
      throw new TypeError("passivate requires a lease");
    }
    this.config.validateLease(lease);
    const projection = await this.read();
    await this.config.eventStore.snapshot(
      this.config.streamId,
      projection.state,
      projection.seq,
    );
    this.config.snapshots.set(this.config.key, {
      seq: projection.seq,
      state: structuredClone(projection.state),
      savedAt: this.config.clock.now(),
    });

    const events = await this.config.eventStore.read(this.config.streamId);
    await this.config.eventStore.append(
      this.config.streamId,
      [
        {
          type: "actor.Passivated",
          data: {
            key: this.config.key,
            snapshotSeq: projection.seq,
          },
        },
      ],
      appendOptions(events.length, "system"),
    );

    lease.release();

    return {
      streamId: this.config.key,
      snapshotSeq: projection.seq,
      state: structuredClone(projection.state),
    };
  }
}

function actorStreamId(key: ActorKey): string {
  return `${ACTOR_STREAM_PREFIX}${key}`;
}

function appendOptions(expectedSeq: number, holderId: string) {
  return {
    expectedSeq,
    actor: { kind: "system", id: holderId },
    tenant: "actor-host-draft",
  };
}

function extractDomainEvents(
  envelopes: Array<{ type: string; data?: JsonObject }>,
): DomainEvent[] {
  const domainEvents: DomainEvent[] = [];
  for (const envelope of envelopes) {
    if (envelope.type !== "actor.StateAppended") {
      continue;
    }
    const domainEvent = envelope.data?.domainEvent;
    if (isJsonObject(domainEvent) && isJsonString(domainEvent.type)) {
      domainEvents.push({ ...domainEvent, type: domainEvent.type });
    }
  }
  return domainEvents;
}

function createLeaseFacade(
  record: LeaseRecord,
  deps: {
    clock: ReturnType<typeof createManualClock>;
    leaseTtlMs: number;
    leases: Map<string, LeaseRecord>;
    leaseRecords: WeakMap<ActorLease, LeaseRecord>;
  },
) {
  const lease = {
    key: record.key,
    holderId: record.holderId,
    fenceToken: record.fenceToken,
    get expiresAt() {
      return formatInstant(record.expiresAtMs);
    },
    renew() {
      const current = deps.leases.get(record.key);
      if (!sameLease(current, record)) {
        throw new StaleFenceError(`stale fence for ${record.key}: ${record.fenceToken.toString()}`);
      }
      if (record.expiresAtMs <= deps.clock.nowMs()) {
        throw new LeaseExpiredError(`expired lease for ${record.key}: ${record.fenceToken.toString()}`);
      }
      record.expiresAtMs = deps.clock.nowMs() + deps.leaseTtlMs;
      return {
        key: record.key,
        holderId: record.holderId,
        fenceToken: record.fenceToken,
        expiresAt: formatInstant(record.expiresAtMs),
      };
    },
    release() {
      const current = deps.leases.get(record.key);
      if (sameLease(current, record)) {
        record.released = true;
      }
    },
  };
  deps.leaseRecords.set(lease, record);
  return Object.freeze(lease);
}

function validateLeaseForAppend(
  leases: Map<string, LeaseRecord>,
  leaseRecords: WeakMap<ActorLease, LeaseRecord>,
  clock: ReturnType<typeof createManualClock>,
  key: ActorKey,
  lease: ActorLease,
) {
  const leaseRecord = leaseRecords.get(lease);
  if (!leaseRecord || leaseRecord.key !== key) {
    throw new StaleFenceError(`stale fence for ${key}: lease key mismatch`);
  }

  const current = leases.get(key);
  if (!sameLease(current, leaseRecord)) {
    throw new StaleFenceError(`stale fence for ${key}: ${leaseRecord.fenceToken.toString()}`);
  }
  if (current!.released || current!.expiresAtMs <= clock.nowMs()) {
    throw new LeaseExpiredError(`expired lease for ${key}: ${leaseRecord.fenceToken.toString()}`);
  }
  return leaseRecord;
}

function sameLease(current: LeaseRecord | undefined, record: LeaseRecord): boolean {
  return Boolean(
    current &&
      current.key === record.key &&
      current.holderId === record.holderId &&
      current.fenceToken === record.fenceToken,
  );
}

function normalizeDomainEvent(event: JsonValue): DomainEvent {
  if (!event || !isJsonObject(event)) {
    throw new TypeError("event must be an object");
  }
  const type = requireNonEmptyString(event.type, "event.type");
  return {
    ...structuredClone(event),
    type,
  };
}

function requireNonEmptyString(value: JsonValue, fieldName: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: JsonValue, fieldName: string): number {
  if (!isJsonNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
  return value;
}

function formatInstant(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}
