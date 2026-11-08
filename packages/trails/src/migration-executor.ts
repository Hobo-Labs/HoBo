/**
 * Live data-migration executor (ADR-0032 §3-4): expand → backfill → contract
 * as gated saga steps over a real store, emitting the `migration.*` event
 * family. Only the contract phase is destructive; it is blocked while a
 * compatibility gate reports consumers still reading the old shape (Plan 29 /
 * PACT — a drop that would break a still-running consumer never executes).
 * Failure compensates by restoring the pre-migration snapshot (forward-only
 * recovery: snapshot + redeploy last-good Set; no `.down` scripts).
 */

import type { JsonObject } from "./json.js";
import type {
	SchemaApplyPort,
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
	| "rolled-back"
	| "failed";

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
}

export async function executeDataMigration(
	options: ExecuteDataMigrationOptions,
): Promise<DataMigrationResult> {
	const clock = options.clock ?? (() => new Date().toISOString());
	const { plan, port } = options;
	const facts: MigrationFact[] = [];
	const phases: SchemaPhaseResult[] = [];
	const emit = (type: string, data: JsonObject) => {
		const fact = Object.freeze({ type, data: Object.freeze({ ...data }) });
		facts.push(fact);
		options.onFact?.(fact);
	};
	const finish = (input: {
		status: DataMigrationStatus;
		dualWindowOpen: boolean;
		snapshot?: SchemaSnapshotRef;
		blockedReasons?: readonly string[];
		violations?: readonly JsonObject[];
	}): DataMigrationResult =>
		Object.freeze({
			schemaVersion: MIGRATION_EXECUTOR_SCHEMA,
			migrationId: plan.migrationId,
			status: input.status,
			dualWindowOpen: input.dualWindowOpen,
			...(input.snapshot !== undefined
				? { snapshot: input.snapshot }
				: undefined),
			phases: Object.freeze([...phases]),
			blockedReasons: Object.freeze([...(input.blockedReasons ?? [])]),
			violations: Object.freeze([...(input.violations ?? [])]),
			facts: Object.freeze([...facts]),
		});

	emit(MIGRATION_EVENTS.Planned, {
		migrationId: plan.migrationId,
		phases: ["expand", "backfill", "contract"],
		plannedAt: clock(),
	});

	// Snapshot BEFORE any mutation: rollback is snapshot-restore, so a
	// migration without a snapshot must never touch the store.
	const snapshot = port.snapshot();
	emit(MIGRATION_EVENTS.SnapshotTaken, {
		migrationId: plan.migrationId,
		snapshotRef: snapshot.ref,
		takenAt: snapshot.takenAt,
	});

	const rollback = (
		reason: string,
		violations: readonly JsonObject[] = [],
	): DataMigrationResult => {
		try {
			port.restore(snapshot);
		} catch (restoreError) {
			emit(MIGRATION_EVENTS.Failed, {
				migrationId: plan.migrationId,
				reason: `restore failed after ${reason}: ${String(restoreError)}`,
				failedAt: clock(),
			});
			return finish({
				status: "failed",
				dualWindowOpen: false,
				snapshot,
				blockedReasons: [reason],
				violations,
			});
		}
		emit(MIGRATION_EVENTS.RolledBack, {
			migrationId: plan.migrationId,
			reason,
			snapshotRef: snapshot.ref,
			rolledBackAt: clock(),
		});
		return finish({
			status: "rolled-back",
			dualWindowOpen: false,
			snapshot,
			blockedReasons: [reason],
			violations,
		});
	};

	try {
		// Expand: additive, never destructive.
		phases.push(port.applyPhase("expand", plan.expand));
		emit(MIGRATION_EVENTS.PhaseApplied, {
			migrationId: plan.migrationId,
			phase: "expand",
			statements: plan.expand.length,
			appliedAt: clock(),
		});

		// Backfill: fill the new shape from the old.
		const backfillResult = port.applyPhase("backfill", plan.backfill);
		phases.push(backfillResult);
		emit(MIGRATION_EVENTS.PhaseApplied, {
			migrationId: plan.migrationId,
			phase: "backfill",
			statements: plan.backfill.length,
			changes: backfillResult.changes,
			appliedAt: clock(),
		});
	} catch (error) {
		return rollback(`phase execution failed: ${String(error)}`);
	}

	// Verify the dual window before anything destructive.
	const backfillViolations = port.verify(plan.verify.afterBackfill);
	if (backfillViolations.length > 0) {
		return rollback("backfill verification failed", backfillViolations);
	}
	emit(MIGRATION_EVENTS.Verified, {
		migrationId: plan.migrationId,
		point: "after-backfill",
		verifiedAt: clock(),
	});

	// Gate the destructive contract phase: consumers still reading the old
	// shape BLOCK the drop. Blocked is not failure — the dual window stays
	// open (expand + backfill retained) until consumers move.
	const gate = await options.compatGate();
	if (gate.consumersOnLegacySchema.length > 0) {
		return finish({
			status: "contract-blocked",
			dualWindowOpen: true,
			snapshot,
			blockedReasons: [
				`compat gate ${gate.gateId}: ${gate.consumersOnLegacySchema.join(", ")} still read the old shape`,
			],
		});
	}

	try {
		phases.push(port.applyPhase("contract", plan.contract));
		emit(MIGRATION_EVENTS.PhaseApplied, {
			migrationId: plan.migrationId,
			phase: "contract",
			statements: plan.contract.length,
			appliedAt: clock(),
		});
	} catch (error) {
		return rollback(`contract phase failed: ${String(error)}`);
	}

	if (plan.verify.afterContract) {
		const contractViolations = port.verify(plan.verify.afterContract);
		if (contractViolations.length > 0) {
			return rollback("contract verification failed", contractViolations);
		}
		emit(MIGRATION_EVENTS.Verified, {
			migrationId: plan.migrationId,
			point: "after-contract",
			verifiedAt: clock(),
		});
	}

	emit(MIGRATION_EVENTS.CutOver, {
		migrationId: plan.migrationId,
		cutOverAt: clock(),
	});
	return finish({ status: "completed", dualWindowOpen: false, snapshot });
}
