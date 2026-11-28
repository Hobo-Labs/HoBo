import type { MigrationPlan, MigrationStep } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	DrizzleAdapterError,
	stepKey,
	toDataMigrationPlan,
} from "../src/index.js";

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
	engineVersion: "0.31.1",
	digest: "test-digest",
};

const EMITTED = STEPS.map((step) => ({ step, sql: `-- ${stepKey(step)}` }));

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
			expand: ["-- expand:users:add-column:nickname"],
			backfill: ["-- backfill:users:backfill-column:nickname"],
			contract: ["-- contract:users:drop-column:handle"],
			verify: { afterBackfill: "select 1 where false" },
		});
		expect(Object.isFrozen(plan)).toBe(true);
	});

	it("omits afterContract rather than setting it to undefined", () => {
		const plan = toDataMigrationPlan({
			plan: PLAN,
			emitted: EMITTED,
			migrationId: "m-0001",
			verify: { afterBackfill: "q" },
		});

		expect("afterContract" in plan.verify).toBe(false);
	});

	it("carries afterContract when the caller supplies one", () => {
		const plan = toDataMigrationPlan({
			plan: PLAN,
			emitted: EMITTED,
			migrationId: "m-0001",
			verify: { afterBackfill: "q1", afterContract: "q2" },
		});

		expect(plan.verify.afterContract).toBe("q2");
	});

	it("refuses to build a plan when a step has no emitted SQL", () => {
		try {
			toDataMigrationPlan({
				plan: PLAN,
				emitted: EMITTED.slice(0, 1),
				migrationId: "m-0001",
				verify: { afterBackfill: "q" },
			});
			expect.unreachable("a partially emitted plan must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(DrizzleAdapterError);
			// SAFETY: assertion to `error as DrizzleAdapterError` is required at this boundary.
			expect((error as DrizzleAdapterError).code).toBe(
				"SQL_EMISSION_INCOMPLETE",
			);
			// SAFETY: assertion to `error as DrizzleAdapterError` is required at this boundary.
			expect((error as DrizzleAdapterError).remediation).toContain("emitSql");
		}
	});
});
