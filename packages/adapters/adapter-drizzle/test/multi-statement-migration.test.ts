import type { MigrationPlan, MigrationStep } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createDrizzleDiffEngine,
	DrizzleAdapterError,
	toDataMigrationPlan,
} from "../src/index.js";

const createTable: MigrationStep = {
	phase: "expand",
	kind: "create-table",
	table: "users",
	destructive: false,
};
const dropColumn: MigrationStep = {
	phase: "contract",
	kind: "drop-column",
	table: "users",
	column: "legacy",
	destructive: true,
};
const plan: MigrationPlan = {
	contract: "hobo.migration-plan/v1",
	steps: [createTable, dropColumn],
	engineId: "drizzle-kit",
	engineVersion: "0.31.1",
	digest: "test-digest",
};
const verify = { afterBackfill: "SELECT 1" };

describe("migration statements", () => {
	it("preserves every statement in step and phase order", () => {
		const result = toDataMigrationPlan({
			plan,
			migrationId: "m1",
			verify,
			emitted: [
				{ step: dropColumn, sql: "ALTER TABLE users DROP COLUMN legacy" },
				{ step: createTable, sql: "CREATE TABLE users (id integer)" },
				{ step: createTable, sql: "CREATE INDEX users_id ON users (id)" },
			],
		});
		expect(result.expand).toEqual([
			"CREATE TABLE users (id integer)",
			"CREATE INDEX users_id ON users (id)",
		]);
		expect(result.contract).toEqual(["ALTER TABLE users DROP COLUMN legacy"]);
	});

	it.each([
		{
			emitted: [
				{ step: createTable, sql: "   " },
				{ step: dropColumn, sql: "DROP" },
			],
		},
		{
			emitted: [
				{ step: createTable, sql: "CREATE" },
				{ step: dropColumn, sql: "DROP" },
				{ step: { ...dropColumn, table: "other" }, sql: "DROP" },
			],
		},
		{
			emitted: [
				{ step: createTable, sql: "CREATE" },
				{ step: { ...dropColumn, destructive: false }, sql: "DROP" },
			],
		},
	])("refuses empty or unexpected emitted steps", ({ emitted }) => {
		expect(() =>
			toDataMigrationPlan({ plan, emitted, migrationId: "m1", verify }),
		).toThrowError(DrizzleAdapterError);
	});

	it("applies the same checks when the engine receives SQL from an emitter", () => {
		const engine = createDrizzleDiffEngine({
			toolchainPresent: true,
			emitSql: () => [
				{ step: createTable, sql: "CREATE" },
				{ step: dropColumn, sql: "DROP" },
				{ step: { ...dropColumn, table: "other" }, sql: "DROP" },
			],
		});
		expect(() => engine.emitSql?.(plan)).toThrowError(DrizzleAdapterError);
	});

	it("copies emitted steps before freezing the result", () => {
		const mutableStep = { ...createTable };
		const engine = createDrizzleDiffEngine({
			toolchainPresent: true,
			emitSql: () => [
				{ step: mutableStep, sql: "CREATE" },
				{ step: dropColumn, sql: "DROP" },
			],
		});
		const emitted = engine.emitSql?.(plan);
		mutableStep.table = "changed";
		expect(emitted?.[0]?.step.table).toBe("users");
		expect(Object.isFrozen(emitted?.[0]?.step)).toBe(true);
	});
});
