/**
 * Live schema-apply port (ADR-0032 §3-4): executes real expand / backfill /
 * contract SQL against a store, with a mandatory pre-contract snapshot and a
 * restore path. Rollback is forward-only — restore the pre-contract snapshot
 * and redeploy the last-good Set; there are no `.down` scripts.
 */
import { copyFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

export interface SchemaApplyPort {
	/** Snapshot the store before destructive work; returns a restorable ref. */
	snapshot(): SchemaSnapshotRef;
	/** Execute one phase's statements atomically. */
	applyPhase(
		phase: SchemaPhase,
		statements: readonly string[],
	): SchemaPhaseResult;
	/**
	 * Run a violations query; an empty result means the verification passes.
	 * Returned rows are the violating records (evidence for the fail path).
	 */
	verify(violationsSql: string): readonly JsonObject[];
	/** Restore the store from a snapshot ref (compensate-to-snapshot). */
	restore(ref: SchemaSnapshotRef): void;
	close(): void;
}

export interface CreateSqliteSchemaApplyPortOptions {
	/** Store file path; ":memory:" is refused (snapshots need a file). */
	readonly path: string;
	readonly clock?: () => string;
}

export function createSqliteSchemaApplyPort(
	options: CreateSqliteSchemaApplyPortOptions,
): SchemaApplyPort {
	if (options.path === ":memory:") {
		throw new Error(
			"schema apply requires a file-backed store: snapshots must survive the connection",
		);
	}
	const clock = options.clock ?? (() => new Date().toISOString());
	let db = new DatabaseSync(options.path);
	let snapshots = 0;

	return {
		snapshot() {
			snapshots += 1;
			const ref = `${options.path}.snapshot-${snapshots}`;
			// Checkpoint any WAL state so the file copy is the full store.
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			copyFileSync(options.path, ref);
			return Object.freeze({ ref, takenAt: clock() });
		},
		applyPhase(phase, statements) {
			if (statements.length === 0) {
				return Object.freeze({ phase, statements: 0, changes: 0 });
			}
			db.exec("BEGIN IMMEDIATE");
			let changes = 0;
			try {
				for (const statement of statements) {
					const result = db.prepare(statement).run();
					changes += Number(result.changes ?? 0);
				}
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
			return Object.freeze({ phase, statements: statements.length, changes });
		},
		verify(violationsSql) {
			return Object.freeze(
				// SAFETY: SQL result rows are JSON-shaped evidence records.
				db.prepare(violationsSql).all() as JsonObject[],
			);
		},
		restore(ref) {
			if (!existsSync(ref.ref)) {
				throw new Error(`snapshot ${ref.ref} is missing; cannot restore`);
			}
			db.close();
			copyFileSync(ref.ref, options.path);
			db = new DatabaseSync(options.path);
		},
		close() {
			db.close();
		},
	};
}
