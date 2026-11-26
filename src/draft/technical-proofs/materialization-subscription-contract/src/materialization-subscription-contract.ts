import crypto from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const subscriptionEventTypes = new Set([
  "subscription.Opened",
  "subscription.Recomputed",
  "subscription.Pushed",
  "subscription.Closed",
  "data.Changed",
]);

const changeOps = new Set(["insert", "update", "delete"]);

export function createSubscriptionOpened({ subscriptionId, materialization, args = {}, readSet, lastSeq = {} }) {
  return validateSubscriptionEvent({
    type: "subscription.Opened",
    subscriptionId,
    materialization,
    args,
    readSet: normalizeReadSet(readSet),
    lastSeq: normalizeSeqVector(lastSeq),
  });
}

export function createSubscriptionRecomputed({ subscriptionId, seq, readSet }) {
  const normalizedReadSet = normalizeReadSet(readSet);
  return validateSubscriptionEvent({
    type: "subscription.Recomputed",
    subscriptionId,
    seq: normalizeSeqVector(seq),
    readSet: normalizedReadSet,
    readSetHash: hashReadSet(normalizedReadSet),
  });
}

export function createSubscriptionClosed({ subscriptionId, reason }) {
  return validateSubscriptionEvent({
    type: "subscription.Closed",
    subscriptionId,
    reason,
  });
}

export function createSubscriptionPushed({ subscriptionId, seq, result }) {
  return validateSubscriptionEvent({
    type: "subscription.Pushed",
    subscriptionId,
    seq: normalizeSeqVector(seq),
    result,
  });
}

export function createDataChanged({ resource, key, op, sourceSeq }) {
  return validateSubscriptionEvent({
    type: "data.Changed",
    resource,
    key,
    op,
    sourceSeq,
  });
}

export function validateSubscriptionEvent(event) {
  if (!event || !subscriptionEventTypes.has(event.type)) {
    throw new Error(`unknown subscription event type: ${event?.type ?? "<missing>"}`);
  }

  switch (event.type) {
    case "subscription.Opened":
      assertNonEmpty(event.subscriptionId, "subscriptionId");
      assertNonEmpty(event.materialization, "materialization");
      normalizeReadSet(event.readSet);
      normalizeSeqVector(event.lastSeq);
      return event;
    case "subscription.Recomputed":
      assertNonEmpty(event.subscriptionId, "subscriptionId");
      normalizeSeqVector(event.seq);
      if (event.readSetHash !== hashReadSet(event.readSet)) {
        throw new Error("subscription.Recomputed readSetHash does not match readSet");
      }
      return event;
    case "subscription.Pushed":
      assertNonEmpty(event.subscriptionId, "subscriptionId");
      normalizeSeqVector(event.seq);
      if (!Object.hasOwn(event, "result")) {
        throw new Error("subscription.Pushed requires result");
      }
      return event;
    case "subscription.Closed":
      assertNonEmpty(event.subscriptionId, "subscriptionId");
      assertNonEmpty(event.reason, "reason");
      return event;
    case "data.Changed":
      assertNonEmpty(event.resource, "resource");
      assertNonEmpty(event.key, "key");
      if (!changeOps.has(event.op)) {
        throw new Error(`data.Changed op must be one of ${[...changeOps].join(", ")}`);
      }
      assertNonNegativeInteger(event.sourceSeq, "sourceSeq");
      return event;
    default:
      throw new Error(`unhandled event type: ${event.type}`);
  }
}

export function appendSubscriptionFact(log, event) {
  validateSubscriptionEvent(event);
  if (event.type === "subscription.Pushed") {
    return log;
  }
  log.push(structuredClone(event));
  return log;
}

export function rebuildSubscriptionState(log, subscriptionId) {
  let state = null;

  for (const event of log) {
    validateSubscriptionEvent(event);
    if (event.subscriptionId !== subscriptionId) {
      continue;
    }

    if (event.type === "subscription.Opened") {
      state = {
        subscriptionId,
        materialization: event.materialization,
        args: structuredClone(event.args),
        readSet: normalizeReadSet(event.readSet),
        lastSeq: normalizeSeqVector(event.lastSeq),
        status: "active",
      };
    }

    if (event.type === "subscription.Recomputed") {
      if (!state) {
        throw new Error(`subscription.Recomputed before subscription.Opened for ${subscriptionId}`);
      }
      state.readSet = normalizeReadSet(event.readSet);
      state.lastSeq = normalizeSeqVector(event.seq);
      state.status = "active";
    }

    if (event.type === "subscription.Closed") {
      if (!state) {
        throw new Error(`subscription.Closed before subscription.Opened for ${subscriptionId}`);
      }
      state.status = "closed";
      state.closeReason = event.reason;
    }
  }

  if (!state) {
    throw new Error(`subscription not found: ${subscriptionId}`);
  }

  return state;
}

export function detectChangeFeedAnomalies(changes) {
  const lastByKey = new Map();
  const anomalies = [];

  for (const change of changes) {
    validateSubscriptionEvent(change);
    if (change.type !== "data.Changed") {
      throw new Error(`expected data.Changed, got ${change.type}`);
    }

    const key = `${change.resource}\u0000${change.key}`;
    const previous = lastByKey.get(key);

    if (previous === change.sourceSeq) {
      anomalies.push({
        resource: change.resource,
        key: change.key,
        reason: "duplicate-source-seq",
        sourceSeq: change.sourceSeq,
      });
    } else if (previous > change.sourceSeq) {
      anomalies.push({
        resource: change.resource,
        key: change.key,
        reason: "non-monotonic-source-seq",
        previousSourceSeq: previous,
        sourceSeq: change.sourceSeq,
      });
    }

    lastByKey.set(key, Math.max(previous ?? -1, change.sourceSeq));
  }

  return anomalies;
}

export function normalizeReadSet(readSet) {
  if (!Array.isArray(readSet) || readSet.length === 0) {
    throw new Error("readSet must be a non-empty array");
  }

  const members = new Map();

  for (const member of readSet) {
    if (!member || !isJsonObject(member)) {
      throw new Error("readSet member must be an object");
    }
    assertNonEmpty(member.kind, "readSet.kind");
    assertNonEmpty(member.value, "readSet.value");
    members.set(`${member.kind}\u0000${member.value}`, { kind: member.kind, value: member.value });
  }

  return [...members.values()].sort((left, right) =>
    `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`),
  );
}

export function hashReadSet(readSet) {
  return crypto.createHash("sha256").update(JSON.stringify(normalizeReadSet(readSet))).digest("hex");
}

function normalizeSeqVector(seq) {
  if (!seq || !isJsonObject(seq) || Array.isArray(seq)) {
    throw new Error("seq vector must be an object");
  }

  return Object.fromEntries(
    Object.entries(seq)
      .map(([streamId, value]) => {
        assertNonEmpty(streamId, "streamId");
        assertNonNegativeInteger(value, `seq.${streamId}`);
        return [streamId, value];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function assertNonEmpty(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}
