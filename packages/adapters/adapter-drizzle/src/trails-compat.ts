import type { MigrationPlan } from "@hobo/core";
import {
	type EmittedSqlStatement,
	groupEmittedSql,
	stepKey,
} from "./engine.js";

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
	const sqlByStep = groupEmittedSql(input.plan, input.emitted);

	const expand: string[] = [];
	const backfill: string[] = [];
	const contract: string[] = [];
	for (const step of input.plan.steps) {
		const key = stepKey(step);
		const statements = sqlByStep.get(key) ?? [];
		if (step.phase === "expand") expand.push(...statements);
		else if (step.phase === "backfill") backfill.push(...statements);
		else contract.push(...statements);
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
