import { parseBetterAuthConfig } from "@hobo/auth-adapter-contract";
import {
	MIGRATION_STEP_KINDS,
	parseSchemaIr,
	SCHEMA_IR_CONTRACT,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	BETTER_AUTH_RELATIONAL_SCHEMA_IR,
	BETTER_AUTH_RELATIONAL_TABLES,
} from "../src/fixtures/better-auth-schema-ir.js";
import { planBetterAuthRelationalMigrations } from "../src/index.js";
import { planBetterAuthBundle } from "../src/plan.js";

const CONFIG_INPUT = {
	basePath: "/api/auth",
	secretRef: "hobo-secret://camp-prod/auth/better-auth-signing-key",
	database: { profile: "data.relational/v1" },
	emailAndPassword: { enabled: true },
	socialProviders: ["github"],
	organizations: { enabled: false },
};

const PORTS = {
	relationalBindle: "auth_db",
	httpBindle: "auth_api",
	signingSecretRef: parseBetterAuthConfig(CONFIG_INPUT).secretRef,
} as const;

describe("planBetterAuthRelationalMigrations", () => {
	it("refuses an organization plugin without its migration schema", () => {
		const bundlePlan = planBetterAuthBundle(
			{ ...CONFIG_INPUT, organizations: { enabled: true } },
			PORTS,
		);
		expect(() => planBetterAuthRelationalMigrations(bundlePlan)).toThrow(
			/organization.*schema/i,
		);
	});

	it("diffs an empty relational baseline to the pinned Better Auth schema", () => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const wire = planBetterAuthRelationalMigrations(bundlePlan);
		expect(wire.relationalBindle).toBe("auth_db");
		expect(wire.desiredSchema).toBe(BETTER_AUTH_RELATIONAL_SCHEMA_IR);
		expect(wire.migrationPlan.steps.length).toBeGreaterThan(0);
		expect(
			wire.migrationPlan.steps.every((step) => step.phase === "expand"),
		).toBe(true);
		expect(
			wire.migrationPlan.steps.every((step) =>
				MIGRATION_STEP_KINDS.includes(step.kind),
			),
		).toBe(true);
		const createdTables = wire.migrationPlan.steps
			.filter((step) => step.kind === "create-table")
			.map((step) => step.table)
			.sort();
		expect(createdTables).toEqual(
			BETTER_AUTH_RELATIONAL_TABLES.map((table) => table.name).sort(),
		);
	});

	it("refuses a non-relational database profile on the bundle plan", () => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const sqlitePlan = Object.freeze({
			...bundlePlan,
			config: Object.freeze({
				...bundlePlan.config,
				database: { profile: "data.sqlite/v1" },
			}),
		});
		expect(() => planBetterAuthRelationalMigrations(sqlitePlan)).toThrow(
			/not a relational family profile/,
		);
	});

	it("accepts a postgres refinement profile", () => {
		const bundlePlan = planBetterAuthBundle(
			{
				...CONFIG_INPUT,
				database: { profile: "data.postgres/v1" },
			},
			PORTS,
		);
		const wire = planBetterAuthRelationalMigrations(bundlePlan);
		expect(wire.databaseProfile).toBe("data.postgres/v1");
		expect(wire.migrationPlan.steps.length).toBeGreaterThan(0);
	});

	it("rejects malformed and unknown migration profile versions", () => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		for (const profile of [
			"data.postgres/v0",
			"data.postgres/v1-extra",
			"data.relational/v1-extra",
			"data.relational/v2",
		]) {
			const invalid = {
				...bundlePlan,
				config: { ...bundlePlan.config, database: { profile } },
			};
			expect(() => planBetterAuthRelationalMigrations(invalid)).toThrow(
				/not a relational family profile/,
			);
		}
	});

	it("does not let one caller alter the schema used by later plans", () => {
		const table = BETTER_AUTH_RELATIONAL_TABLES[0];
		const column = table.columns[0];
		if (!column) throw new Error("missing schema column");
		const tableName = table.name;
		const columnType = column.type;
		try {
			Reflect.set(table, "name", "tampered");
			Reflect.set(column, "type", "tampered");
			const next = planBetterAuthRelationalMigrations(
				planBetterAuthBundle(CONFIG_INPUT, PORTS),
			);
			expect(next.desiredSchema.tables[0]?.name).toBe(tableName);
			expect(next.desiredSchema.tables[0]?.columns[0]?.type).toBe(columnType);
		} finally {
			Reflect.set(table, "name", tableName);
			Reflect.set(column, "type", columnType);
		}
	});

	it("is a no-op when the current schema already matches", () => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const wire = planBetterAuthRelationalMigrations(bundlePlan, {
			currentSchema: BETTER_AUTH_RELATIONAL_SCHEMA_IR,
		});
		expect(wire.migrationPlan.steps).toHaveLength(0);
		expect(wire.migrationPlan.digest).toBeTruthy();
	});

	it("accepts an explicit empty postgres baseline", () => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const empty = parseSchemaIr({
			contract: SCHEMA_IR_CONTRACT,
			dialect: "postgres",
			tables: [],
		});
		const wire = planBetterAuthRelationalMigrations(bundlePlan, {
			currentSchema: empty,
		});
		expect(
			wire.migrationPlan.steps.some((step) => step.kind === "create-table"),
		).toBe(true);
	});
});
