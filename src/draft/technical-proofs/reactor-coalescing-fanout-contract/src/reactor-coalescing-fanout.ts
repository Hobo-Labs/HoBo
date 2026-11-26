import { isJsonString, isJsonObject } from "./json.js";
export class ReactorSeqRegressionError extends Error {
  constructor({ subscriptionId, previousSeq, seq }) {
    super(`reactor fan-out regressed ${subscriptionId}: previous=${JSON.stringify(previousSeq)}, next=${JSON.stringify(seq)}`);
    this.name = "ReactorSeqRegressionError";
    this.subscriptionId = subscriptionId;
    this.previousSeq = previousSeq;
    this.seq = seq;
  }
}

export function defineMaterialization(input) {
  assertObject(input, "materialization");
  assertFunction(input.fold, "materialization.fold");

  return Object.freeze({
    name: assertNonEmptyString(input.name, "materialization.name"),
    readSet: normalizeReadSet(input.readSet),
    initialState: clone(input.initialState ?? null),
    fold: input.fold,
    project: input.project ?? null,
  });
}

export function createCoalescingFanoutReactor(options = {}) {
  return new CoalescingFanoutReactor(options);
}

export function isSeqAtLeast(candidate, floor) {
  const normalizedCandidate = normalizeSeqVector(candidate);
  const normalizedFloor = normalizeSeqVector(floor);

  return Object.entries(normalizedFloor).every(([streamId, seq]) => (normalizedCandidate[streamId] ?? -1) >= seq);
}

class CoalescingFanoutReactor {
  #events = [];
  #eventsById = new Map();
  #index = new Map();
  #materializations;
  #maxFanoutPerTick;
  #nextShard = 0;
  #queued = new Map();
  #queues;
  #shardCount;
  #subscriptions = new Map();

  constructor({ materializations = [], maxFanoutPerTick = 8, shardCount = 4 } = {}) {
    this.#materializations = new Map(
      materializations.map((materialization) => [materialization.name, materialization]),
    );
    this.#maxFanoutPerTick = assertPositiveInteger(maxFanoutPerTick, "maxFanoutPerTick");
    this.#shardCount = assertPositiveInteger(shardCount, "shardCount");
    this.#queues = {
      local: createShardSets(this.#shardCount),
      crossCutting: createShardSets(this.#shardCount),
    };
  }

  subscribe({ subscriptionId, materialization, args = {}, client = null }) {
    const normalizedSubscriptionId = assertNonEmptyString(subscriptionId, "subscriptionId");
    if (this.#subscriptions.has(normalizedSubscriptionId)) {
      throw new Error(`duplicate subscription: ${normalizedSubscriptionId}`);
    }

    const definition = this.#materializationFor(materialization);
    const initialSnapshot = this.#materialize(definition, args);
    const subscription = {
      subscriptionId: normalizedSubscriptionId,
      materialization: definition,
      args: clone(args),
      client: client ? normalizeClient(client) : null,
      lastSeq: initialSnapshot.seq,
      lastResult: initialSnapshot.result,
      pendingSnapshot: null,
    };
    this.#subscriptions.set(subscription.subscriptionId, subscription);
    this.#indexSubscription(subscription);

    return this.#publicSubscription(subscription);
  }

  append(event) {
    const normalized = normalizeEvent(event);
    if (this.#eventsById.has(normalized.id)) {
      return {
        duplicate: true,
        eventId: normalized.id,
        enqueued: 0,
        synchronousPushes: 0,
        queueDepth: this.fanoutDepth(),
      };
    }

    this.#events.push(normalized);
    this.#eventsById.set(normalized.id, normalized);

    const fanoutKind = isCrossCuttingEvent(normalized) ? "crossCutting" : "local";
    let enqueued = 0;
    const affected = this.#subscriptionsFor(normalized);
    for (const subscription of affected) {
      enqueued += this.#enqueue(subscription.subscriptionId, fanoutKind) ? 1 : 0;
    }

    return {
      duplicate: false,
      eventId: normalized.id,
      eventType: normalized.type,
      affected: affected.map((subscription) => subscription.subscriptionId),
      enqueued,
      synchronousPushes: 0,
      queueDepth: this.fanoutDepth(),
    };
  }

  drainFanoutTick({ budget = this.#maxFanoutPerTick } = {}) {
    const normalizedBudget = assertPositiveInteger(budget, "budget");
    const delivered = [];
    const blocked = [];
    const skipped = [];

    for (let used = 0; used < normalizedBudget; used += 1) {
      const subscriptionId = this.#dequeueNext("local") ?? this.#dequeueNext("crossCutting");
      if (!subscriptionId) {
        break;
      }

      const subscription = this.#subscriptions.get(subscriptionId);
      if (!subscription) {
        skipped.push(subscriptionId);
        continue;
      }

      const snapshot = this.#latestSnapshotFor(subscription);
      if (!this.#clientCanAccept(subscription)) {
        subscription.pendingSnapshot = snapshot;
        blocked.push(subscriptionId);
        continue;
      }

      const deliveredSnapshot = snapshot;
      this.#assertNonRegression(subscription, deliveredSnapshot.seq);
      subscription.pendingSnapshot = null;

      if (deepEqual(deliveredSnapshot.seq, subscription.lastSeq) && deepEqual(deliveredSnapshot.result, subscription.lastResult)) {
        skipped.push(subscriptionId);
        continue;
      }

      subscription.lastSeq = deliveredSnapshot.seq;
      subscription.lastResult = deliveredSnapshot.result;
      subscription.client?.push({
        type: "subscription.Pushed",
        subscriptionId,
        seq: clone(deliveredSnapshot.seq),
        result: clone(deliveredSnapshot.result),
      });
      delivered.push(subscriptionId);
    }

    return {
      delivered,
      blocked,
      skipped,
      remaining: this.fanoutDepth().total,
    };
  }

  drainAllFanout({ maxTicks = 1000 } = {}) {
    const normalizedMaxTicks = assertPositiveInteger(maxTicks, "maxTicks");
    const delivered = [];
    let maxDeliveredPerTick = 0;
    let ticks = 0;

    while (this.fanoutDepth().total > 0 && ticks < normalizedMaxTicks) {
      const tick = this.drainFanoutTick();
      ticks += 1;
      maxDeliveredPerTick = Math.max(maxDeliveredPerTick, tick.delivered.length);
      delivered.push(...tick.delivered);
      if (tick.delivered.length === 0 && tick.blocked.length === 0 && tick.skipped.length === 0) {
        break;
      }
    }

    return {
      ticks,
      delivered,
      maxDeliveredPerTick,
      remaining: this.fanoutDepth().total,
    };
  }

  resumeBlocked(subscriptionId) {
    const subscription = this.#subscriptionFor(subscriptionId);
    if (!subscription.pendingSnapshot) {
      return false;
    }
    return this.#enqueue(subscription.subscriptionId, "local");
  }

  snapshot(subscriptionId) {
    const subscription = this.#subscriptionFor(subscriptionId);
    return this.#latestSnapshotFor(subscription);
  }

  fanoutDepth() {
    const local = queueDepth(this.#queues.local);
    const crossCutting = queueDepth(this.#queues.crossCutting);
    return {
      local,
      crossCutting,
      total: local + crossCutting,
    };
  }

  coalescedBacklogDepth(subscriptionId) {
    const subscription = this.#subscriptionFor(subscriptionId);
    return this.#queued.has(subscription.subscriptionId) || subscription.pendingSnapshot ? 1 : 0;
  }

  #materializationFor(name) {
    const materializationName = assertNonEmptyString(name, "materialization");
    const materialization = this.#materializations.get(materializationName);
    if (!materialization) {
      throw new Error(`unknown materialization: ${materializationName}`);
    }
    return materialization;
  }

  #subscriptionFor(subscriptionId) {
    const normalizedSubscriptionId = assertNonEmptyString(subscriptionId, "subscriptionId");
    const subscription = this.#subscriptions.get(normalizedSubscriptionId);
    if (!subscription) {
      throw new Error(`unknown subscription: ${normalizedSubscriptionId}`);
    }
    return subscription;
  }

  #indexSubscription(subscription) {
    for (const member of subscription.materialization.readSet) {
      const key = readSetIndexKey(member);
      const bucket = this.#index.get(key) ?? new Set();
      bucket.add(subscription.subscriptionId);
      this.#index.set(key, bucket);
    }
  }

  #subscriptionsFor(event) {
    const ids = new Set([
      ...(this.#index.get(readSetIndexKey({ kind: "eventType", value: event.type })) ?? []),
      ...(this.#index.get(readSetIndexKey({ kind: "stream", value: event.streamId })) ?? []),
    ]);

    return [...ids].sort().map((id) => this.#subscriptionFor(id));
  }

  #enqueue(subscriptionId, kind) {
    const existingKind = this.#queued.get(subscriptionId);
    if (existingKind === kind || existingKind === "local") {
      return false;
    }

    if (existingKind === "crossCutting" && kind === "local") {
      this.#removeFromQueue(subscriptionId, "crossCutting");
    }

    const shard = shardFor(subscriptionId, this.#shardCount);
    this.#queues[kind][shard].add(subscriptionId);
    this.#queued.set(subscriptionId, kind);
    return true;
  }

  #removeFromQueue(subscriptionId, kind) {
    const shard = shardFor(subscriptionId, this.#shardCount);
    this.#queues[kind][shard].delete(subscriptionId);
    this.#queued.delete(subscriptionId);
  }

  #dequeueNext(kind) {
    for (let offset = 0; offset < this.#shardCount; offset += 1) {
      const shard = (this.#nextShard + offset) % this.#shardCount;
      const queue = this.#queues[kind][shard];
      const subscriptionId = queue.values().next().value;
      if (!subscriptionId) {
        continue;
      }

      queue.delete(subscriptionId);
      this.#queued.delete(subscriptionId);
      this.#nextShard = (shard + 1) % this.#shardCount;
      return subscriptionId;
    }
    return null;
  }

  #latestSnapshotFor(subscription) {
    const snapshot = this.#materialize(subscription.materialization, subscription.args);
    const floor = subscription.pendingSnapshot?.seq ?? subscription.lastSeq;
    this.#assertNonRegression(subscription, snapshot.seq, floor);
    return snapshot;
  }

  #assertNonRegression(subscription, seq, floor = subscription.lastSeq) {
    if (!isSeqAtLeast(seq, floor)) {
      throw new ReactorSeqRegressionError({
        subscriptionId: subscription.subscriptionId,
        previousSeq: floor,
        seq,
      });
    }
  }

  #clientCanAccept(subscription) {
    return !subscription.client?.canAccept || subscription.client.canAccept();
  }

  #materialize(materialization, args = {}) {
    const readSet = new Set(materialization.readSet.map(readSetIndexKey));
    let state = clone(materialization.initialState);
    const seq = {};

    for (const event of this.#canonicalEvents()) {
      if (!eventMatchesReadSet(event, readSet)) {
        continue;
      }

      state = clone(materialization.fold(clone(state), publicEvent(event), clone(args)));
      seq[event.streamId] = Math.max(seq[event.streamId] ?? 0, event.seq);
    }

    const projected = materialization.project
      ? materialization.project(clone(state), clone(args))
      : state;

    return {
      seq: stableObject(seq),
      result: normalizeResult(projected),
    };
  }

  #canonicalEvents() {
    return this.#events
      .filter((event) => this.#isCausallyVisible(event))
      .sort((left, right) => this.#compareEvents(left, right));
  }

  #isCausallyVisible(event, visited = new Set()) {
    if (!event.causationId) {
      return true;
    }
    if (visited.has(event.id)) {
      return false;
    }
    visited.add(event.id);
    const cause = this.#eventsById.get(event.causationId);
    return Boolean(cause && this.#isCausallyVisible(cause, visited));
  }

  #compareEvents(left, right) {
    if (left.id === right.id) {
      return 0;
    }
    if (this.#isAncestor(left.id, right)) {
      return -1;
    }
    if (this.#isAncestor(right.id, left)) {
      return 1;
    }
    if (left.streamId === right.streamId && left.seq !== right.seq) {
      return left.seq - right.seq;
    }
    return (
      left.ulid.localeCompare(right.ulid) ||
      left.streamId.localeCompare(right.streamId) ||
      left.seq - right.seq ||
      left.id.localeCompare(right.id)
    );
  }

  #isAncestor(candidateId, event, visited = new Set()) {
    if (!event.causationId || visited.has(event.id)) {
      return false;
    }
    if (event.causationId === candidateId) {
      return true;
    }
    visited.add(event.id);
    const cause = this.#eventsById.get(event.causationId);
    return Boolean(cause && this.#isAncestor(candidateId, cause, visited));
  }

  #publicSubscription(subscription) {
    return Object.freeze({
      subscriptionId: subscription.subscriptionId,
      materialization: subscription.materialization.name,
      args: clone(subscription.args),
      readSet: subscription.materialization.readSet,
      lastSeq: clone(subscription.lastSeq),
    });
  }
}

function normalizeReadSet(readSet) {
  if (!Array.isArray(readSet) || readSet.length === 0) {
    throw new Error("readSet must be a non-empty array");
  }

  const members = new Map();
  for (const member of readSet) {
    assertObject(member, "readSet member");
    const normalized = Object.freeze({
      kind: assertReadSetKind(member.kind),
      value: assertNonEmptyString(member.value, "readSet.value"),
    });
    members.set(readSetIndexKey(normalized), normalized);
  }

  return Object.freeze([...members.values()].sort((left, right) => readSetIndexKey(left).localeCompare(readSetIndexKey(right))));
}

function normalizeEvent(event) {
  assertObject(event, "event");
  const normalized = {
    id: assertNonEmptyString(event.id, "event.id"),
    ulid: assertNonEmptyString(event.ulid ?? event.id, "event.ulid"),
    streamId: assertNonEmptyString(event.streamId, "event.streamId"),
    seq: assertSeq(event.seq, "event.seq"),
    type: assertNonEmptyString(event.type, "event.type"),
    data: clone(event.data ?? {}),
  };
  if (event.causationId !== undefined) {
    normalized.causationId = assertNonEmptyString(event.causationId, "event.causationId");
  }
  return Object.freeze(normalized);
}

function normalizeSeqVector(seq) {
  if (seq === undefined) {
    return {};
  }
  assertObject(seq, "seq");
  return stableObject(
    Object.fromEntries(
      Object.entries(seq).map(([streamId, value]) => [
        assertNonEmptyString(streamId, "seq streamId"),
        assertSeq(value, `seq.${streamId}`),
      ]),
    ),
  );
}

function normalizeClient(client) {
  if (!client || !(client.push instanceof Function)) {
    throw new Error("client must expose push(event)");
  }
  if (client.canAccept && !(client.canAccept instanceof Function)) {
    throw new Error("client.canAccept must be a function when provided");
  }
  return client;
}

function normalizeResult(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(clone).sort(compareRows));
  }
  if (value && isJsonObject(value)) {
    return stableObjectDeep(value);
  }
  return value;
}

function eventMatchesReadSet(event, readSet) {
  return (
    readSet.has(readSetIndexKey({ kind: "eventType", value: event.type })) ||
    readSet.has(readSetIndexKey({ kind: "stream", value: event.streamId }))
  );
}

function isCrossCuttingEvent(event) {
  return event.type === "flag.Changed" || event.type === "session.Revoked";
}

function publicEvent(event) {
  return clone(event);
}

function readSetIndexKey(member) {
  return `${member.kind}:${member.value}`;
}

function createShardSets(count) {
  return Array.from({ length: count }, () => new Set());
}

function queueDepth(queues) {
  return queues.reduce((total, queue) => total + queue.size, 0);
}

function shardFor(value, shardCount) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash % shardCount;
}

function assertReadSetKind(kind) {
  if (kind !== "eventType" && kind !== "stream") {
    throw new Error("readSet.kind must be eventType or stream");
  }
  return kind;
}

function assertObject(value, field) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function assertFunction(value, field) {
  if (!(value instanceof Function)) {
    throw new Error(`${field} must be a function`);
  }
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertSeq(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function compareRows(left, right) {
  const leftId = String(left?.id ?? JSON.stringify(left));
  const rightId = String(right?.id ?? JSON.stringify(right));
  return leftId.localeCompare(rightId);
}

function stableObject(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function stableObjectDeep(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(stableObjectDeep));
  }
  if (value && isJsonObject(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, stableObjectDeep(item)]),
      ),
    );
  }
  return value;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
