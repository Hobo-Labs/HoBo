/**
 * The drizzle-kit schema-diff engine.
 *
 * HoBo keeps ownership of the plan: `diff` delegates to the canonical
 * `diffSchemaIr` in `@hobo/core` and stamps this engine's id and version onto
 * the result. The stamp is not decoration — `engineVersion` participates in the
 * plan digest, so upgrading the toolchain changes the digest and therefore
 * shows up as a visible plan change instead of silent SQL drift (ADR-0160).
 *
 * SQL emission is the other half, and it is gated. This package does not bundle
 * drizzle-kit, so it cannot render SQL on its own; `emitSql` refuses with
 * `TOOLCHAIN_UNAVAILABLE` unless the host both declares the toolchain present
 * and wires an emitter. It never approximates, and it never silently returns
 * nothing — a half-emitted migration applied to a real database is worse than a
 * refusal a human can act on.
 */

import {
	diffSchemaIr,
	type MigrationPlan,
	type MigrationStep,
	type SchemaDiffEngine,
	type SchemaIr,
} from "@hobo/core";
import { DrizzleAdapterError } from "./errors.js";

export const DRIZZLE_ENGINE_ID = "drizzle-kit"; // public-contract: engine identity stamped into every migration plan

/**
 * The drizzle-kit release this adapter's ingestion shape-reading was written
 * against. Hosts that run a different drizzle-kit MUST pass `version` so the
 * plan digest reflects the toolchain that will actually render the SQL.
 */
export const DEFAULT_DRIZZLE_ENGINE_VERSION = "0.31.1"; // public-contract: participates in the plan digest, per the note above

export interface EmittedSqlStatement {
	readonly step: MigrationStep;
	readonly sql: string;
}

/** Supplied by a host that owns a real drizzle-kit install. */
export type DrizzleSqlEmitter = (
	plan: MigrationPlan,
) => readonly EmittedSqlStatement[];

export interface DrizzleDiffEngineOptions {
	/** Pinned engine version; participates in the plan digest. */
	readonly version?: string;
	/** Whether the drizzle-kit toolchain is available to this process. */
	readonly toolchainPresent?: boolean;
	/** The emitter the declared toolchain exposes. Required for SQL emission. */
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

/**
 * Every step must come back with SQL. A shorter result would mean part of the
 * plan silently never runs, which is exactly the drift this port exists to
 * prevent, so an incomplete emission is refused rather than returned.
 */
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
