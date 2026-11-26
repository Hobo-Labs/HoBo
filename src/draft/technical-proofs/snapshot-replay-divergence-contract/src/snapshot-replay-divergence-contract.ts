import { createHash } from "node:crypto";
import { isJsonNumber, isJsonObject } from "./json.js";


export class SnapshotRejectedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SnapshotRejectedError";
    this.details = details;
  }
}

export class SnapshotDivergenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SnapshotDivergenceError";
    this.details = details;
  }
}

export function createSnapshot({
  events,
  throughSeq,
  fold,
  contract,
  forgettingKeys = {},
  quarantine = [],
}) {
  const prefix = canonicalEvents(events).filter((event) => event.seq <= throughSeq);
  const quarantineEntries = normalizeQuarantine(quarantine);
  const state = foldEvents({
    events: prefix,
    fold,
    contract,
    forgettingKeys,
    quarantine: quarantineEntries,
  });

  return signSnapshot({
    contractVersion: contract.contractVersion,
    erasureEpoch: contract.erasureEpoch,
    eventDigest: digestEvents(prefix),
    foldVersion: contract.foldVersion,
    quarantineDigest: digestQuarantine(quarantineEntries),
    state,
    throughSeq,
    upcasterVersion: contract.upcasterVersion,
  });
}

export function activateFromSnapshot({
  events,
  snapshot,
  fold,
  contract,
  forgettingKeys = {},
  quarantine = [],
  failOnDivergence = false,
}) {
  const orderedEvents = canonicalEvents(events);
  const maximumSeq = maxSeq(orderedEvents);
  if (snapshot.throughSeq > maximumSeq) {
    throw new SnapshotRejectedError("snapshot covers a future seq not present in the stream", {
      maximumSeq,
      snapshotSeq: snapshot.throughSeq,
    });
  }

  const validation = validateSnapshot({
    events: orderedEvents,
    snapshot,
    fold,
    contract,
    forgettingKeys,
    quarantine,
  });

  if (!validation.valid) {
    if (failOnDivergence && validation.reason === "snapshot-prefix-diverged") {
      throw new SnapshotDivergenceError("snapshot prefix diverged from current fold replay", {
        throughSeq: snapshot.throughSeq,
      });
    }

    return {
      ...replayFromZero({ events: orderedEvents, fold, contract, forgettingKeys, quarantine }),
      ignoredSnapshotReason: validation.reason,
      usedSnapshot: false,
    };
  }

  const tail = orderedEvents.filter((event) => event.seq > snapshot.throughSeq);
  const state = foldEvents({
    events: tail,
    fold,
    contract,
    forgettingKeys,
    initialState: clone(snapshot.state),
    quarantine: normalizeQuarantine(quarantine),
  });

  return {
    ignoredSnapshotReason: null,
    replayedEventSeqs: tail.map((event) => event.seq),
    state,
    throughSeq: maximumSeq,
    usedSnapshot: true,
  };
}

export function replayFromZero({ events, fold, contract, forgettingKeys = {}, quarantine = [] }) {
  const orderedEvents = canonicalEvents(events);
  return {
    replayedEventSeqs: orderedEvents.map((event) => event.seq),
    state: foldEvents({
      events: orderedEvents,
      fold,
      contract,
      forgettingKeys,
      quarantine: normalizeQuarantine(quarantine),
    }),
    throughSeq: maxSeq(orderedEvents),
  };
}

export function assertSnapshotMatchesReplayAcrossBoundaries({
  events,
  fold,
  contract,
  boundaries,
  forgettingKeys = {},
  quarantine = [],
}) {
  const fromZero = replayFromZero({ events, fold, contract, forgettingKeys, quarantine });

  for (const throughSeq of boundaries) {
    const snapshot = createSnapshot({
      events,
      throughSeq,
      fold,
      contract,
      forgettingKeys,
      quarantine,
    });
    const activated = activateFromSnapshot({
      events,
      snapshot,
      fold,
      contract,
      forgettingKeys,
      quarantine,
    });

    if (!deepEqual(activated.state, fromZero.state)) {
      throw new SnapshotDivergenceError("snapshot-tail replay diverged from from-zero replay", {
        throughSeq,
      });
    }
  }

  return {
    checkedBoundaries: boundaries.length,
    finalState: fromZero.state,
  };
}

export function foldMailbox(state = initialMailboxState(), event, context = {}) {
  const next = clone(state ?? initialMailboxState());
  if (!event) {
    return next;
  }

  const data = event.data ?? {};
  if (event.type === "ticket.Opened") {
    const lifted = upcastTicketOpened(data, context);
    assertFinitePriority(lifted.priority);
    next.open[lifted.id] = {
      id: lifted.id,
      priority: lifted.priority,
      title: lifted.title,
    };
    if (lifted.requester !== undefined) {
      next.open[lifted.id].requester = lifted.requester;
    }
    return sortMailbox(next);
  }

  if (event.type === "ticket.PriorityChanged") {
    assertFinitePriority(data.priority);
    if (next.open[data.id]) {
      next.open[data.id].priority = data.priority;
    }
    return sortMailbox(next);
  }

  if (event.type === "ticket.Closed") {
    delete next.open[data.id];
    if (!next.closed.includes(data.id)) {
      next.closed.push(data.id);
    }
    return sortMailbox(next);
  }

  return sortMailbox(next);
}

function validateSnapshot({ events, snapshot, fold, contract, forgettingKeys, quarantine }) {
  if (snapshot.contractVersion !== contract.contractVersion) {
    return invalid("contract-version-changed");
  }
  if (snapshot.foldVersion !== contract.foldVersion) {
    return invalid("fold-version-changed");
  }
  if (snapshot.upcasterVersion !== contract.upcasterVersion) {
    return invalid("upcaster-version-changed");
  }
  if (snapshot.erasureEpoch !== contract.erasureEpoch) {
    return invalid("erasure-epoch-changed");
  }

  const currentQuarantine = normalizeQuarantine(quarantine);
  if (snapshot.quarantineDigest !== digestQuarantine(currentQuarantine)) {
    return invalid("quarantine-digest-changed");
  }

  if (snapshot.digest !== signSnapshot(stripDigest(snapshot)).digest) {
    return invalid("snapshot-digest-mismatch");
  }

  const prefix = events.filter((event) => event.seq <= snapshot.throughSeq);
  if (snapshot.eventDigest !== digestEvents(prefix)) {
    return invalid("snapshot-event-digest-mismatch");
  }

  const expectedState = foldEvents({
    events: prefix,
    fold,
    contract,
    forgettingKeys,
    quarantine: currentQuarantine,
  });
  if (!deepEqual(snapshot.state, expectedState)) {
    return invalid("snapshot-prefix-diverged");
  }

  return { valid: true, reason: null };
}

function invalid(reason) {
  return { valid: false, reason };
}

function foldEvents({ events, fold, contract, forgettingKeys = {}, quarantine = [], initialState }) {
  const quarantineBySeq = new Map(normalizeQuarantine(quarantine).map((entry) => [entry.seq, entry.reason]));
  let state = initialState === undefined ? initialMailboxState() : clone(initialState);

  for (const event of canonicalEvents(events)) {
    const quarantineReason = quarantineBySeq.get(event.seq);
    if (quarantineReason) {
      state = appendQuarantine(state, { seq: event.seq, reason: quarantineReason });
      continue;
    }

    state = fold(clone(state), clone(event), {
      contract,
      forgettingKeys,
    });
  }

  return sortMailbox(state);
}

function upcastTicketOpened(data, context) {
  const title = data.title ?? data.summary;
  const requester =
    data.requesterCiphertext === undefined
      ? undefined
      : context.forgettingKeys?.requester === false
        ? "[shredded]"
        : data.requesterCiphertext;

  return {
    id: data.id,
    priority: data.priority,
    requester,
    title,
  };
}

function assertFinitePriority(priority) {
  if (!Number.isFinite(priority)) {
    throw new TypeError("priority must be finite");
  }
}

function initialMailboxState() {
  return { open: {}, closed: [], quarantined: [] };
}

function appendQuarantine(state, entry) {
  const next = clone(state ?? initialMailboxState());
  if (!next.quarantined.some((existing) => existing.seq === entry.seq)) {
    next.quarantined.push({ reason: entry.reason, seq: entry.seq });
  }
  return sortMailbox(next);
}

function sortMailbox(state) {
  return {
    open: Object.fromEntries(
      Object.entries(state.open ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
    closed: [...(state.closed ?? [])].sort(),
    quarantined: [...(state.quarantined ?? [])].sort((left, right) => left.seq - right.seq),
  };
}

function signSnapshot(snapshot) {
  return Object.freeze({
    ...clone(snapshot),
    digest: sha256(stripDigest(snapshot)),
  });
}

function stripDigest(snapshot) {
  const { digest: _digest, ...withoutDigest } = snapshot;
  return withoutDigest;
}

function digestEvents(events) {
  return sha256(canonicalEvents(events).map((event) => ({
    data: event.data,
    id: event.id,
    seq: event.seq,
    streamId: event.streamId,
    type: event.type,
  })));
}

function digestQuarantine(quarantine) {
  return sha256(normalizeQuarantine(quarantine));
}

function normalizeQuarantine(quarantine) {
  return [...quarantine]
    .map((entry) => ({ reason: entry.reason, seq: entry.seq }))
    .sort((left, right) => left.seq - right.seq || left.reason.localeCompare(right.reason));
}

function canonicalEvents(events) {
  return [...events].sort((left, right) => (
    left.seq - right.seq ||
    left.streamId.localeCompare(right.streamId) ||
    left.type.localeCompare(right.type) ||
    String(left.id).localeCompare(String(right.id))
  ));
}

function maxSeq(events) {
  return events.reduce((highest, event) => Math.max(highest, event.seq), 0);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (isJsonNumber(value)) {
    if (Number.isNaN(value)) {
      return { "$number": "NaN" };
    }
    if (value === Infinity) {
      return { "$number": "Infinity" };
    }
    if (value === -Infinity) {
      return { "$number": "-Infinity" };
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }

  return value;
}

function deepEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function clone(value) {
  return structuredClone(value);
}
