import { parseBetterAuthConfig } from "@hobo/auth-adapter-contract";
import {
	MIGRATION_STEP_KINDS,
	parseSchemaIr,
	SCHEMA_IR_CONTRACT,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { BetterAuthBundlePlanError } from "../src/errors.js";
import {
	BETTER_AUTH_RELATIONAL_SCHEMA_IR,
	BETTER_AUTH_RELATIONAL_TABLES,
	buildBetterAuthRelationalSchemaIr,
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

	it("is a no-op when the current schema already matches", () => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const wire = planBetterAuthRelationalMigrations(bundlePlan, {
			currentSchema: BETTER_AUTH_RELATIONAL_SCHEMA_IR,
		});
		expect(wire.migrationPlan.steps).toHaveLength(0);
		expect(wire.migrationPlan.digest).toBeTruthy();
	});

	it("adds organization, member, and invitation tables when organizations are enabled", () => {
		const bundlePlan = planBetterAuthBundle(
			{
				...CONFIG_INPUT,
				organizations: { enabled: true },
			},
			PORTS,
		);
		const wire = planBetterAuthRelationalMigrations(bundlePlan);
		expect(wire.desiredSchema).toBe(
			buildBetterAuthRelationalSchemaIr(bundlePlan.config),
		);
		const createdTables = wire.migrationPlan.steps
			.filter((step) => step.kind === "create-table")
			.map((step) => step.table)
			.sort();
		expect(createdTables).toEqual([
			"account",
			"invitation",
			"member",
			"organization",
			"session",
			"user",
			"verification",
		]);
		const session = wire.desiredSchema.tables.find(
			(table) => table.name === "session",
		);
		expect(
			session?.columns.some(
				(column) =>
					column.name === "activeOrganizationId" && column.nullable === true,
			),
		).toBe(true);
		expect(
			wire.migrationPlan.steps.every((step) => step.destructive === false),
		).toBe(true);
	});

	it("leaves a host table out of the diff and still creates auth tables", () => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const currentSchema = parseSchemaIr({
			contract: SCHEMA_IR_CONTRACT,
			dialect: "postgres",
			tables: [
				{
					name: "host_audit",
					columns: [
						{
							name: "id",
							type: "text",
							nullable: false,
							primaryKey: true,
							unique: true,
						},
					],
					indexes: [],
				},
			],
		});
		const wire = planBetterAuthRelationalMigrations(bundlePlan, {
			currentSchema,
		});
		const destructive = new Set([
			"drop-table",
			"drop-column",
			"narrow-column",
			"drop-index",
		]);
		expect(
			wire.migrationPlan.steps.some((step) => destructive.has(step.kind)),
		).toBe(false);
		expect(
			wire.migrationPlan.steps.some((step) => step.table === "host_audit"),
		).toBe(false);
		const createdTables = wire.migrationPlan.steps
			.filter((step) => step.kind === "create-table")
			.map((step) => step.table)
			.sort();
		expect(createdTables).toEqual(
			BETTER_AUTH_RELATIONAL_TABLES.map((table) => table.name).sort(),
		);
	});

	it("refuses a destructive step on a pack-owned table", () => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const user = BETTER_AUTH_RELATIONAL_SCHEMA_IR.tables.find(
			(table) => table.name === "user",
		);
		if (user === undefined) throw new Error("user table missing from schema");
		const currentSchema = parseSchemaIr({
			contract: SCHEMA_IR_CONTRACT,
			dialect: "postgres",
			tables: [
				{
					name: "user",
					columns: [
						...user.columns.map((column) => ({
							name: column.name,
							type: column.type,
							nullable: column.nullable,
							primaryKey: column.primaryKey,
							unique: column.unique,
						})),
						{
							name: "legacy",
							type: "text",
							nullable: true,
							primaryKey: false,
							unique: false,
						},
					],
					indexes: [],
				},
			],
		});
		expect(() =>
			planBetterAuthRelationalMigrations(bundlePlan, { currentSchema }),
		).toThrow(BetterAuthBundlePlanError);
		try {
			planBetterAuthRelationalMigrations(bundlePlan, { currentSchema });
		} catch (error) {
			expect(error).toBeInstanceOf(BetterAuthBundlePlanError);
			if (!(error instanceof BetterAuthBundlePlanError)) {
				throw error;
			}
			expect(error.code).toBe("BETTER_AUTH_BUNDLE_PORT_INVALID");
		}
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
