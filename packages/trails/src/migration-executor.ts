/**
 * Live data-migration executor (ADR-0032 §3-4): expand → backfill → contract
 * as gated saga steps over a real store, emitting the `migration.*` event
 * family.
 *
 * The executor itself is `@hobo/data-core`'s `in-place-evolve` pattern
 * (ADR-0177): this module is the Trails-owned surface over it, so the sealed
 * public types stay Trails' own while there is exactly one implementation. Only the contract phase is destructive; it is blocked while a
 * compatibility gate reports consumers still reading the old shape (Plan 29 /
 * PACT — a drop that would break a still-running consumer never executes).
 * Failure compensates by restoring the pre-migration snapshot (forward-only
 * recovery: snapshot + redeploy last-good Set; no `.down` scripts).
 *
 * Given a `journal`, a migration is resumable: run again after a hold, it
 * skips the phases already applied and never re-applies `expand`, and the
 * snapshot it restores on failure is the first one taken.
 */

import {
	type MigrationJournal as EngineMigrationJournal,
	type SchemaApplyPort as EngineSchemaApplyPort,
	runInPlaceEvolve,
} from "@hobo/data-core";
import type { JsonObject } from "./json.js";
import type {
	SchemaApplyPort,
	SchemaPhase,
	SchemaPhaseResult,
	SchemaSnapshotRef,
} from "./schema-apply-port.js";

// public-contract: migration executor schema id.
export const MIGRATION_EXECUTOR_SCHEMA = "hobo.migration-executor/v1";

export const MIGRATION_EVENTS = Object.freeze({
	Planned: "migration.Planned",
	SnapshotTaken: "migration.SnapshotTaken",
	PhaseApplied: "migration.PhaseApplied",
	Verified: "migration.Verified",
	CutOver: "migration.CutOver",
	RolledBack: "migration.RolledBack",
	Failed: "migration.Failed",
	Exported: "migration.Exported",
	Imported: "migration.Imported",
	Held: "migration.Held",
	Resumed: "migration.Resumed",
	Completed: "migration.Completed",
	FenceRequested: "migration.FenceRequested",
	RollbackDecided: "migration.RollbackDecided",
} as const);

export interface MigrationFact {
	readonly type: string;
	readonly data: JsonObject;
}

/**
 * Compatibility-gate evidence for the destructive contract phase. Consumers
 * still on the old shape block the drop; the expand/backfill dual window
 * simply stays open until they move.
 */
export interface CompatGateEvidence {
	readonly gateId: string;
	readonly consumersOnLegacySchema: readonly string[];
	readonly verifiedAt: string;
}

export interface DataMigrationPlan {
	readonly migrationId: string;
	readonly expand: readonly string[];
	readonly backfill: readonly string[];
	readonly contract: readonly string[];
	/**
	 * Violations query per verification point; empty result = verified.
	 * `afterBackfill` guards cutover-readiness; `afterContract` guards the
	 * destructive phase's outcome.
	 */
	readonly verify: {
		readonly afterBackfill: string;
		readonly afterContract?: string;
	};
}

export type DataMigrationStatus =
	| "completed"
	| "contract-blocked"
	| "held"
	| "rolled-back"
	| "failed";

/** A policy verdict as Trails sees it: the outcome and the finding codes. */
export interface DataMigrationPolicyVerdict {
	readonly ok: boolean;
	readonly findings: readonly { readonly code: string }[];
	/**
	 * The custody roles the path behind the verdict named. The migration keeps
	 * data in the store (`source`) and in the snapshot it rolls back to
	 * (`rollback-snapshot`); a verdict that names neither, or only one, does
	 * not cover it and the migration holds. Absent names none.
	 */
	readonly roles?: readonly string[];
}

/**
 * Where a migration's facts are kept between runs. Structurally the
 * `@hobo/data-core` migration journal, declared here so the sealed Trails
 * surface stays its own.
 */
export interface DataMigrationJournal {
	load(
		migrationId: string,
	): readonly MigrationFact[] | Promise<readonly MigrationFact[]>;
	/**
	 * Append one fact, on the condition that the journal holds exactly
	 * `expectedCount` facts for this migration; refuse otherwise. That
	 * compare-and-set is what stops two runs of one migration from both
	 * acting on a view only one of them still has.
	 */
	append(
		migrationId: string,
		fact: MigrationFact,
		expectedCount: number,
	): void | Promise<void>;
}

export interface DataMigrationResult {
	readonly schemaVersion: typeof MIGRATION_EXECUTOR_SCHEMA;
	readonly migrationId: string;
	readonly status: DataMigrationStatus;
	/** True when expand+backfill hold and the dual window is open. */
	readonly dualWindowOpen: boolean;
	readonly snapshot?: SchemaSnapshotRef;
	readonly phases: readonly SchemaPhaseResult[];
	readonly blockedReasons: readonly string[];
	readonly violations: readonly JsonObject[];
	readonly facts: readonly MigrationFact[];
}

export interface ExecuteDataMigrationOptions {
	readonly port: SchemaApplyPort;
	readonly plan: DataMigrationPlan;
	readonly compatGate: () => CompatGateEvidence | Promise<CompatGateEvidence>;
	readonly clock?: () => string;
	readonly onFact?: (fact: MigrationFact) => void;
	/**
	 * Recomputed before each phase. A negative verdict holds the migration at
	 * its last safe state instead of running the phase (ADR-0177 decision 9).
	 */
	readonly policy?: (
		phase: SchemaPhase,
	) => DataMigrationPolicyVerdict | Promise<DataMigrationPolicyVerdict>;
	/**
	 * Re-apply erasures recorded since the snapshot. Called after every
	 * successful restore so a rollback cannot resurrect an erased subject.
	 *
	 * A rollback needs it: without the hook a failed phase does not restore
	 * the snapshot — the migration holds instead, because a restore with
	 * nothing to replay would bring back every subject erased since. A caller
	 * with no erasures to replay says so by returning zero.
	 */
	readonly replayErasures?: (
		snapshot: SchemaSnapshotRef,
	) => number | Promise<number>;
	/**
	 * Where the migration's facts are kept. With a journal, running the same
	 * plan again resumes it — phases already applied are skipped, `expand` is
	 * never applied twice, and a failure restores the first snapshot. Without
	 * one every call starts from nothing, so a held migration must not simply
	 * be run again.
	 */
	readonly journal?: DataMigrationJournal;
}

export async function executeDataMigration(
	options: ExecuteDataMigrationOptions,
): Promise<DataMigrationResult> {
	const { policy, replayErasures, journal } = options;
	const result = await runInPlaceEvolve({
		// SAFETY: the two port shapes are identical except that Trails' JSON type also admits `undefined`, which a JSON evidence row never contains.
		port: options.port as EngineSchemaApplyPort,
		plan: options.plan,
		compatGate: options.compatGate,
		...(options.clock === undefined ? undefined : { clock: options.clock }),
		...(options.onFact === undefined ? undefined : { onFact: options.onFact }),
		...(policy === undefined ? undefined : { policy }),
		...(replayErasures === undefined ? undefined : { replayErasures }),
		...(journal === undefined
			? undefined
			: {
					// SAFETY: the two journals differ only in that Trails' JSON type also admits `undefined`, which a journaled fact never contains.
					journal: journal as EngineMigrationJournal,
				}),
	});
	return Object.freeze({
		schemaVersion: MIGRATION_EXECUTOR_SCHEMA,
		migrationId: result.migrationId,
		status: result.status,
		dualWindowOpen: result.dualWindowOpen,
		...(result.snapshot === undefined
			? undefined
			: { snapshot: result.snapshot }),
		phases: result.phases,
		blockedReasons: result.blockedReasons,
		violations: result.violations,
		facts: result.facts,
	});
}
