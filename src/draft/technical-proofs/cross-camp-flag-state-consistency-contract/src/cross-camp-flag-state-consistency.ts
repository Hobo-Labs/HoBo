import {
  replayFlagEvents,
  validateFlagEvent
} from "../../flag-event-contract/src/flag-event-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const SINGLE_WRITER_TOPOLOGY = "single-writer-camp";
const ACTIVE_ACTIVE_TOPOLOGY = "active-active-eventual";
const ACTIVE_ACTIVE_STRATEGY = "last-writer-wins-camp-id-tiebreak";

export function declareCrossCampFlagStateTopology(input) {
  assertObject(input, "flag topology input");

  const flagKey = assertNonEmptyString(input.flagKey, "flagKey");
  const ownerCampId = assertNonEmptyString(input.writerCampId, "writerCampId");
  const followerCampIds = normalizeFollowerCamps(input.followerCampIds, ownerCampId);
  const maxStalenessMs = assertNonNegativeInteger(input.maxStalenessMs, "maxStalenessMs");
  const heartbeatTtlMs = assertNonNegativeInteger(input.heartbeatTtlMs, "heartbeatTtlMs");

  if (heartbeatTtlMs < maxStalenessMs) {
    throw new RangeError("heartbeatTtlMs must be greater than or equal to maxStalenessMs");
  }

  return deepFreeze({
    flagKey,
    consistency: "bounded-staleness",
    maxStalenessMs,
    heartbeatTtlMs,
    replicationTopology: {
      kind: SINGLE_WRITER_TOPOLOGY,
      ownerCampId,
      followerCampIds,
      readStream: "owner-replicated-flag-stream",
      writePolicy: "route-to-owner"
    },
    scopeBoundary: {
      replicationTransport: "out-of-scope",
      singleCampPartitionBehavior: "out-of-scope",
      flipGovernance: "out-of-scope"
    }
  });
}

export function createCrossCampFlagStateRuntime({ contract }) {
  return new CrossCampFlagStateRuntime(contract);
}

export function resolveActiveActiveFlagChanges(input) {
  assertObject(input, "active-active input");
  const flagKey = assertNonEmptyString(input.flagKey, "flagKey");
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new TypeError("changes must contain at least one flag change");
  }

  const changes = input.changes.map((change) => normalizeActiveActiveChange(change, flagKey));
  const winner = [...changes].sort(
    (left, right) =>
      right.logicalTimeMs - left.logicalTimeMs ||
      right.seq - left.seq ||
      right.campId.localeCompare(left.campId)
  )[0];
  const lineage = [...changes]
    .sort((left, right) => left.campId.localeCompare(right.campId))
    .map((change) => ({
      campId: change.campId,
      logicalTimeMs: change.logicalTimeMs,
      seq: change.seq,
      value: clone(change.value)
    }));

  return deepFreeze({
    topology: ACTIVE_ACTIVE_TOPOLOGY,
    flagKey,
    converged: true,
    value: clone(winner.value),
    winner: {
      campId: winner.campId,
      logicalTimeMs: winner.logicalTimeMs,
      seq: winner.seq,
      value: clone(winner.value)
    },
    lineage,
    conflictResolution: {
      strategy: ACTIVE_ACTIVE_STRATEGY,
      retainedChanges: changes.length,
      lostUpdates: 0
    }
  });
}

class CrossCampFlagStateRuntime {
  #contract;
  #writerEntries = [];
  #writerBySeq = new Map();
  #followers = new Map();

  constructor(contract) {
    assertObject(contract, "contract");
    this.#contract = contract;

    for (const campId of contract.replicationTopology.followerCampIds) {
      this.#followers.set(campId, {
        campId,
        entries: [],
        appliedSeq: 0,
        ownerWatermarkMs: null,
        receivedAtMs: null,
        receivedAtBySeq: new Map()
      });
    }
  }

  appendWriterEntry(input) {
    const entry = normalizeFlagEntry(input, this.#contract.flagKey);
    const expectedSeq = this.#ownerSeq() + 1;

    if (entry.seq !== expectedSeq) {
      throw new Error(`writer entry seq ${entry.seq} must follow seq ${this.#ownerSeq()}`);
    }

    this.#writerEntries.push(entry);
    this.#writerBySeq.set(entry.seq, entry);

    return deepFreeze({
      accepted: true,
      campId: this.#contract.replicationTopology.ownerCampId,
      flagKey: this.#contract.flagKey,
      seq: entry.seq,
      value: eventValue(entry.event)
    });
  }

  ownerReadStream() {
    return this.#writerEntries.map(clone);
  }

  replicateTo(campId, input) {
    const follower = this.#requireFollower(campId);
    assertObject(input, "replication input");
    const entries = Array.isArray(input.entries) ? input.entries.map((entry) => normalizeFlagEntry(entry, this.#contract.flagKey)) : [];
    const ownerWatermarkMs = assertNonNegativeInteger(input.ownerWatermarkMs, "ownerWatermarkMs");
    const receivedAtMs = assertNonNegativeInteger(input.receivedAtMs, "receivedAtMs");

    let appliedEventCount = 0;
    for (const entry of entries) {
      const ownerEntry = this.#writerBySeq.get(entry.seq);
      if (!ownerEntry) {
        return deepFreeze({
          accepted: false,
          campId,
          reason: "unknown-writer-seq",
          expectedSeq: follower.appliedSeq + 1,
          receivedSeq: entry.seq,
          appliedSeq: follower.appliedSeq
        });
      }
      if (entry.seq <= follower.appliedSeq) {
        continue;
      }

      const expectedSeq = follower.appliedSeq + 1;
      if (entry.seq !== expectedSeq) {
        return deepFreeze({
          accepted: false,
          campId,
          reason: "out-of-order-replication",
          expectedSeq,
          receivedSeq: entry.seq,
          appliedSeq: follower.appliedSeq
        });
      }

      follower.entries.push(entry);
      follower.appliedSeq = entry.seq;
      follower.receivedAtBySeq.set(entry.seq, receivedAtMs);
      appliedEventCount += 1;
    }

    follower.ownerWatermarkMs = ownerWatermarkMs;
    follower.receivedAtMs = receivedAtMs;

    return deepFreeze({
      accepted: true,
      campId,
      flagKey: this.#contract.flagKey,
      appliedEventCount,
      appliedSeq: follower.appliedSeq,
      staleness: this.#stalenessForFollower(follower, receivedAtMs)
    });
  }

  read(campId, options = {}) {
    const nowMs = assertNonNegativeInteger(options.nowMs, "nowMs");
    if (campId === this.#contract.replicationTopology.ownerCampId) {
      return deepFreeze({
        campId,
        flagKey: this.#contract.flagKey,
        source: "writer-camp",
        value: materializeValue(this.#writerEntries, this.#contract.flagKey),
        rulesetSeq: this.#ownerSeq(),
        staleness: {
          guarantee: "read-your-writes",
          status: "fresh",
          fresh: true,
          stale: false,
          blocked: false,
          label: "writer-camp:fresh",
          reason: "owner-read",
          boundMs: 0,
          observedLagMs: 0,
          ownerSeq: this.#ownerSeq(),
          followerSeq: this.#ownerSeq(),
          ownerCampId: campId,
          servedByCampId: campId,
          topology: SINGLE_WRITER_TOPOLOGY
        }
      });
    }

    const follower = this.#requireFollower(campId);
    return deepFreeze({
      campId,
      flagKey: this.#contract.flagKey,
      source: "replicated-read-stream",
      value: materializeValue(follower.entries, this.#contract.flagKey),
      rulesetSeq: follower.appliedSeq,
      staleness: this.#stalenessForFollower(follower, nowMs)
    });
  }

  measureKillSwitchPropagation(input) {
    assertObject(input, "propagation input");
    const followerCampId = assertNonEmptyString(input.followerCampId, "followerCampId");
    const seq = assertPositiveInteger(input.seq, "seq");
    const follower = this.#requireFollower(followerCampId);
    const entry = follower.entries.find((candidate) => candidate.seq === seq);
    const receivedAtMs = follower.receivedAtBySeq.get(seq);

    if (!entry || receivedAtMs === undefined) {
      throw new Error(`follower ${followerCampId} has not received seq ${seq}`);
    }

    const propagationMs = receivedAtMs - entry.emittedAtMs;
    return deepFreeze({
      followerCampId,
      flagKey: this.#contract.flagKey,
      seq,
      propagationMs,
      boundMs: this.#contract.maxStalenessMs,
      withinBound: propagationMs <= this.#contract.maxStalenessMs
    });
  }

  #ownerSeq() {
    return this.#writerEntries.at(-1)?.seq ?? 0;
  }

  #stalenessForFollower(follower, nowMs) {
    const ownerSeq = this.#ownerSeq();
    const followerSeq = follower.appliedSeq;
    const observedLagMs =
      follower.ownerWatermarkMs === null ? Number.POSITIVE_INFINITY : nowMs - follower.ownerWatermarkMs;
    const partitionSuspected =
      follower.ownerWatermarkMs !== null && observedLagMs > this.#contract.heartbeatTtlMs;
    const behindOwner = ownerSeq > followerSeq;
    const exceedsBound = observedLagMs > this.#contract.maxStalenessMs;

    if (partitionSuspected) {
      return this.#stalenessLabel(follower, {
        guarantee: "unbounded-staleness",
        status: "partition-suspected",
        fresh: false,
        stale: true,
        label: "unbounded-stale:partition-suspected",
        reason: "owner-heartbeat-stale",
        observedLagMs,
        ownerSeq,
        followerSeq
      });
    }

    if (behindOwner) {
      return this.#stalenessLabel(follower, {
        guarantee: "bounded-staleness",
        status: "stale",
        fresh: false,
        stale: true,
        label: "bounded-staleness:stale",
        reason: "replication-lag",
        observedLagMs,
        ownerSeq,
        followerSeq
      });
    }

    if (exceedsBound) {
      return this.#stalenessLabel(follower, {
        guarantee: "bounded-staleness",
        status: "stale",
        fresh: false,
        stale: true,
        label: "bounded-staleness:stale",
        reason: "exceeds-staleness-bound",
        observedLagMs,
        ownerSeq,
        followerSeq
      });
    }

    return this.#stalenessLabel(follower, {
      guarantee: "bounded-staleness",
      status: "fresh",
      fresh: true,
      stale: false,
      label: "bounded-staleness:fresh",
      reason: "caught-up",
      observedLagMs,
      ownerSeq,
      followerSeq
    });
  }

  #stalenessLabel(follower, input) {
    return Object.freeze({
      guarantee: input.guarantee,
      status: input.status,
      fresh: input.fresh,
      stale: input.stale,
      blocked: false,
      label: input.label,
      reason: input.reason,
      boundMs: this.#contract.maxStalenessMs,
      observedLagMs: input.observedLagMs,
      ownerSeq: input.ownerSeq,
      followerSeq: input.followerSeq,
      ownerCampId: this.#contract.replicationTopology.ownerCampId,
      servedByCampId: follower.campId,
      topology: SINGLE_WRITER_TOPOLOGY
    });
  }

  #requireFollower(campId) {
    const id = assertNonEmptyString(campId, "campId");
    const follower = this.#followers.get(id);
    if (!follower) {
      throw new Error(`unknown follower Camp: ${id}`);
    }
    return follower;
  }
}

function normalizeFollowerCamps(followerCampIds, ownerCampId) {
  if (!Array.isArray(followerCampIds) || followerCampIds.length === 0) {
    throw new TypeError("followerCampIds must contain at least one Camp");
  }

  const camps = [...new Set(followerCampIds.map((campId) => assertNonEmptyString(campId, "followerCampId")))].sort();
  if (camps.includes(ownerCampId)) {
    throw new TypeError("followerCampIds must not include writerCampId");
  }
  return Object.freeze(camps);
}

function normalizeFlagEntry(input, flagKey) {
  assertObject(input, "flag entry");
  const event = validateFlagEvent(clone(input.event));
  if (event.data.key !== flagKey) {
    throw new Error(`flag entry key ${event.data.key} does not match ${flagKey}`);
  }

  return deepFreeze({
    seq: assertPositiveInteger(input.seq, "seq"),
    event,
    emittedAtMs: assertNonNegativeInteger(input.emittedAtMs, "emittedAtMs")
  });
}

function normalizeActiveActiveChange(input, flagKey) {
  assertObject(input, "active-active change");
  const event = validateFlagEvent(clone(input.event));
  if (event.data.key !== flagKey) {
    throw new Error(`active-active change key ${event.data.key} does not match ${flagKey}`);
  }

  return Object.freeze({
    campId: assertNonEmptyString(input.campId, "campId"),
    logicalTimeMs: assertNonNegativeInteger(input.logicalTimeMs, "logicalTimeMs"),
    seq: assertPositiveInteger(input.seq, "seq"),
    event,
    value: eventValue(event)
  });
}

function materializeValue(entries, flagKey) {
  if (entries.length === 0) {
    return undefined;
  }

  const replayed = replayFlagEvents(entries.map((entry) => entry.event));
  return clone(replayed.flags[flagKey]?.currentValue);
}

function eventValue(event) {
  if (event.type === "flag.Changed" && event.data.diff.value) {
    return clone(event.data.diff.value.to);
  }
  if (event.type === "flag.Defined") {
    return clone(event.data.defaultValue);
  }
  return undefined;
}

function assertObject(value, field) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
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
  if (value && isJsonObject(value)) {
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
