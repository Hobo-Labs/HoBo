export class ReactorSeqRegressionError extends Error {
  constructor({ streamId, previousSeq, seq }) {
    super(`reactor append regressed ${streamId}: previous=${previousSeq}, next=${seq}`);
    this.name = "ReactorSeqRegressionError";
    this.streamId = streamId;
    this.previousSeq = previousSeq;
    this.seq = seq;
  }
}

const tagOf = Object.prototype.toString;

export function defineMaterialization(input) {
  assertObject(input, "materialization");
  assertFunction(input.fold, "materialization.fold");

  return Object.freeze({
    name: assertNonEmptyString(input.name, "materialization.name"),
    readSet: normalizeReadSet(input.readSet),
    initialState: clone(input.initialState ?? null),
    fold: input.fold,
  });
}

export function createInMemoryReactor(options = {}) {
  return new InMemoryReactor(options);
}

export function isSeqAtLeast(candidate, floor) {
  const normalizedCandidate = normalizeSeqVector(candidate);
  const normalizedFloor = normalizeSeqVector(floor);

  return Object.entries(normalizedFloor).every(([streamId, seq]) => (normalizedCandidate[streamId] ?? -1) >= seq);
}

class InMemoryReactor {
  #materializations;
  #eventLog = [];
  #subscriptions = new Map();
  #subscriptionFacts = [];
  #index = new Map();
  #nextEventOrder = 1;

  constructor({ materializations = [], eventLog = [], subscriptionFacts = [] } = {}) {
    this.#materializations = new Map(
      materializations.map((materialization) => [materialization.name, materialization]),
    );

    for (const event of eventLog) {
      this.#appendEventOnly(event);
    }

    for (const fact of subscriptionFacts) {
      this.#applySubscriptionFact(fact);
    }
  }

  subscribe({ subscriptionId, materialization, args = {}, client = null }) {
    const subscription = this.#createSubscription({ subscriptionId, materialization, args, client });
    if (this.#subscriptions.has(subscription.subscriptionId)) {
      throw new Error(`duplicate subscription: ${subscription.subscriptionId}`);
    }

    const snapshot = this.#materialize(subscription.materialization, subscription.args);
    subscription.lastSeq = snapshot.seq;
    subscription.lastResult = snapshot.result;

    this.#subscriptions.set(subscription.subscriptionId, subscription);
    this.#indexSubscription(subscription);

    this.#recordSubscriptionFact({
      type: "subscription.Opened",
      subscriptionId: subscription.subscriptionId,
      materialization: subscription.materialization.name,
      args: clone(subscription.args),
      readSet: subscription.materialization.readSet,
      lastSeq: subscription.lastSeq,
    });

    return this.#publicSubscription(subscription);
  }

  attachClient(subscriptionId, client) {
    const subscription = this.#getSubscription(subscriptionId);
    subscription.client = normalizeClient(client);
    return this.#publicSubscription(subscription);
  }

  append(event) {
    const normalized = this.#appendEventOnly(event);
    const subscriptions = this.#subscriptionsFor(normalized);
    const wokenSubscriptions = [];

    for (const subscription of subscriptions) {
      wokenSubscriptions.push(subscription.subscriptionId);
      const snapshot = this.#materialize(subscription.materialization, subscription.args);
      if (!isSeqAtLeast(snapshot.seq, subscription.lastSeq)) {
        throw new ReactorSeqRegressionError({
          streamId: normalized.streamId,
          previousSeq: subscription.lastSeq[normalized.streamId],
          seq: snapshot.seq[normalized.streamId],
        });
      }

      const changed = !deepEqual(snapshot.result, subscription.lastResult);
      subscription.lastSeq = snapshot.seq;

      this.#recordSubscriptionFact({
        type: "subscription.Recomputed",
        subscriptionId: subscription.subscriptionId,
        seq: snapshot.seq,
        readSet: subscription.materialization.readSet,
      });

      if (!changed) {
        continue;
      }

      subscription.lastResult = snapshot.result;
      const pushed = {
        type: "subscription.Pushed",
        subscriptionId: subscription.subscriptionId,
        seq: clone(snapshot.seq),
        result: clone(snapshot.result),
      };
      subscription.client?.push(pushed);
    }

    return {
      streamId: normalized.streamId,
      eventType: normalized.type,
      wokenSubscriptions,
    };
  }

  exportEventLog() {
    return this.#eventLog.map(({ _order, ...event }) => clone(event));
  }

  exportSubscriptionFacts() {
    return this.#subscriptionFacts.map(clone);
  }

  #createSubscription({ subscriptionId, materialization, args, client }) {
    const materializationName = assertNonEmptyString(materialization, "materialization");
    const definition = this.#materializations.get(materializationName);
    if (!definition) {
      throw new Error(`unknown materialization: ${materializationName}`);
    }

    return {
      subscriptionId: assertNonEmptyString(subscriptionId, "subscriptionId"),
      materialization: definition,
      args: clone(args),
      client: client ? normalizeClient(client) : null,
      lastSeq: {},
      lastResult: undefined,
    };
  }

  #appendEventOnly(event) {
    const normalized = normalizeEvent(event);
    const previousSeq = this.#streamHighWater(normalized.streamId);
    if (previousSeq >= normalized.seq) {
      throw new ReactorSeqRegressionError({
        streamId: normalized.streamId,
        previousSeq,
        seq: normalized.seq,
      });
    }

    const stored = Object.freeze({
      ...normalized,
      _order: this.#nextEventOrder++,
    });
    this.#eventLog.push(stored);
    return stored;
  }

  #streamHighWater(streamId) {
    let highWater = 0;
    for (const event of this.#eventLog) {
      if (event.streamId === streamId) {
        highWater = Math.max(highWater, event.seq);
      }
    }
    return highWater;
  }

  #applySubscriptionFact(fact) {
    if (fact.type === "subscription.Opened") {
      const subscription = this.#createSubscription({
        subscriptionId: fact.subscriptionId,
        materialization: fact.materialization,
        args: fact.args ?? {},
      });
      const snapshot = this.#materialize(subscription.materialization, subscription.args);
      subscription.lastSeq = snapshot.seq;
      subscription.lastResult = snapshot.result;
      this.#subscriptions.set(subscription.subscriptionId, subscription);
      this.#indexSubscription(subscription);
      this.#recordSubscriptionFact(fact);
      return;
    }

    if (fact.type === "subscription.Closed") {
      const subscriptionId = assertNonEmptyString(fact.subscriptionId, "subscriptionId");
      const subscription = this.#subscriptions.get(subscriptionId);
      if (subscription) {
        this.#unindexSubscription(subscription);
      }
      this.#subscriptions.delete(subscriptionId);
      this.#recordSubscriptionFact(fact);
      return;
    }

    if (fact.type === "subscription.Recomputed") {
      this.#recordSubscriptionFact(fact);
      return;
    }

    throw new Error(`unknown subscription fact: ${fact.type ?? "<missing>"}`);
  }

  #indexSubscription(subscription) {
    for (const member of subscription.materialization.readSet) {
      const key = readSetIndexKey(member);
      const bucket = this.#index.get(key) ?? new Set();
      bucket.add(subscription.subscriptionId);
      this.#index.set(key, bucket);
    }
  }

  #unindexSubscription(subscription) {
    for (const member of subscription.materialization.readSet) {
      const key = readSetIndexKey(member);
      const bucket = this.#index.get(key);
      if (!bucket) {
        continue;
      }

      bucket.delete(subscription.subscriptionId);
      if (bucket.size === 0) {
        this.#index.delete(key);
      }
    }
  }

  #subscriptionsFor(event) {
    const ids = new Set([
      ...(this.#index.get(readSetIndexKey({ kind: "eventType", value: event.type })) ?? []),
      ...(this.#index.get(readSetIndexKey({ kind: "stream", value: event.streamId })) ?? []),
    ]);

    return [...ids].sort().map((id) => this.#getSubscription(id));
  }

  #materialize(materialization, args = {}) {
    const readSet = new Set(materialization.readSet.map(readSetIndexKey));
    let state = clone(materialization.initialState);
    const seq = {};

    for (const event of this.#eventLog) {
      if (!eventMatchesReadSet(event, readSet)) {
        continue;
      }

      state = clone(materialization.fold(clone(state), cloneWithoutOrder(event), clone(args)));
      seq[event.streamId] = Math.max(seq[event.streamId] ?? 0, event.seq);
    }

    return {
      seq: stableObject(seq),
      result: normalizeResult(state),
    };
  }

  #getSubscription(subscriptionId) {
    const id = assertNonEmptyString(subscriptionId, "subscriptionId");
    const subscription = this.#subscriptions.get(id);
    if (!subscription) {
      throw new Error(`unknown subscription: ${id}`);
    }
    return subscription;
  }

  #recordSubscriptionFact(fact) {
    this.#subscriptionFacts.push(clone(fact));
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
  return Object.freeze({
    ...clone(event),
    streamId: assertNonEmptyString(event.streamId, "event.streamId"),
    seq: assertSeq(event.seq, "event.seq"),
    type: assertNonEmptyString(event.type, "event.type"),
    data: clone(event.data ?? {}),
  });
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
  return client;
}

function normalizeResult(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(clone).sort(compareRows));
  }
  if (value && isObjectTag(value)) {
    return stableObject(value);
  }
  return value;
}

function compareRows(left, right) {
  const leftId = String(left?.id ?? JSON.stringify(left));
  const rightId = String(right?.id ?? JSON.stringify(right));
  return leftId.localeCompare(rightId);
}

function eventMatchesReadSet(event, readSet) {
  return (
    readSet.has(readSetIndexKey({ kind: "eventType", value: event.type })) ||
    readSet.has(readSetIndexKey({ kind: "stream", value: event.streamId }))
  );
}

function readSetIndexKey(member) {
  return `${member.kind}:${member.value}`;
}

function cloneWithoutOrder(event) {
  const { _order, ...publicEvent } = event;
  return clone(publicEvent);
}

function assertReadSetKind(kind) {
  if (kind !== "eventType" && kind !== "stream") {
    throw new Error("readSet.kind must be eventType or stream");
  }
  return kind;
}

function assertObject(value, field) {
  if (!value || !isObjectTag(value) || Array.isArray(value)) {
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
  if (!isString(value) || value.trim() === "") {
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

function stableObject(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
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

function isString(value) {
  return tagOf.call(value) === "[object String]";
}

function isObjectTag(value) {
  return tagOf.call(value) === "[object Object]";
}
