import {
	diffSchemaIr,
	MIGRATION_PLAN_CONTRACT,
	type MigrationPlan,
	parseSchemaIr,
	SCHEMA_IR_CONTRACT,
	type SchemaIr,
} from "@hobo/core";

import type { BetterAuthBundlePlan } from "./plan.js";
import { BETTER_AUTH_RELATIONAL_SCHEMA_IR } from "./fixtures/better-auth-schema-ir.js";
import { BetterAuthBundlePlanError } from "./errors.js";

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
	const migrationPlan = diffSchemaIr(currentSchema, BETTER_AUTH_RELATIONAL_SCHEMA_IR);
	if (migrationPlan.contract !== MIGRATION_PLAN_CONTRACT) {
		throw new BetterAuthBundlePlanError(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"migration planner returned an unexpected plan contract",
			"report this as an internal defect; plans must use hobo.migration-plan/v1",
		);
	}
	return Object.freeze({
		packId: bundlePlan.packId,
		relationalBindle: bundlePlan.ports.relationalBindle,
		databaseProfile: profile,
		desiredSchema: BETTER_AUTH_RELATIONAL_SCHEMA_IR,
		currentSchema,
		migrationPlan,
	});
}