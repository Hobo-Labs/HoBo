import type { JsonObject } from "./json.js";

export type SchemaPhase = "expand" | "backfill" | "contract";

export interface SchemaSnapshotRef {
	readonly ref: string;
	readonly takenAt: string;
}

export interface SchemaPhaseResult {
	readonly phase: SchemaPhase;
	readonly statements: number;
	readonly changes: number;
}

export type PortResult<T> = T | Promise<T>;

export interface SchemaApplyPort {
	snapshot(): PortResult<SchemaSnapshotRef>;
	applyPhase(
		phase: SchemaPhase,
		statements: readonly string[],
	): PortResult<SchemaPhaseResult>;
	verify(violationsSql: string): PortResult<readonly JsonObject[]>;
	restore(ref: SchemaSnapshotRef): PortResult<void>;
}
