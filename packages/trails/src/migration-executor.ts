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
 */

import {
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
	 */
	readonly replayErasures?: (
		snapshot: SchemaSnapshotRef,
	) => number | Promise<number>;
}

export async function executeDataMigration(
	options: ExecuteDataMigrationOptions,
): Promise<DataMigrationResult> {
	const { policy, replayErasures } = options;
	const result = await runInPlaceEvolve({
		// SAFETY: the two port shapes are identical except that Trails' JSON type also admits `undefined`, which a JSON evidence row never contains.
		port: options.port as EngineSchemaApplyPort,
		plan: options.plan,
		compatGate: options.compatGate,
		...(options.clock === undefined ? undefined : { clock: options.clock }),
		...(options.onFact === undefined ? undefined : { onFact: options.onFact }),
		...(policy === undefined ? undefined : { policy }),
		...(replayErasures === undefined ? undefined : { replayErasures }),
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
