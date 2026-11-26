/**
 * Structural bridge from a `MigrationPlan` to the plan shape `@hobo/trails`
 * executes.
 *
 * `@hobo/trails` already owns migration execution — snapshot, phase apply,
 * verify, restore, and the expand/backfill/contract saga. This adapter must not
 * reimplement any of that, and as a layer-2 adapter it may not import
 * `@hobo/trails` at all. So it emits a *structurally* compatible object: the
 * same field names, the same three phase literals, the same `verify` shape. The
 * consumer passes it straight to `executeDataMigration`.
 *
 * The conversion is deliberately toolchain-gated by construction: trails
 * executes SQL statements, and this package cannot render SQL, so the caller
 * must hand in the emitted statements. There is no path here that fabricates a
 * statement.
 */

import type { MigrationPlan } from "@hobo/core";
import { type EmittedSqlStatement, stepKey } from "./engine.js";
import { DrizzleAdapterError } from "./errors.js";

/**
 * Mirror of `@hobo/trails`'s `DataMigrationPlan`. Duplicated structurally
 * rather than imported because adapters may not depend on layer-3 packages.
 */
export interface DataMigrationPlanRecord {
	readonly migrationId: string;
	readonly expand: readonly string[];
	readonly backfill: readonly string[];
	readonly contract: readonly string[];
	readonly verify: {
		readonly afterBackfill: string;
		readonly afterContract?: string;
	};
}

export interface ToDataMigrationPlanInput {
	readonly plan: MigrationPlan;
	readonly emitted: readonly EmittedSqlStatement[];
	readonly migrationId: string;
	readonly verify: {
		readonly afterBackfill: string;
		readonly afterContract?: string;
	};
}

export function toDataMigrationPlan(
	input: ToDataMigrationPlanInput,
): DataMigrationPlanRecord {
	const sqlByStep = new Map<string, string>();
	for (const statement of input.emitted) {
		sqlByStep.set(stepKey(statement.step), statement.sql);
	}

	const expand: string[] = [];
	const backfill: string[] = [];
	const contract: string[] = [];
	const missing: string[] = [];

	for (const step of input.plan.steps) {
		const key = stepKey(step);
		const sql = sqlByStep.get(key);
		if (sql === undefined) {
			missing.push(key);
			continue;
		}
		if (step.phase === "expand") expand.push(sql);
		else if (step.phase === "backfill") backfill.push(sql);
		else contract.push(sql);
	}

	if (missing.length > 0) {
		throw new DrizzleAdapterError(
			"SQL_EMISSION_INCOMPLETE",
			`Cannot build a data-migration plan: ${missing.length} step(s) have no emitted SQL: ${missing.join(", ")}.`,
			"Emit SQL for the whole plan with `createDrizzleDiffEngine({ toolchainPresent: true, emitSql }).emitSql(plan)` before converting it.",
		);
	}

	return Object.freeze({
		migrationId: input.migrationId,
		expand: Object.freeze(expand),
		backfill: Object.freeze(backfill),
		contract: Object.freeze(contract),
		verify: Object.freeze({
			afterBackfill: input.verify.afterBackfill,
			...(input.verify.afterContract !== undefined
				? { afterContract: input.verify.afterContract }
				: undefined),
		}),
	});
}
