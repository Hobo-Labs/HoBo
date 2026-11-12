/**
 * Schema-apply port shape (ADR-0032 §3-4): real expand / backfill / contract
 * SQL against a store, with a mandatory pre-contract snapshot and a restore
 * path. Rollback is forward-only — restore the pre-contract snapshot and
 * redeploy the last-good Set; there are no `.down` scripts.
 *
 * Trails declares the port and imports no engine (ADR-0177 decision 3). The
 * shape mirrors the `@hobo/data-core` schema port structurally, so any engine
 * package's schema port — `@hobo/data-sqlite`'s, for one — satisfies it
 * without Trails naming that package or re-exporting its types.
 */
import type { JsonObject } from "./json.js";

export type SchemaPhase = "expand" | "backfill" | "contract";

export interface SchemaSnapshotRef {
	readonly ref: string;
	readonly takenAt: string;
}

export interface SchemaPhaseResult {
	readonly phase: SchemaPhase;
	readonly statements: number;
	/** Rows changed across the phase's statements (DML phases). */
	readonly changes: number;
}

/** A value an engine may answer now or later; embedded engines answer now. */
export type PortResult<T> = T | Promise<T>;

export interface SchemaApplyPort {
	/** Snapshot the store before destructive work; returns a restorable ref. */
	snapshot(): PortResult<SchemaSnapshotRef>;
	/** Execute one phase's statements atomically. */
	applyPhase(
		phase: SchemaPhase,
		statements: readonly string[],
	): PortResult<SchemaPhaseResult>;
	/**
	 * Run a violations query; an empty result means the verification passes.
	 * Returned rows are the violating records (evidence for the fail path).
	 */
	verify(violationsSql: string): PortResult<readonly JsonObject[]>;
	/** Restore the store from a snapshot ref (compensate-to-snapshot). */
	restore(ref: SchemaSnapshotRef): PortResult<void>;
}
