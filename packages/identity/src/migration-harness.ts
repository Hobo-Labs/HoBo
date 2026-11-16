/**
 * Progressive dual-ramp via built-in OpenFeature-compatible FeatureFlagStore
 * (ADR-0044 / ADR-0083 Harness). Auto-abort / compensate on dual-consistency failure.
 * No parallel flag system.
 */
import {
	type FeatureFlagStore,
	type FlagDefinition,
	migrationCohortFlagKey,
} from "./feature-flag-store.js";
import type { IdentityMigrationService } from "./migration-aggregate.js";

// public-contract: migration cohort flag schema (OpenFeature-compatible shape).
export const MIGRATION_COHORT_FLAG_SCHEMA =
	"hobo.identity-migration-cohort-flag/v1" as const;

export interface MigrationRampAdvance {
	flag: MigrationCohortFlag;
	aborted: boolean;
	record: ReturnType<IdentityMigrationService["snapshot"]>;
}

export type MigrationCohortFlag = Readonly<{
	schemaVersion: typeof MIGRATION_COHORT_FLAG_SCHEMA;
	flagId: string;
	flagKey: string;
	migrationId: string;
	tenant: string;
	/** 0–100 ramp percent. */
	percentage: number;
	enabled: boolean;
	/** Harness auto-abort when dual oracle fails. */
	autoAbortOnDualFailure: true;
	/** Bound OpenFeature store definition (when store provided). */
	definition?: FlagDefinition;
}>;

export function createMigrationCohortFlag(input: {
	readonly migrationId: string;
	readonly tenant: string;
	readonly percentage?: number;
	readonly store?: FeatureFlagStore;
}): MigrationCohortFlag {
	const flagKey = migrationCohortFlagKey(input.migrationId);
	const percentage = input.percentage ?? 0;
	let definition: FlagDefinition | undefined;
	if (input.store) {
		definition = input.store.define({
			key: flagKey,
			defaultValue: false,
			percentage,
			enabled: true,
			migrationId: input.migrationId,
			autoAbortOnDualFailure: true,
		});
	}
	return Object.freeze({
		schemaVersion: MIGRATION_COHORT_FLAG_SCHEMA,
		flagId: `flag:identity-migration:${input.migrationId}`,
		flagKey,
		migrationId: input.migrationId,
		tenant: input.tenant,
		percentage,
		enabled: true,
		autoAbortOnDualFailure: true as const,
		...(definition !== undefined ? { definition } : undefined),
	});
}

/**
 * Advance ramp under Harness discipline. Auto-aborts + compensates on failures.
 * Syncs percentage into the OpenFeature store when provided.
 */
export function advanceMigrationRamp(input: {
	readonly service: IdentityMigrationService;
	readonly targetPercent: number;
	readonly dualConsistencyOk: boolean;
	readonly store?: FeatureFlagStore;
}): MigrationRampAdvance {
	const snap = input.service.snapshot();
	if (!snap) {
		throw Object.assign(new Error("no active migration"), {
			code: "migration-not-active",
		});
	}

	if (!input.dualConsistencyOk) {
		input.service.abort({
			reason: "Harness auto-abort: dual-consistency Golden failure",
			code: "dual-consistency-failed",
		});
		input.service.compensate({
			reason: "auto-compensate to source after dual-consistency failure",
		});
		const flag = createMigrationCohortFlag({
			migrationId: snap.id,
			tenant: snap.tenant,
			percentage: 0,
			...(input.store !== undefined ? { store: input.store } : undefined),
		});
		if (input.store) {
			input.store.define({
				key: migrationCohortFlagKey(snap.id),
				percentage: 0,
				enabled: false,
				migrationId: snap.id,
				autoAbortOnDualFailure: true,
			});
		}
		return {
			flag: Object.freeze({ ...flag, enabled: false, percentage: 0 }),
			aborted: true,
			record: input.service.snapshot(),
		};
	}

	const record = input.service.advanceRamp({
		rampPercent: input.targetPercent,
		cohortFlagId: snap.cohortFlagId,
	});
	const flag = createMigrationCohortFlag({
		migrationId: record.id,
		tenant: record.tenant,
		percentage: record.rampPercent,
		...(input.store !== undefined ? { store: input.store } : undefined),
	});
	return { flag, aborted: false, record };
}

/**
 * Evaluate whether a principal is in the migration ramp cohort (OpenFeature-style).
 * Prefer FeatureFlagStore.evaluateBoolean when a store is available.
 */
export function principalInMigrationCohort(input: {
	readonly principalRef: string;
	readonly percentage: number;
	readonly store?: FeatureFlagStore;
	readonly migrationId?: string;
	readonly tenant?: string;
}): boolean {
	if (input.store && input.migrationId) {
		const evalResult = input.store.evaluateBoolean(
			migrationCohortFlagKey(input.migrationId),
			{
				targetingKey: input.principalRef,
				...(input.tenant !== undefined ? { tenant: input.tenant } : undefined),
			},
			false,
		);
		return evalResult.value;
	}
	if (input.percentage >= 100) return true;
	if (input.percentage <= 0) return false;
	let h = 0;
	for (let i = 0; i < input.principalRef.length; i++) {
		h = (h * 31 + input.principalRef.charCodeAt(i)) >>> 0;
	}
	return h % 100 < input.percentage;
}
