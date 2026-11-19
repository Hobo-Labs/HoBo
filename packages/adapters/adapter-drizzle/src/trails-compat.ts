
import type { MigrationPlan } from "@hobo/core";
import { type EmittedSqlStatement, stepKey } from "./engine.js";
import { DrizzleAdapterError } from "./errors.js";

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
