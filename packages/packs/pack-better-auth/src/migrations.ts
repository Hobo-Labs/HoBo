import {
	diffSchemaIr,
	MIGRATION_PLAN_CONTRACT,
	type MigrationPlan,
	type MigrationStep,
	parseSchemaIr,
	SCHEMA_IR_CONTRACT,
	type SchemaIr,
} from "@hobo/core";
import { BetterAuthBundlePlanError } from "./errors.js";
import { buildBetterAuthRelationalSchemaIr } from "./fixtures/better-auth-schema-ir.js";
import type { BetterAuthBundlePlan } from "./plan.js";

const DESTRUCTIVE_STEP_KINDS = new Set<MigrationStep["kind"]>([
	"drop-table",
	"drop-column",
	"narrow-column",
	"drop-index",
]);

export interface BetterAuthRelationalMigrationPlan {
	readonly packId: BetterAuthBundlePlan["packId"];
	readonly relationalBindle: string;
	readonly databaseProfile: string;
	readonly desiredSchema: SchemaIr;
	readonly currentSchema: SchemaIr;
	readonly migrationPlan: MigrationPlan;
}

function emptyPostgresSchemaIr(): SchemaIr {
	return parseSchemaIr({
		contract: SCHEMA_IR_CONTRACT,
		dialect: "postgres",
		tables: [],
	});
}

function refuseIncompatibleProfile(profile: string): never {
	throw new BetterAuthBundlePlanError(
		"BETTER_AUTH_BUNDLE_PORT_INVALID",
		`database profile ${profile} is not a relational family profile for Better Auth tables`,
		'set config.database.profile to "data.relational/v1" or a postgres refinement such as "data.postgres/v1"',
	);
}

function packOwnedCurrentSchema(
	current: SchemaIr,
	desired: SchemaIr,
): SchemaIr {
	const owned = new Set(desired.tables.map((table) => table.name));
	const tables = current.tables.filter((table) => owned.has(table.name));
	if (tables.length === current.tables.length) return current;
	return {
		contract: current.contract,
		dialect: current.dialect,
		tables,
	};
}

function refuseDestructiveSteps(plan: MigrationPlan): void {
	const destructive = plan.steps.find((step) =>
		DESTRUCTIVE_STEP_KINDS.has(step.kind),
	);
	if (destructive === undefined) return;
	throw new BetterAuthBundlePlanError(
		"BETTER_AUTH_BUNDLE_PORT_INVALID",
		`Better Auth migration refuses destructive step ${destructive.kind} on table ${destructive.table}`,
		"pack migrations only expand Better Auth tables; host tables stay untouched and pack-owned drops, narrows, and index removals are refused",
	);
}

export function planBetterAuthRelationalMigrations(
	bundlePlan: BetterAuthBundlePlan,
	options?: { readonly currentSchema?: SchemaIr },
): BetterAuthRelationalMigrationPlan {
	const profile = bundlePlan.config.database.profile;
	if (
		!/^data\.relational\/v[1-9]/u.test(profile) &&
		!profile.startsWith("data.postgres/v")
	) {
		refuseIncompatibleProfile(profile);
	}
	const currentSchema = options?.currentSchema ?? emptyPostgresSchemaIr();
	const desiredSchema = buildBetterAuthRelationalSchemaIr(bundlePlan.config);
	const migrationPlan = diffSchemaIr(
		packOwnedCurrentSchema(currentSchema, desiredSchema),
		desiredSchema,
	);
	if (migrationPlan.contract !== MIGRATION_PLAN_CONTRACT) {
		throw new BetterAuthBundlePlanError(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"migration planner returned an unexpected plan contract",
			"report this as an internal defect; plans must use hobo.migration-plan/v1",
		);
	}
	refuseDestructiveSteps(migrationPlan);
	return Object.freeze({
		packId: bundlePlan.packId,
		relationalBindle: bundlePlan.ports.relationalBindle,
		databaseProfile: profile,
		desiredSchema,
		currentSchema,
		migrationPlan,
	});
}
