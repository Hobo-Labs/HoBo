import { isJsonString, isJsonObject } from "./json.js";
export function defineMaterialization(input) {
  assertObject(input, "materialization");
  assertFunction(input.fold, "materialization.fold");

  return Object.freeze({
    name: assertNonEmptyString(input.name, "materialization.name"),
    readSet: normalizeReadSet(input.readSet),
    initialState: clone(input.initialState ?? null),
    authorize: input.authorize,
    fold: input.fold,
  });
}

export function createAuthFlagReadsetReactor(options = {}) {
  return new AuthFlagReadsetReactor(options);
}

class AuthFlagReadsetReactor {
  #materializations;
  #events = [];
  #subscriptions = new Map();
  #index = new Map();
  #nextOrder = 1;

  constructor({ materializations = [], events = [], sessions = [], flags = [] } = {}) {
    this.#materializations = new Map(materializations.map((materialization) => [materialization.name, materialization]));

    for (const event of [...sessions, ...flags, ...events]) {
      this.#appendOnly(event);
    }
  }

  subscribe({ subscriptionId, materialization, principal, client }) {
    const subscription = {
      subscriptionId: assertNonEmptyString(subscriptionId, "subscriptionId"),
      materialization: this.#getMaterialization(materialization),
      principal: normalizePrincipal(principal),
      client: normalizeClient(client),
      lastSnapshot: undefined,
    };
    if (this.#subscriptions.has(subscription.subscriptionId)) {
      throw new Error(`duplicate subscription: ${subscription.subscriptionId}`);
    }

    subscription.lastSnapshot = this.#materialize(subscription);
    this.#subscriptions.set(subscription.subscriptionId, subscription);
    this.#indexSubscription(subscription);

    return {
      subscriptionId: subscription.subscriptionId,
      materialization: subscription.materialization.name,
      principal: clone(subscription.principal),
      readSet: subscription.materialization.readSet,
      seq: clone(subscription.lastSnapshot.seq),
    };
  }

  append(event) {
    const normalized = this.#appendOnly(event);
    const subscriptions = this.#subscriptionsFor(normalized);
    const wokenSubscriptions = [];

    for (const subscription of subscriptions) {
      wokenSubscriptions.push(subscription.subscriptionId);
      const nextSnapshot = this.#materialize(subscription);
      if (deepEqual(nextSnapshot, subscription.lastSnapshot)) {
        continue;
      }

      subscription.lastSnapshot = nextSnapshot;
      subscription.client.push({
        type: "subscription.Pushed",
        subscriptionId: subscription.subscriptionId,
        decision: nextSnapshot.decision,
        ...(nextSnapshot.reason ? { reason: nextSnapshot.reason } : undefined),
        seq: clone(nextSnapshot.seq),
        result: clone(nextSnapshot.result),
      });
    }

    return {
      streamId: normalized.streamId,
      eventType: normalized.type,
      wokenSubscriptions,
    };
  }

  #appendOnly(event) {
    const normalized = Object.freeze({
      ...clone(event),
      streamId: assertNonEmptyString(event?.streamId, "event.streamId"),
      seq: assertSeq(event?.seq, "event.seq"),
      type: assertNonEmptyString(event?.type, "event.type"),
      data: clone(event?.data ?? {}),
      _order: this.#nextOrder++,
    });
    this.#events.push(normalized);
    return normalized;
  }

  #getMaterialization(name) {
    const materializationName = assertNonEmptyString(name, "materialization");
    const materialization = this.#materializations.get(materializationName);
    if (!materialization) {
      throw new Error(`unknown materialization: ${materializationName}`);
    }
    return materialization;
  }

  #indexSubscription(subscription) {
    for (const key of subscriptionKeys(subscription)) {
      const bucket = this.#index.get(key) ?? new Set();
      bucket.add(subscription.subscriptionId);
      this.#index.set(key, bucket);
    }
  }

  #subscriptionsFor(event) {
    const ids = new Set([
      ...(this.#index.get(indexKey({ kind: "eventType", value: event.type })) ?? []),
      ...(this.#index.get(indexKey({ kind: "stream", value: event.streamId })) ?? []),
      ...(this.#index.get(sessionControlKey(event)) ?? []),
      ...(this.#index.get(flagControlKey(event)) ?? []),
    ]);
    return [...ids].sort().map((id) => this.#subscriptions.get(id));
  }

  #materialize(subscription) {
    const readSet = new Set(subscription.materialization.readSet.map(indexKey));
    const seq = {};
    let state = clone(subscription.materialization.initialState);

    for (const event of this.#events) {
      if (eventMatchesReadSet(event, readSet)) {
        state = subscription.materialization.fold(clone(state), publicEvent(event), materializationContext(this.#events, subscription));
        bumpSeq(seq, event);
        continue;
      }

      if (eventAffectsSession(event, subscription.principal) || eventAffectsSubscribedFlag(event, readSet)) {
        bumpSeq(seq, event);
      }
    }

    const auth = sessionDecisionFor(this.#events, subscription.principal);
    if (auth.decision === "deny") {
      return stableObject({
        decision: "deny",
        reason: auth.reason,
        result: [],
        seq: stableObject(seq),
      });
    }

    const authorization = authorizationDecisionFor(subscription, materializationContext(this.#events, subscription));
    if (authorization.decision === "deny") {
      return stableObject({
        decision: "deny",
        reason: authorization.reason,
        result: [],
        seq: stableObject(seq),
      });
    }

    return stableObject({
      decision: "allow",
      result: normalizeResult(state),
      seq: stableObject(seq),
    });
  }
}

function subscriptionKeys(subscription) {
  const keys = [];
  for (const member of subscription.materialization.readSet) {
    keys.push(indexKey(member));
    if (member.kind === "authState" && member.value === "session") {
      keys.push(`authSession:${subscription.principal.id}:${subscription.principal.sessionId}`);
    }
    if (member.kind === "flagState") {
      keys.push(`flagState:${member.value}`);
    }
  }
  return keys;
}

function eventMatchesReadSet(event, readSet) {
  return (
    readSet.has(indexKey({ kind: "eventType", value: event.type })) ||
    readSet.has(indexKey({ kind: "stream", value: event.streamId }))
  );
}

function eventAffectsSession(event, principal) {
  return (
    (event.type === "session.Started" || event.type === "session.Refreshed" || event.type === "session.Revoked") &&
    event.data.principalId === principal.id &&
    event.data.sessionId === principal.sessionId
  );
}

function materializationContext(events, subscription) {
  const readableFlags = new Set(
    subscription.materialization.readSet.filter((member) => member.kind === "flagState").map((member) => member.value),
  );

  return {
    principal: clone(subscription.principal),
    flag: (key) => {
      const flagKey = assertNonEmptyString(key, "flag key");
      if (!readableFlags.has(flagKey)) {
        throw new Error(`flag read missing readSet member: ${flagKey}`);
      }
      return flagValueFor(events, flagKey);
    },
  };
}

function authorizationDecisionFor(subscription, context) {
  if (!subscription.materialization.authorize) {
    return { decision: "allow" };
  }

  try {
    return subscription.materialization.authorize(context) === false
      ? { decision: "deny", reason: "auth-denied" }
      : { decision: "allow" };
  } catch {
    return { decision: "deny", reason: "auth-recompute-failed" };
  }
}

function sessionDecisionFor(events, principal) {
  let active = false;
  for (const event of events) {
    if (!eventAffectsSession(event, principal)) {
      continue;
    }
    if (event.type === "session.Started") {
      active = true;
    }
    if (event.type === "session.Revoked") {
      return { decision: "deny", reason: "session-revoked" };
    }
  }
  return active ? { decision: "allow" } : { decision: "deny", reason: "session-missing" };
}

function eventAffectsSubscribedFlag(event, readSet) {
  return readSet.has(flagControlKey(event));
}

function flagValueFor(events, key) {
  const flagKey = assertNonEmptyString(key, "flag key");
  let value = false;
  for (const event of events) {
    if ((event.type === "flag.Defined" || event.type === "flag.Changed") && event.data.key === flagKey) {
      value = Boolean(event.data.value);
    }
  }
  return value;
}

function sessionControlKey(event) {
  if (event?.type !== "session.Started" && event?.type !== "session.Refreshed" && event?.type !== "session.Revoked") {
    return "";
  }
  return `authSession:${event.data.principalId}:${event.data.sessionId}`;
}

function flagControlKey(event) {
  if (event?.type !== "flag.Defined" && event?.type !== "flag.Changed") {
    return "";
  }
  return `flagState:${event.data.key}`;
}

function bumpSeq(seq, event) {
  seq[event.streamId] = Math.max(seq[event.streamId] ?? 0, event.seq);
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
    members.set(indexKey(normalized), normalized);
  }

  return Object.freeze([...members.values()].sort((left, right) => indexKey(left).localeCompare(indexKey(right))));
}

function normalizePrincipal(principal) {
  assertObject(principal, "principal");
  return Object.freeze({
    id: assertNonEmptyString(principal.id, "principal.id"),
    sessionId: assertNonEmptyString(principal.sessionId, "principal.sessionId"),
  });
}

function normalizeClient(client) {
  if (!client || !(client.push instanceof Function)) {
    throw new Error("client must expose push(event)");
  }
  return client;
}

function assertReadSetKind(kind) {
  if (!["eventType", "stream", "authState", "flagState"].includes(kind)) {
    throw new Error("readSet.kind must be eventType, stream, authState, or flagState");
  }
  return kind;
}

function indexKey(member) {
  return `${member.kind}:${member.value}`;
}

function publicEvent(event) {
  const { _order, ...rest } = event;
  return clone(rest);
}

function normalizeResult(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(clone).sort((left, right) => String(left?.id).localeCompare(String(right?.id))));
  }
  if (value && isJsonObject(value)) {
    return stableObject(value);
  }
  return value;
}

function stableObject(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertObject(value, field) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
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

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
