import { createCommandRuntime } from "../../cqrs-command-aggregate-contract/src/cqrs-command-aggregate-contract.js";
import {
  createInMemoryReactor,
  isSeqAtLeast,
} from "../../reactor-skeleton-contract/src/reactor-skeleton-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export class ReadsYourWritesAckViolationError extends Error {
  constructor({ subscriptionId, seqFloor, subscriptionSeq }) {
    super(
      `subscription ${subscriptionId} has not advanced to ${JSON.stringify(
        seqFloor,
      )} before ack; current=${JSON.stringify(subscriptionSeq)}`,
    );
    this.name = "ReadsYourWritesAckViolationError";
    this.subscriptionId = subscriptionId;
    this.seqFloor = clone(seqFloor);
    this.subscriptionSeq = clone(subscriptionSeq);
  }
}

export class ClientSeqRegressionError extends Error {
  constructor({ subscriptionId, streamId, previousSeq, seq }) {
    super(`client ${subscriptionId} regressed ${streamId}: previous=${previousSeq}, next=${seq}`);
    this.name = "ClientSeqRegressionError";
    this.subscriptionId = subscriptionId;
    this.streamId = streamId;
    this.previousSeq = previousSeq;
    this.seq = seq;
  }
}

export function createReadYourWritesRuntime(options = {}) {
  const commandRuntime = options.commandRuntime ?? createCommandRuntime();
  const reactor =
    options.reactor ??
    createInMemoryReactor({
      materializations: options.materializations ?? [],
    });
  const pushedBySubscription = new Map();
  const observedClientSeq = new Map();

  function subscribe(input) {
    const subscriptionId = assertNonEmptyString(input?.subscriptionId, "subscriptionId");
    pushedBySubscription.set(subscriptionId, []);
    const subscription = reactor.subscribe({
      ...input,
      client: {
        push(event) {
          recordClientPush(subscriptionId, event.seq);
          pushedBySubscription.get(subscriptionId).push(clone(event));
          input.client?.push?.(clone(event));
        },
      },
    });
    observedClientSeq.set(subscriptionId, subscription.lastSeq);
    return subscription;
  }

  function executeCommandAndAck(definition, input, executeOptions = {}) {
    const commandResult = commandRuntime.execute(definition, input, executeOptions.commandOptions ?? {});
    const appendReports = commandResult.emitted.map((event) => reactor.append(event));
    const seqFloor = { [commandResult.streamId]: commandResult.seq };
    const targetSubscriptions = new Set([
      ...(executeOptions.subscriptionIds ?? []),
      ...appendReports.flatMap((report) => report.wokenSubscriptions),
    ]);
    const advancedSubscriptions = [];

    for (const subscriptionId of [...targetSubscriptions].sort()) {
      const subscriptionSeq = subscriptionSeqFromFacts(reactor.exportSubscriptionFacts(), subscriptionId);
      assertAckAdvanced({ subscriptionId, subscriptionSeq, seqFloor });
      advancedSubscriptions.push({
        subscriptionId,
        seq: subscriptionSeq,
      });
    }

    return {
      ...clone(commandResult),
      seqFloor,
      advancedSubscriptions,
    };
  }

  function pushed(subscriptionId) {
    return (pushedBySubscription.get(assertNonEmptyString(subscriptionId, "subscriptionId")) ?? []).map(clone);
  }

  function subscriptionSeq(subscriptionId) {
    return subscriptionSeqFromFacts(reactor.exportSubscriptionFacts(), subscriptionId);
  }

  function recordClientPush(subscriptionId, seq) {
    const id = assertNonEmptyString(subscriptionId, "subscriptionId");
    const nextSeq = normalizeSeqVector(seq);
    const previousSeq = observedClientSeq.get(id) ?? {};

    for (const [streamId, previous] of Object.entries(previousSeq)) {
      const next = nextSeq[streamId];
      if (next !== undefined && next < previous) {
        throw new ClientSeqRegressionError({
          subscriptionId: id,
          streamId,
          previousSeq: previous,
          seq: next,
        });
      }
    }

    observedClientSeq.set(id, mergeSeqVectors(previousSeq, nextSeq));
  }

  return Object.freeze({
    executeCommandAndAck,
    pushed,
    recordClientPush,
    subscribe,
    subscriptionSeq,
  });
}

export function assertAckAdvanced({ subscriptionId, subscriptionSeq, seqFloor }) {
  const normalizedSubscriptionSeq = normalizeSeqVector(subscriptionSeq);
  const normalizedFloor = normalizeSeqVector(seqFloor);

  if (!isSeqAtLeast(normalizedSubscriptionSeq, normalizedFloor)) {
    throw new ReadsYourWritesAckViolationError({
      subscriptionId: assertNonEmptyString(subscriptionId, "subscriptionId"),
      seqFloor: normalizedFloor,
      subscriptionSeq: normalizedSubscriptionSeq,
    });
  }

  return {
    subscriptionId,
    seq: normalizedSubscriptionSeq,
  };
}

export function classifyReadGuarantee(projection) {
  const source = projection?.projectionDeclared?.payload?.reactivity?.source;

  if (source === "native-log") {
    return Object.freeze({
      guarantee: "read-your-writes",
      strictReadYourWrites: true,
      source,
    });
  }

  if (source === "sink-change-feed") {
    return Object.freeze({
      guarantee: "bounded-staleness",
      strictReadYourWrites: false,
      source,
    });
  }

  return Object.freeze({
    guarantee: "not-live",
    strictReadYourWrites: false,
    source: source ?? "unknown",
  });
}

function subscriptionSeqFromFacts(facts, subscriptionId) {
  const id = assertNonEmptyString(subscriptionId, "subscriptionId");
  let seq = null;

  for (const fact of facts) {
    if (fact.subscriptionId !== id) {
      continue;
    }
    if (fact.type === "subscription.Opened") {
      seq = normalizeSeqVector(fact.lastSeq);
    }
    if (fact.type === "subscription.Recomputed") {
      seq = normalizeSeqVector(fact.seq);
    }
    if (fact.type === "subscription.Closed") {
      seq = null;
    }
  }

  if (seq === null) {
    throw new Error(`subscription not found: ${id}`);
  }

  return seq;
}

function mergeSeqVectors(left, right) {
  const merged = { ...normalizeSeqVector(left) };
  for (const [streamId, seq] of Object.entries(normalizeSeqVector(right))) {
    merged[streamId] = Math.max(merged[streamId] ?? 0, seq);
  }
  return stableObject(merged);
}

function normalizeSeqVector(seq) {
  if (seq === undefined) {
    return {};
  }
  if (!seq || !isJsonObject(seq) || Array.isArray(seq)) {
    throw new TypeError("seq must be an object");
  }

  return stableObject(
    Object.fromEntries(
      Object.entries(seq).map(([streamId, value]) => [
        assertNonEmptyString(streamId, "seq streamId"),
        assertSeq(value, `seq.${streamId}`),
      ]),
    ),
  );
}

function assertSeq(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function stableObject(value) {
  return Object.freeze(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
