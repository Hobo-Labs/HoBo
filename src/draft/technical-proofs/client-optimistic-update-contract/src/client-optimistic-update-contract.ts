import { isJsonString, isJsonObject } from "./json.js";
export class OptimisticSeqRegressionError extends Error {
  constructor({ subscriptionId, streamId, previousSeq, seq }) {
    super(`optimistic subscription ${subscriptionId} regressed ${streamId}: previous=${previousSeq}, next=${seq}`);
    this.name = "OptimisticSeqRegressionError";
    this.subscriptionId = subscriptionId;
    this.streamId = streamId;
    this.previousSeq = previousSeq;
    this.seq = seq;
  }
}

export function createOptimisticSubscription({ subscriptionId, initial }) {
  const id = assertNonEmptyString(subscriptionId, "subscriptionId");
  let authoritative = normalizeSnapshot(initial);
  let nextOrder = 1;
  const pending = [];
  const audit = [];

  function current() {
    let data = clone(authoritative.data);
    for (const patch of orderedPending()) {
      data = clone(patch.apply(clone(data)));
    }

    return {
      data,
      seq: clone(authoritative.seq),
      stale: pending.length > 0 ? true : authoritative.stale,
      optimistic: pending.length > 0,
      pendingCommands: orderedPending().map((patch) => patch.commandId),
    };
  }

  function applyOptimisticPatch(input) {
    assertObject(input, "optimistic patch");
    const commandId = assertNonEmptyString(input.commandId, "commandId");
    const seqFloor = normalizeSeqVector(input.seqFloor);
    assertFunction(input.apply, "optimistic patch apply");

    if (pending.some((patch) => patch.commandId === commandId)) {
      throw new Error(`duplicate optimistic command: ${commandId}`);
    }

    if (isSeqAtLeast(authoritative.seq, seqFloor)) {
      audit.push({
        type: "optimistic.AlreadySatisfied",
        commandId,
        seqFloor,
      });
      return current();
    }

    pending.push({
      commandId,
      seqFloor,
      apply: input.apply,
      order: nextOrder,
    });
    nextOrder += 1;
    audit.push({
      type: "optimistic.Applied",
      commandId,
      seqFloor,
    });

    return current();
  }

  function receiveAuthoritativePush(snapshot) {
    const next = normalizeSnapshot(snapshot);
    assertNoRegression(authoritative.seq, next.seq, id);
    authoritative = next;

    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const patch = pending[index];
      if (!isSeqAtLeast(authoritative.seq, patch.seqFloor)) {
        continue;
      }

      pending.splice(index, 1);
      audit.push({
        type: "optimistic.Reconciled",
        commandId: patch.commandId,
        seqFloor: patch.seqFloor,
        authoritativeSeq: clone(authoritative.seq),
      });
    }

    return current();
  }

  function rejectCommand(commandId, { reason } = {}) {
    const idToReject = assertNonEmptyString(commandId, "commandId");
    const index = pending.findIndex((patch) => patch.commandId === idToReject);
    if (index === -1) {
      throw new Error(`unknown pending optimistic command: ${idToReject}`);
    }

    pending.splice(index, 1);
    audit.push({
      type: "optimistic.Rejected",
      commandId: idToReject,
      reason: assertNonEmptyString(reason ?? "rejected", "reason"),
    });

    return current();
  }

  function orderedPending() {
    return [...pending].sort(comparePending);
  }

  return Object.freeze({
    applyOptimisticPatch,
    auditLog: () => audit.map(clone),
    current,
    receiveAuthoritativePush,
    rejectCommand,
  });
}

function assertNoRegression(previous, next, subscriptionId) {
  for (const [streamId, previousSeq] of Object.entries(normalizeSeqVector(previous))) {
    const nextSeq = next[streamId];
    if (nextSeq === undefined || nextSeq < previousSeq) {
      throw new OptimisticSeqRegressionError({
        subscriptionId,
        streamId,
        previousSeq,
        seq: nextSeq,
      });
    }
  }
}

function comparePending(left, right) {
  const streams = [...new Set([...Object.keys(left.seqFloor), ...Object.keys(right.seqFloor)])].sort();
  for (const streamId of streams) {
    const delta = (left.seqFloor[streamId] ?? 0) - (right.seqFloor[streamId] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return left.order - right.order;
}

function isSeqAtLeast(candidate, floor) {
  const normalizedCandidate = normalizeSeqVector(candidate);
  const normalizedFloor = normalizeSeqVector(floor);
  return Object.entries(normalizedFloor).every(([streamId, seq]) => (normalizedCandidate[streamId] ?? -1) >= seq);
}

function normalizeSnapshot(snapshot) {
  assertObject(snapshot, "snapshot");
  return Object.freeze({
    data: clone(snapshot.data),
    seq: normalizeSeqVector(snapshot.seq),
    stale: Boolean(snapshot.stale),
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

function assertObject(value, field) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function assertFunction(value, field) {
  if (!(value instanceof Function)) {
    throw new TypeError(`${field} must be a function`);
  }
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertSeq(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
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
