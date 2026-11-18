import type { MigrationPlan, MigrationStep } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { DrizzleAdapterError, toDataMigrationPlan } from "../src/index.js";

const STEPS: readonly MigrationStep[] = [
	{
		phase: "expand",
		kind: "add-column",
		table: "users",
		column: "nickname",
		destructive: false,
	},
	{
		phase: "backfill",
		kind: "backfill-column",
		table: "users",
		column: "nickname",
		destructive: false,
	},
	{
		phase: "contract",
		kind: "drop-column",
		table: "users",
		column: "handle",
		destructive: true,
	},
];

const PLAN: MigrationPlan = {
	contract: "hobo.migration-plan/v1",
	steps: STEPS,
	engineId: "drizzle-kit",
	engineVersion: "0.31.11",
	digest: "test-digest",
};

const STATEMENTS = [
	'ALTER TABLE "users" ADD COLUMN "nickname" text',
	'UPDATE "users" SET "nickname" = "handle" WHERE "nickname" IS NULL',
	'ALTER TABLE "users" DROP COLUMN "handle"',
] as const;
const EMITTED = STEPS.map((step, index) => {
	const sql = STATEMENTS[index];
	if (sql === undefined) throw new Error("Missing migration statement");
	return { step, sql };
});

describe("toDataMigrationPlan", () => {
	it("buckets emitted SQL into the three phases @hobo/trails executes", () => {
		const plan = toDataMigrationPlan({
			plan: PLAN,
			emitted: EMITTED,
			migrationId: "m-0001",
			verify: { afterBackfill: "select 1 where false" },
		});

		expect(plan).toEqual({
			migrationId: "m-0001",
			expand: [STATEMENTS[0]],
			backfill: [STATEMENTS[1]],
			contract: [STATEMENTS[2]],
			verify: { afterBackfill: "select 1 where false" },
		});
		expect(Object.isFrozen(plan)).toBe(true);
	});

	it("omits afterContract rather than setting it to undefined", () => {
		const plan = toDataMigrationPlan({
			plan: PLAN,
			emitted: EMITTED,
			migrationId: "m-0001",
			verify: { afterBackfill: "SELECT 1 WHERE FALSE" },
		});

		expect("afterContract" in plan.verify).toBe(false);
	});

	it("carries afterContract when the caller supplies one", () => {
		const plan = toDataMigrationPlan({
			plan: PLAN,
			emitted: EMITTED,
			migrationId: "m-0001",
			verify: {
				afterBackfill: "SELECT 1 WHERE FALSE",
				afterContract: "SELECT 2 WHERE FALSE",
			},
		});

		expect(plan.verify.afterContract).toBe("SELECT 2 WHERE FALSE");
	});

	it("refuses to build a plan when a step has no emitted SQL", () => {
		try {
			toDataMigrationPlan({
				plan: PLAN,
				emitted: EMITTED.slice(0, 1),
				migrationId: "m-0001",
				verify: { afterBackfill: "SELECT 1 WHERE FALSE" },
			});
			expect.unreachable("a partially emitted plan must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(DrizzleAdapterError);
			expect((error as DrizzleAdapterError).code).toBe(
				"SQL_EMISSION_INCOMPLETE",
			);
			expect((error as DrizzleAdapterError).remediation).toContain("emitSql");
		}
	});
});
