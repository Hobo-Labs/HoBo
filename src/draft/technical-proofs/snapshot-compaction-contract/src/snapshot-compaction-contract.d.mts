import { type JsonObject } from "./json.js";
export interface SnapshotCompactionEvent<TData = unknown> {
  readonly data: TData;
  readonly seq?: number;
  readonly streamId: string;
  readonly timestamp?: number;
  readonly type: string;
}

export interface StoredSnapshot<TState = unknown> {
  readonly contract: string;
  readonly digest: string;
  readonly eventDigest: string;
  readonly seq: number;
  readonly state: TState;
  readonly streamId: string;
}

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
}

export class CompactionRejectedError extends Error {
  readonly details: JsonObject;
}

export class RetentionFloorError extends Error {
  readonly details: JsonObject;
}

export function createSnapshotCompactionLog(): SnapshotCompactionLog;
export function foldCounter(
  state: { count: number; total: number } | undefined,
  event: SnapshotCompactionEvent,
): { count: number; total: number };
