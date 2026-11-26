import { createNativeProjectionLog } from "../../native-log-projection-contract/src/native-log-projection.js";

export const PROJECTION_LAGGED_EVENT_TYPE = "projection.Lagged";

const DEFAULT_TOPOLOGY = "single-writer-camp";

export function declareCrossCampBoundedStalenessProjection(input) {
  assertObject(input, "projection contract input");
  assertObject(input.projection, "projection");

  const ownerCampId = assertNonEmptyString(input.ownerCampId, "ownerCampId");
  const replicaCampIds = normalizeReplicaCamps(input.replicaCampIds, ownerCampId);
  const maxStalenessMs = assertNonNegativeInteger(input.maxStalenessMs, "maxStalenessMs");

  return deepFreeze({
    projection: input.projection,
    consistency: "bounded-staleness",
    maxStalenessMs,
    replicationTopology: {
      kind: DEFAULT_TOPOLOGY,
      ownerCampId,
      replicaCampIds,
      readStream: "owner-replicated-read-stream",
    },
    scopeBoundary: {
      replicationTransport: "out-of-scope",
      activeActiveMerge: "out-of-scope",
      strongCrossCampConsistency: "out-of-scope",
    },
    honestLimit:
      "single-writer-camp is the cross-Camp write bottleneck; active-active-eventual/CRDT merge is opt-in and not implemented here",
  });
}

export function createCrossCampProjectionRuntime({ contract }) {
  return new CrossCampProjectionRuntime(contract);
}

class CrossCampProjectionRuntime {
  #contract;
  #ownerLog;
  #ownerEvents = [];
  #replicas = new Map();
  #events = [];
  #lagSeq = new Map();
  #subscriptions = new Map();

  constructor(contract) {
    assertObject(contract, "contract");
    this.#contract = contract;
    this.#ownerLog = createNativeProjectionLog();

    for (const campId of contract.replicationTopology.replicaCampIds) {
      this.#replicas.set(campId, {
        campId,
        log: createNativeProjectionLog(),
        seen: new Set(),
        ownerWatermarkMs: null,
        receivedAtMs: null,
      });
    }
  }

  appendOwnerEvent(event) {
    const normalized = normalizeEvent(event);
    this.#ownerLog.append(normalized);
    this.#ownerEvents.push(normalized);
    return clone(normalized);
  }

  ownerReadStream() {
    return this.#ownerEvents.map(clone);
  }

  replicateTo(campId, input) {
    const replica = this.#requireReplica(campId);
    assertObject(input, "replication input");
    const events = Array.isArray(input.events) ? input.events.map(normalizeEvent) : [];

    let appliedEventCount = 0;
    for (const event of events) {
      const key = eventKey(event);
      if (replica.seen.has(key)) {
        continue;
      }
      replica.log.append(event);
      replica.seen.add(key);
      appliedEventCount += 1;
    }

    replica.ownerWatermarkMs = assertNonNegativeInteger(input.ownerWatermarkMs, "ownerWatermarkMs");
    replica.receivedAtMs = assertNonNegativeInteger(input.receivedAtMs, "receivedAtMs");

    const report = {
      campId,
      projection: this.#contract.projection.name,
      source: "replicated-read-stream",
      appliedEventCount,
      rows: this.#snapshotRows(replica.log),
      staleness: this.#stalenessForReplica(replica, replica.receivedAtMs),
    };

    this.#emitLaggedIfNeeded(replica, report.staleness);
    this.#pushSubscriptions(campId, report);

    return deepFreeze(report);
  }

  read(campId, options = {}) {
    const nowMs = assertNonNegativeInteger(options.nowMs, "nowMs");
    if (campId === this.#contract.replicationTopology.ownerCampId) {
      return deepFreeze({
        campId,
        projection: this.#contract.projection.name,
        source: "owner-reactor",
        rows: this.#snapshotRows(this.#ownerLog),
        staleness: {
          guarantee: "read-your-writes",
          status: "fresh",
          flagged: false,
          boundMs: 0,
          observedLagMs: 0,
          ownerCampId: campId,
          servedByCampId: campId,
          topology: DEFAULT_TOPOLOGY,
        },
      });
    }

    const replica = this.#requireReplica(campId);
    const staleness = this.#stalenessForReplica(replica, nowMs);
    this.#emitLaggedIfNeeded(replica, staleness);

    return deepFreeze({
      campId,
      projection: this.#contract.projection.name,
      source: "replicated-read-stream",
      rows: this.#snapshotRows(replica.log),
      staleness,
    });
  }

  subscribe({ subscriptionId, campId, client }) {
    const normalized = {
      subscriptionId: assertNonEmptyString(subscriptionId, "subscriptionId"),
      campId: assertNonEmptyString(campId, "campId"),
      client: normalizeClient(client),
    };

    if (normalized.campId !== this.#contract.replicationTopology.ownerCampId) {
      this.#requireReplica(normalized.campId);
    }

    if (this.#subscriptions.has(normalized.subscriptionId)) {
      throw new Error(`duplicate subscription: ${normalized.subscriptionId}`);
    }

    this.#subscriptions.set(normalized.subscriptionId, normalized);
    return Object.freeze({
      subscriptionId: normalized.subscriptionId,
      campId: normalized.campId,
      projection: this.#contract.projection.name,
    });
  }

  attemptWrite(input) {
    assertObject(input, "write attempt");
    const campId = assertNonEmptyString(input.campId, "campId");
    const command = clone(input.command ?? {});
    const ownerCampId = this.#contract.replicationTopology.ownerCampId;

    if (input.requiresConsistency === true && campId !== ownerCampId) {
      return deepFreeze({
        action: "route-home",
        targetCampId: ownerCampId,
        sourceCampId: campId,
        appliedLocally: false,
        reason: "single-writer-camp requires consistency writes to run in the owner Camp",
        command,
      });
    }

    return deepFreeze({
      action: "apply-local",
      targetCampId: campId,
      sourceCampId: campId,
      appliedLocally: true,
      command,
    });
  }

  events() {
    return this.#events.map(clone);
  }

  #snapshotRows(log) {
    return log.materialize(this.#contract.projection).rows;
  }

  #stalenessForReplica(replica, nowMs) {
    const boundMs = this.#contract.maxStalenessMs;
    const observedLagMs =
      replica.ownerWatermarkMs === null ? Number.POSITIVE_INFINITY : nowMs - replica.ownerWatermarkMs;
    const exceedsBound = observedLagMs > boundMs;

    return Object.freeze({
      guarantee: "bounded-staleness",
      status: exceedsBound ? "exceeds-bound" : "within-bound",
      flagged: exceedsBound,
      boundMs,
      observedLagMs,
      ownerCampId: this.#contract.replicationTopology.ownerCampId,
      servedByCampId: replica.campId,
      topology: DEFAULT_TOPOLOGY,
    });
  }

  #emitLaggedIfNeeded(replica, staleness) {
    if (!staleness.flagged) {
      return null;
    }

    const streamId = `projection/${this.#contract.projection.name}/lag/${replica.campId}`;
    const seq = (this.#lagSeq.get(streamId) ?? 0) + 1;
    this.#lagSeq.set(streamId, seq);

    const event = deepFreeze({
      type: PROJECTION_LAGGED_EVENT_TYPE,
      streamId,
      seq,
      data: {
        projection: this.#contract.projection.name,
        ownerCampId: this.#contract.replicationTopology.ownerCampId,
        replicaCampId: replica.campId,
        declaredBoundMs: this.#contract.maxStalenessMs,
        observedLagMs: staleness.observedLagMs,
        policyInput: true,
        reason: "replicated projection exceeded declared bounded-staleness",
      },
    });
    this.#events.push(event);
    return event;
  }

  #pushSubscriptions(campId, report) {
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.campId !== campId) {
        continue;
      }
      subscription.client.push({
        type: "subscription.Pushed",
        subscriptionId: subscription.subscriptionId,
        campId,
        projection: this.#contract.projection.name,
        source: "replicated-read-stream",
        staleness: clone(report.staleness),
        rows: clone(report.rows),
      });
    }
  }

  #requireReplica(campId) {
    const id = assertNonEmptyString(campId, "campId");
    const replica = this.#replicas.get(id);
    if (!replica) {
      throw new Error(`unknown replica Camp: ${id}`);
    }
    return replica;
  }
}

function normalizeReplicaCamps(replicaCampIds, ownerCampId) {
  if (!Array.isArray(replicaCampIds) || replicaCampIds.length === 0) {
    throw new TypeError("replicaCampIds must contain at least one Camp");
  }

  const camps = [...new Set(replicaCampIds.map((campId) => assertNonEmptyString(campId, "replicaCampId")))].sort();
  if (camps.includes(ownerCampId)) {
    throw new TypeError("replicaCampIds must not include ownerCampId");
  }
  return Object.freeze(camps);
}

function normalizeEvent(event) {
  assertObject(event, "event");
  return Object.freeze({
    ...clone(event),
    id: event.id ? assertNonEmptyString(event.id, "event.id") : `${event.streamId}-${event.seq}`,
    streamId: assertNonEmptyString(event.streamId, "event.streamId"),
    seq: assertNonNegativeInteger(event.seq, "event.seq"),
    type: assertNonEmptyString(event.type, "event.type"),
    ownerTimestampMs: assertNonNegativeInteger(event.ownerTimestampMs, "event.ownerTimestampMs"),
    data: clone(event.data ?? {}),
  });
}

function eventKey(event) {
  return `${event.streamId}\0${event.seq}`;
}

function normalizeClient(client) {
  if (!client || Object.prototype.toString.call(client.push) !== "[object Function]") {
    throw new TypeError("client must expose push(event)");
  }
  return client;
}

function assertObject(value, field) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, field) {
  if (Object.prototype.toString.call(value) !== "[object String]" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreeze));
  }
  if (isObjectLike(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, deepFreeze(child)])));
  }
  return value;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isObjectLike(value) {
  return value !== null && (Array.isArray(value) || isPlainObject(value));
}
