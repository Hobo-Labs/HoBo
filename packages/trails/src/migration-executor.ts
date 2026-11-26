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
	FenceRaised: "migration.FenceRaised",
	PhaseIntended: "migration.PhaseIntended",
} as const);

export interface MigrationFact {
	readonly type: string;
	readonly data: JsonObject;
}

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
	readonly verify: {
		readonly afterBackfill: string;
		readonly afterContract?: string;
	};
	readonly probes?: DataMigrationProbes;
}

export interface DataMigrationProbes {
	readonly expand?: string;
	readonly backfill?: string;
	readonly contract?: string;
}

export type DataMigrationStatus =
	| "completed"
	| "contract-blocked"
	| "held"
	| "rolled-back"
	| "failed";

export interface DataMigrationPolicyVerdict {
	readonly ok: boolean;
	readonly findings: readonly { readonly code: string }[];
	readonly roles?: readonly string[];
}

export interface DataMigrationJournal {
	load(
		migrationId: string,
	): readonly MigrationFact[] | Promise<readonly MigrationFact[]>;
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
	readonly policy?: (
		phase: SchemaPhase,
	) => DataMigrationPolicyVerdict | Promise<DataMigrationPolicyVerdict>;
	readonly replayErasures?: (
		snapshot: SchemaSnapshotRef,
	) => number | Promise<number>;
	readonly journal?: DataMigrationJournal;
}

export async function executeDataMigration(
	options: ExecuteDataMigrationOptions,
): Promise<DataMigrationResult> {
	const { policy, replayErasures, journal } = options;
	const result = await runInPlaceEvolve({
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
