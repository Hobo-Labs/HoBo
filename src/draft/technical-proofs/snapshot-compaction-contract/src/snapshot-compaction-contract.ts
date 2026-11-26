import { isJsonNumber, isJsonObject, type JsonObject, type JsonBag } from "./json.js";
const CONTRACT_VERSION = "hobo.snapshot-compaction-contract/v1";
const NEVER_COMPACT_PREFIXES = ["token.", "resource.", "policy."] as const;
const TERMINAL_RUN_EVENTS = new Set(["run.Completed", "run.Failed", "run.Cancelled", "run.Canceled"]);

export interface SnapshotCompactionEvent<TData = unknown> {
  readonly data: TData;
  readonly seq?: number;
  readonly streamId: string;
  readonly timestamp?: number | null;
  readonly type: string;
}

type StoredEvent<TData = unknown> = SnapshotCompactionEvent<TData> & {
  readonly data: TData;
  readonly seq: number;
  readonly timestamp: number | null;
};

export interface StoredSnapshot<TState = unknown> {
  readonly contract: string;
  readonly digest: string;
  readonly eventDigest: string;
  readonly seq: number;
  readonly state: TState;
  readonly streamId: string;
}

type UnsignedSnapshot<TState> = Omit<StoredSnapshot<TState>, "digest">;

export interface SnapshotActivation<TState = unknown> {
  readonly ignoredSnapshotReason: "corrupt-snapshot" | null;
  readonly replayedEventSeqs: readonly number[];
  readonly replayedFromSeq: number | null;
  readonly state: TState;
  readonly throughSeq: number;
  readonly usedSnapshot: boolean;
}

export interface SnapshotAuditMarker {
  readonly contract: string;
  readonly covers: {
    readonly count: number;
    readonly eventDigest: string;
    readonly throughSeq: number;
  };
  readonly kind: "audit-marker";
  readonly snapshotDigest: string;
  readonly streamId: string;
  readonly type: "snapshot-compaction.audit-marker";
}

export type SnapshotFold<TState> = (
  state: TState | undefined,
  event: SnapshotCompactionEvent,
) => TState;

export interface SnapshotCompactionLog {
  append<TData = unknown>(event: SnapshotCompactionEvent<TData>): SnapshotCompactionEvent<TData>;
  writeSnapshot<TState>(
    streamId: string,
    options: { fold: SnapshotFold<TState>; throughSeq: number },
  ): StoredSnapshot<TState>;
  deleteSnapshot(streamId: string): void;
  corruptSnapshot<TState>(
    streamId: string,
    corrupt: (snapshot: StoredSnapshot<TState>) => StoredSnapshot<TState>,
  ): void;
  requireValidSnapshot<TState>(
    streamId: string,
    options: { fold: SnapshotFold<TState> },
  ): StoredSnapshot<TState>;
  activate<TState>(
    streamId: string,
    options: { fold: SnapshotFold<TState> },
  ): SnapshotActivation<TState>;
  assertSnapshotTailEquivalence<TState>(
    streamId: string,
    options: { fold: SnapshotFold<TState> },
  ): {
    readonly fromSnapshot: SnapshotActivation<TState>;
    readonly fromZero: { readonly replayedEventSeqs: readonly number[]; readonly state: TState; readonly throughSeq: number };
    readonly snapshotTailSeqs: readonly number[];
  };
  compactDomainStream<TState>(
    streamId: string,
    options: { fold: SnapshotFold<TState>; retentionFloorSeq: number; throughSeq: number },
  ): SnapshotAuditMarker;
  archiveTerminalRunStream(
    streamId: string,
    options: { now: number; retentionMs: number },
  ): { readonly archived: boolean; readonly reason: string; readonly throughSeq?: number };
  rebuildFromAuthority<TState>(
    streamId: string,
    options: { fold: SnapshotFold<TState> },
  ): { readonly replayedEventSeqs: readonly number[]; readonly state: TState; readonly throughSeq: number };
  activeEvents(streamId: string): readonly SnapshotCompactionEvent[];
  coldStorageEvents(streamId: string): readonly SnapshotCompactionEvent[];
  auditMarkers(streamId: string): readonly SnapshotAuditMarker[];
}

export class SnapshotIntegrityError extends Error {
  readonly details: JsonObject;

  constructor(message: string, details: JsonObject = {}) {
    super(message);
    this.name = "SnapshotIntegrityError";
    this.details = details;
  }
}

export class CompactionRejectedError extends Error {
  readonly details: JsonObject;

  constructor(message: string, details: JsonObject = {}) {
    super(message);
    this.name = "CompactionRejectedError";
    this.details = details;
  }
}

export class RetentionFloorError extends Error {
  readonly details: JsonObject;

  constructor(message: string, details: JsonObject = {}) {
    super(message);
    this.name = "RetentionFloorError";
    this.details = details;
  }
}

export function createSnapshotCompactionLog(): SnapshotCompactionLog {
  const activeByStream = new Map<string, StoredEvent[]>();
  const coldByStream = new Map<string, StoredEvent[]>();
  const snapshotsByStream = new Map<string, StoredSnapshot>();
  const auditMarkersByStream = new Map<string, SnapshotAuditMarker[]>();

  function streamEvents<TEvent>(map: Map<string, TEvent[]>, streamId: string): TEvent[] {
    if (!map.has(streamId)) {
      map.set(streamId, []);
    }
    return map.get(streamId) ?? [];
  }

  function authoritativeEvents(streamId: string): StoredEvent[] {
    return [...(coldByStream.get(streamId) ?? []), ...(activeByStream.get(streamId) ?? [])]
      .filter((event) => event.type !== "snapshot-compaction.audit-marker")
      .sort(compareEvents);
  }

  return {
    append<TData = unknown>(input: SnapshotCompactionEvent<TData>): SnapshotCompactionEvent<TData> {
      const events = streamEvents(activeByStream, input.streamId);
      const seq = input.seq ?? nextSeq(events, coldByStream.get(input.streamId) ?? []);
      const event = freezeEvent({ ...input, seq });
      events.push(event);
      events.sort(compareEvents);
      return event;
    },

    writeSnapshot<TState>(streamId: string, { fold, throughSeq }: { fold: SnapshotFold<TState>; throughSeq: number }): StoredSnapshot<TState> {
      const coveredEvents = authoritativeEvents(streamId).filter((event) => event.seq <= throughSeq);
      const folded = foldEvents({
        events: coveredEvents,
        fold,
      });
      const snapshot = signSnapshot({
        contract: CONTRACT_VERSION,
        streamId,
        seq: throughSeq,
        state: folded.state,
        eventDigest: digestEvents(coveredEvents),
      });

      snapshotsByStream.set(streamId, snapshot);
      return snapshot;
    },

    deleteSnapshot(streamId: string): void {
      snapshotsByStream.delete(streamId);
    },

    corruptSnapshot<TState>(streamId: string, corrupt: (snapshot: StoredSnapshot<TState>) => StoredSnapshot<TState>): void {
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      const snapshot = snapshotsByStream.get(streamId) as StoredSnapshot<TState> | undefined;
      if (!snapshot) {
        throw new SnapshotIntegrityError("cannot corrupt missing snapshot", { streamId });
      }
      snapshotsByStream.set(streamId, corrupt(structuredClone(snapshot)));
    },

    requireValidSnapshot<TState>(streamId: string, { fold }: { fold: SnapshotFold<TState> }): StoredSnapshot<TState> {
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      const snapshot = snapshotsByStream.get(streamId) as StoredSnapshot<TState> | undefined;
      if (!snapshot) {
        throw new SnapshotIntegrityError("snapshot missing", { streamId });
      }
      validateSnapshot(snapshot, streamId, authoritativeEvents(streamId), fold);
      return snapshot;
    },

    activate<TState>(streamId: string, { fold }: { fold: SnapshotFold<TState> }): SnapshotActivation<TState> {
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      const snapshot = snapshotsByStream.get(streamId) as StoredSnapshot<TState> | undefined;

      if (snapshot) {
        const validation = validateSnapshotResult(snapshot, streamId, authoritativeEvents(streamId), fold);
        if (validation.valid) {
          const tail = authoritativeEvents(streamId).filter((event) => event.seq > snapshot.seq);
          const folded = foldEvents({
            events: tail,
            fold,
            initialState: structuredClone(snapshot.state),
          });

          return {
            ignoredSnapshotReason: null,
            replayedEventSeqs: tail.map((event) => event.seq),
            replayedFromSeq: snapshot.seq + 1,
            state: folded.state,
            throughSeq: maxSeq(authoritativeEvents(streamId)),
            usedSnapshot: true,
          };
        }

        return fullReplayActivation(streamId, fold, "corrupt-snapshot");
      }

      return fullReplayActivation(streamId, fold, null);
    },

    assertSnapshotTailEquivalence<TState>(streamId: string, { fold }: { fold: SnapshotFold<TState> }) {
      const fromSnapshot = this.activate(streamId, { fold });
      const snapshot = this.requireValidSnapshot(streamId, { fold });
      const fromZero = this.rebuildFromAuthority(streamId, { fold });

      if (!deepEqual(fromSnapshot.state, fromZero.state)) {
        throw new SnapshotIntegrityError("snapshot tail replay diverged from from-zero replay", {
          streamId,
        });
      }

      return {
        fromSnapshot,
        fromZero,
        snapshotTailSeqs: authoritativeEvents(streamId)
          .filter((event) => event.seq > snapshot.seq)
          .map((event) => event.seq),
      };
    },

    compactDomainStream<TState>(
      streamId: string,
      { fold, retentionFloorSeq, throughSeq }: { fold: SnapshotFold<TState>; retentionFloorSeq: number; throughSeq: number },
    ): SnapshotAuditMarker {
      assertCompactionAllowed(streamId);
      if (throughSeq < retentionFloorSeq) {
        throw new RetentionFloorError("snapshot must cover at least the retention floor", {
          retentionFloorSeq,
          streamId,
          throughSeq,
        });
      }

      const snapshot = this.writeSnapshot(streamId, { fold, throughSeq });
      const active = streamEvents(activeByStream, streamId);
      const toArchive = active.filter((event) => event.seq <= throughSeq);
      const tail = active.filter((event) => event.seq > throughSeq);
      const cold = streamEvents(coldByStream, streamId);
      cold.push(...toArchive);
      cold.sort(compareEvents);
      activeByStream.set(streamId, tail);

      const marker = Object.freeze({
        contract: CONTRACT_VERSION,
        covers: {
          count: toArchive.length,
          eventDigest: digestEvents(toArchive),
          throughSeq,
        },
        kind: "audit-marker" as const,
        snapshotDigest: snapshot.digest,
        streamId,
        type: "snapshot-compaction.audit-marker" as const,
      });
      streamEvents(auditMarkersByStream, streamId).push(marker);
      return marker;
    },

    archiveTerminalRunStream(streamId: string, { now, retentionMs }: { now: number; retentionMs: number }) {
      if (!streamId.startsWith("run.")) {
        throw new CompactionRejectedError("only run.* streams use terminal archival", { streamId });
      }

      const active = activeByStream.get(streamId) ?? [];
      const terminal = [...active].reverse().find((event) => TERMINAL_RUN_EVENTS.has(event.type));
      if (!terminal) {
        return { archived: false, reason: "not-terminal" };
      }

      const terminalAt = terminal.timestamp ?? 0;
      if (now - terminalAt < retentionMs) {
        return { archived: false, reason: "retention-window-open" };
      }

      const cold = streamEvents(coldByStream, streamId);
      cold.push(...active);
      cold.sort(compareEvents);
      activeByStream.set(streamId, []);

      return {
        archived: true,
        reason: "terminal-retention-expired",
        throughSeq: maxSeq(cold),
      };
    },

    rebuildFromAuthority<TState>(streamId: string, { fold }: { fold: SnapshotFold<TState> }) {
      const events = authoritativeEvents(streamId);
      const folded = foldEvents({
        events,
        fold,
      });

      return {
        replayedEventSeqs: events.map((event) => event.seq),
        state: folded.state,
        throughSeq: maxSeq(events),
      };
    },

    activeEvents(streamId: string): readonly SnapshotCompactionEvent[] {
      return [...(activeByStream.get(streamId) ?? [])];
    },

    coldStorageEvents(streamId: string): readonly SnapshotCompactionEvent[] {
      return [...(coldByStream.get(streamId) ?? [])];
    },

    auditMarkers(streamId: string): readonly SnapshotAuditMarker[] {
      return [...(auditMarkersByStream.get(streamId) ?? [])];
    },
  };

  function fullReplayActivation<TState>(
    streamId: string,
    fold: SnapshotFold<TState>,
    ignoredSnapshotReason: SnapshotActivation<TState>["ignoredSnapshotReason"],
  ): SnapshotActivation<TState> {
    const events = authoritativeEvents(streamId);
    const folded = foldEvents({ events, fold });
    return {
      ignoredSnapshotReason,
      replayedEventSeqs: events.map((event) => event.seq),
      replayedFromSeq: events.length === 0 ? null : events[0]?.seq ?? null,
      state: folded.state,
      throughSeq: maxSeq(events),
      usedSnapshot: false,
    };
  }
}

export type CounterState = { count: number; total: number };

export function foldCounter(
  state: CounterState = { count: 0, total: 0 },
  event: SnapshotCompactionEvent,
): CounterState {
  if (!event.type.endsWith(".Incremented") && event.type !== "counter.Incremented") {
    return state;
  }

  const data = event.data;
  const amount = isJsonObject(data) ? data.amount : undefined;
  if (!isJsonNumber(amount) || !Number.isFinite(amount)) {
    throw new TypeError("counter increment requires finite numeric amount");
  }

  return {
    count: state.count + 1,
    total: state.total + amount,
  };
}

type FoldedState<TState> = { readonly state: TState };

function foldEvents<TState>({
  events,
  fold,
  initialState,
}: {
  readonly events: readonly StoredEvent[];
  readonly fold: SnapshotFold<TState>;
  readonly initialState?: TState;
}): FoldedState<TState> {
  let state = initialState;
  for (const event of [...events].sort(compareEvents)) {
    state = fold(state, event);
  }

  return { state: state ?? fold(undefined, nullEvent()) };
}

function nullEvent(): StoredEvent {
  return Object.freeze({
    data: {},
    seq: 0,
    streamId: "",
    timestamp: null,
    type: "__snapshot_compaction.initial__",
  });
}

function assertCompactionAllowed(streamId: string): void {
  if (NEVER_COMPACT_PREFIXES.some((prefix) => streamId.startsWith(prefix))) {
    throw new CompactionRejectedError("compliance-retained streams are never compacted", {
      protectedPrefixes: [...NEVER_COMPACT_PREFIXES],
      streamId,
    });
  }
}

function validateSnapshot<TState>(
  snapshot: StoredSnapshot<TState>,
  streamId: string,
  events: readonly StoredEvent[],
  fold: SnapshotFold<TState>,
): void {
  const result = validateSnapshotResult(snapshot, streamId, events, fold);
  if (!result.valid) {
    throw new SnapshotIntegrityError(result.reason, { streamId });
  }
}

function validateSnapshotResult<TState>(
  snapshot: StoredSnapshot<TState>,
  streamId: string,
  events: readonly StoredEvent[],
  fold: SnapshotFold<TState>,
): { readonly valid: true; readonly reason: null } | { readonly valid: false; readonly reason: string } {
  if (snapshot.contract !== CONTRACT_VERSION || snapshot.streamId !== streamId) {
    return { valid: false, reason: "snapshot-metadata-mismatch" };
  }

  const prefix = events.filter((event) => event.seq <= snapshot.seq);
  const expected = signSnapshot({
    contract: CONTRACT_VERSION,
    eventDigest: digestEvents(prefix),
    seq: snapshot.seq,
    state: foldEvents({ events: prefix, fold }).state,
    streamId,
  });

  if (!deepEqual(snapshot.state, expected.state) || snapshot.digest !== expected.digest) {
    return { valid: false, reason: "corrupt-snapshot" };
  }

  return { valid: true, reason: null };
}

function signSnapshot<TState>(snapshot: UnsignedSnapshot<TState>): StoredSnapshot<TState> {
  const digest = hashStable({
    contract: snapshot.contract,
    eventDigest: snapshot.eventDigest,
    seq: snapshot.seq,
    state: snapshot.state,
    streamId: snapshot.streamId,
  });

  return Object.freeze({
    ...structuredClone(snapshot),
    digest,
  });
}

function digestEvents(events: readonly StoredEvent[]): string {
  return hashStable(events.map((event) => ({ data: event.data, seq: event.seq, streamId: event.streamId, type: event.type })));
}

function hashStable<T>(value: T): string {
  const json = JSON.stringify(sortStable(value));
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5];
  const hashes = seeds.map((seed) => seed >>> 0);

  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex += 1) {
      hashes[hashIndex] = Math.imul(hashes[hashIndex] ^ code, 0x01000193 + hashIndex * 2) >>> 0;
    }
  }

  return hashes.map((hash) => hash.toString(16).padStart(8, "0")).join("");
}

function sortStable<T>(value: T): T {
  if (Array.isArray(value)) {
    const sorted: T =
      // SAFETY: array entries are recursively sorted with the same T contract.
      value.map((entry) => sortStable(entry)) as never;
    return sorted;
  }
  if (value && isJsonObject(value)) {
    const bag: JsonBag = {};
    for (const key of Object.keys(value).sort()) {
      bag[key] = sortStable(value[key] ?? null);
    }
    const sorted: T =
      // SAFETY: sorted bag preserves the caller's JSON-compatible object contract.
      bag as never;
    return sorted;
  }
  return value;
}

function freezeEvent<TData>(input: SnapshotCompactionEvent<TData> & { readonly seq: number }): StoredEvent<TData> {
  return Object.freeze({
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    data: input.data ?? ({} as TData),
    seq: input.seq,
    streamId: input.streamId,
    timestamp: input.timestamp ?? null,
    type: input.type,
  });
}

function nextSeq(active: readonly StoredEvent[], cold: readonly StoredEvent[]): number {
  return maxSeq([...active, ...cold]) + 1;
}

function maxSeq(events: readonly StoredEvent[]): number {
  return events.reduce((highest, event) => Math.max(highest, event.seq), 0);
}

function compareEvents(left: StoredEvent, right: StoredEvent): number {
  return left.seq - right.seq || left.streamId.localeCompare(right.streamId) || left.type.localeCompare(right.type);
}

function deepEqual<T>(left: T, right: T): boolean {
  return JSON.stringify(sortStable(left)) === JSON.stringify(sortStable(right));
}
