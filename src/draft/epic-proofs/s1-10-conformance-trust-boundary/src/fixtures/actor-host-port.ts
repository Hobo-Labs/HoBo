import { isJsonString, isJsonObject } from "../json.js";

export const ACTOR_HOST_RUNTIME_PORT_VERSION = "hobo.actor-host-runtime-port/v1";

export class LeaseConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "LeaseConflictError";
  }
}

export class LeaseExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "LeaseExpiredError";
  }
}

export class StaleFenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "StaleFenceError";
  }
}

export function createManualClock(startInstant = "2026-06-25T00:00:00.000Z") {
  let nowMs = normalizeInstantMs(startInstant, "startInstant");

  return {
    now() {
      return new Date(nowMs).toISOString();
    },
    nowMs() {
      return nowMs;
    },
    advance(deltaMs) {
      if (!Number.isInteger(deltaMs) || deltaMs < 0) {
        throw new TypeError("deltaMs must be a non-negative integer");
      }
      nowMs += deltaMs;
      return this.now();
    },
  };
}

export function createInMemoryActorHost(options = {}) {
  const clock = options.clock ?? createManualClock();
  const leaseTtlMs = requirePositiveInteger(options.leaseTtlMs ?? 30_000, "options.leaseTtlMs");
  const leases = new Map();
  const leaseRecords = new WeakMap();
  const streams = new Map();

  return {
    acquire(key, request = {}) {
      const actorKey = requireNonEmptyString(key, "key");
      const holderId = requireNonEmptyString(request.holderId, "request.holderId");
      const nowMs = clock.nowMs();
      const current = leases.get(actorKey);

      if (current && !current.released && current.expiresAtMs > nowMs) {
        throw new LeaseConflictError(
          `lease conflict for ${actorKey}: held by ${current.holderId} until ${formatInstant(current.expiresAtMs)}`,
        );
      }

      const next = {
        key: actorKey,
        holderId,
        fenceToken: (current?.fenceToken ?? 0n) + 1n,
        expiresAtMs: nowMs + leaseTtlMs,
        released: false,
      };
      leases.set(actorKey, next);

      return createLeaseFacade(next, { clock, leaseTtlMs, leases, leaseRecords });
    },

    state(key, request = {}) {
      const actorKey = requireNonEmptyString(key, "key");
      if (!(request.fold instanceof Function)) {
        throw new TypeError("request.fold must be a function");
      }
      if (!("initialState" in request)) {
        throw new TypeError("request.initialState is required");
      }

      return new DurableActorState({
        key: actorKey,
        fold: request.fold,
        initialState: structuredClone(request.initialState),
        stream: getStream(streams, actorKey),
        clock,
        validateLease(lease) {
          return validateLeaseForAppend(leases, leaseRecords, clock, actorKey, lease);
        },
      });
    },
  };
}

class DurableActorState {
  constructor({ key, fold, initialState, stream, clock, validateLease }) {
    this.key = key;
    this.#fold = fold;
    this.#initialState = initialState;
    this.#stream = stream;
    this.#clock = clock;
    this.#validateLease = validateLease;
  }

  #fold;
  #initialState;
  #stream;
  #clock;
  #validateLease;

  append(lease, event) {
    const leaseRecord = this.#validateLease(lease);
    const body = normalizeEvent(event);
    const seq = this.#stream.events.length + 1;
    const record = Object.freeze({
      ...body,
      apiVersion: ACTOR_HOST_RUNTIME_PORT_VERSION,
      streamId: this.key,
      seq,
      fenceToken: leaseRecord.fenceToken,
      holderId: leaseRecord.holderId,
      appendedAt: this.#clock.now(),
    });
    this.#stream.events.push(record);
    return {
      streamId: this.key,
      seq,
      fenceToken: leaseRecord.fenceToken,
    };
  }

  read() {
    const snapshot = this.#stream.snapshot;
    const snapshotSeq = snapshot?.seq ?? 0;
    let state = structuredClone(snapshot?.state ?? this.#initialState);
    const tail = this.#stream.events.filter((event) => event.seq > snapshotSeq);

    for (const event of tail) {
      state = this.#fold(state, structuredClone(event));
    }

    return {
      streamId: this.key,
      seq: this.#stream.events.length,
      state,
      activatedFromSnapshotSeq: snapshotSeq,
      replayedEventCount: tail.length,
    };
  }

  passivate(lease) {
    if (!lease) {
      throw new TypeError("passivate requires a lease");
    }
    this.#validateLease(lease);
    const projection = this.read();
    this.#stream.snapshot = {
      seq: projection.seq,
      state: structuredClone(projection.state),
      savedAt: this.#clock.now(),
    };
    lease.release();
    return {
      streamId: this.key,
      snapshotSeq: projection.seq,
      state: structuredClone(projection.state),
    };
  }
}

function createLeaseFacade(record, { clock, leaseTtlMs, leases, leaseRecords }) {
  const lease = {
    key: record.key,
    holderId: record.holderId,
    fenceToken: record.fenceToken,
    get expiresAt() {
      return formatInstant(record.expiresAtMs);
    },
    renew() {
      const current = leases.get(record.key);
      if (!sameLease(current, record)) {
        throw new StaleFenceError(`stale fence for ${record.key}: ${record.fenceToken.toString()}`);
      }
      if (record.expiresAtMs <= clock.nowMs()) {
        throw new LeaseExpiredError(`expired lease for ${record.key}: ${record.fenceToken.toString()}`);
      }
      record.expiresAtMs = clock.nowMs() + leaseTtlMs;
      return {
        key: record.key,
        holderId: record.holderId,
        fenceToken: record.fenceToken,
        expiresAt: formatInstant(record.expiresAtMs),
      };
    },
    release() {
      const current = leases.get(record.key);
      if (sameLease(current, record)) {
        record.released = true;
      }
    },
  };
  leaseRecords.set(lease, record);
  return Object.freeze(lease);
}

function validateLeaseForAppend(leases, leaseRecords, clock, key, lease) {
  const leaseRecord = leaseRecords.get(lease);
  if (!leaseRecord || leaseRecord.key !== key) {
    throw new StaleFenceError(`stale fence for ${key}: lease key mismatch`);
  }

  const current = leases.get(key);
  if (!sameLease(current, leaseRecord)) {
    throw new StaleFenceError(`stale fence for ${key}: ${leaseRecord.fenceToken.toString()}`);
  }
  if (current.released || current.expiresAtMs <= clock.nowMs()) {
    throw new LeaseExpiredError(`expired lease for ${key}: ${leaseRecord.fenceToken.toString()}`);
  }
  return leaseRecord;
}

function sameLease(current, record) {
  return Boolean(
    current &&
      current.key === record.key &&
      current.holderId === record.holderId &&
      current.fenceToken === record.fenceToken,
  );
}

function getStream(streams, key) {
  if (!streams.has(key)) {
    streams.set(key, {
      events: [],
      snapshot: null,
    });
  }
  return streams.get(key);
}

function normalizeEvent(event) {
  if (!event || !isJsonObject(event) || Array.isArray(event)) {
    throw new TypeError("event must be an object");
  }
  const type = requireNonEmptyString(event.type, "event.type");
  return Object.freeze({
    ...structuredClone(event),
    type,
  });
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
  return value;
}

function normalizeInstantMs(value, fieldName) {
  const timestamp = Date.parse(value);
  if (!isJsonString(value) || Number.isNaN(timestamp)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
  }
  return timestamp;
}

function formatInstant(timestampMs) {
  return new Date(timestampMs).toISOString();
}
