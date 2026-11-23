import {
	diffSchemaIr,
	type MigrationPlan,
	type MigrationStep,
	type SchemaDiffEngine,
	type SchemaIr,
} from "@hobo/core";
import { DrizzleAdapterError } from "./errors.js";

export const DRIZZLE_ENGINE_ID = "drizzle-kit"; // public-contract: engine identity stamped into every migration plan

export const DEFAULT_DRIZZLE_ENGINE_VERSION = "0.31.1"; // public-contract: participates in the plan digest, per the note above

export interface EmittedSqlStatement {
	readonly step: MigrationStep;
	readonly sql: string;
}

export type DrizzleSqlEmitter = (
	plan: MigrationPlan,
) => readonly EmittedSqlStatement[];

export interface DrizzleDiffEngineOptions {
	readonly version?: string;
	readonly toolchainPresent?: boolean;
	readonly emitSql?: DrizzleSqlEmitter;
}

const TOOLCHAIN_ABSENT_REMEDIATION =
	"Install drizzle-kit in the deploying environment, then construct the engine with `createDrizzleDiffEngine({ toolchainPresent: true, emitSql })`. Until then, apply the migration plan through a schema-apply port that renders its own SQL.";

const EMITTER_MISSING_REMEDIATION =
	"`toolchainPresent: true` was declared but no `emitSql` emitter was wired. @hobo/adapter-drizzle does not bundle drizzle-kit, so the host must pass the emitter its drizzle-kit install provides.";

export function createDrizzleDiffEngine(
	options?: DrizzleDiffEngineOptions,
): SchemaDiffEngine {
	const version = options?.version ?? DEFAULT_DRIZZLE_ENGINE_VERSION;
	const toolchainPresent = options?.toolchainPresent === true;
	const emitter = options?.emitSql;
	const stamp = Object.freeze({ id: DRIZZLE_ENGINE_ID, version });

	return Object.freeze({
		id: DRIZZLE_ENGINE_ID,
		version,
		diff(current: SchemaIr, desired: SchemaIr): MigrationPlan {
			return diffSchemaIr(current, desired, stamp);
		},
		emitSql(plan: MigrationPlan): readonly EmittedSqlStatement[] {
			if (!toolchainPresent) {
				throw new DrizzleAdapterError(
					"TOOLCHAIN_UNAVAILABLE",
					"SQL emission requires the drizzle-kit toolchain, which is not present.",
					TOOLCHAIN_ABSENT_REMEDIATION,
				);
			}
			if (emitter === undefined) {
				throw new DrizzleAdapterError(
					"TOOLCHAIN_UNAVAILABLE",
					"SQL emission requires a wired drizzle-kit emitter.",
					EMITTER_MISSING_REMEDIATION,
				);
			}
			return freezeEmitted(plan, emitter(plan));
		},
	});
}

function freezeEmitted(
	plan: MigrationPlan,
	emitted: readonly EmittedSqlStatement[],
): readonly EmittedSqlStatement[] {
	const covered = new Set(emitted.map((entry) => stepKey(entry.step)));
	const missing = plan.steps
		.filter((step) => !covered.has(stepKey(step)))
		.map((step) => stepKey(step));
	if (missing.length > 0) {
		throw new DrizzleAdapterError(
			"SQL_EMISSION_INCOMPLETE",
			`The drizzle-kit emitter returned no SQL for ${missing.length} plan step(s): ${missing.join(", ")}.`,
			"Regenerate the SQL with a drizzle-kit version that understands every step kind in the plan, or narrow the plan before emitting.",
		);
	}
	return Object.freeze(
		emitted.map((entry) => Object.freeze({ step: entry.step, sql: entry.sql })),
	);
}

export function stepKey(step: MigrationStep): string {
	return [
		step.phase,
		step.table,
		step.kind,
		step.column ?? step.index ?? "",
	].join(":");
}
