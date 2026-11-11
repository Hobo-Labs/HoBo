import {
	billingPeriod,
	DEFAULT_FLEET_POLICY,
	decideFleet,
	type PostgresFleetObservation,
	parseFleetAssignment,
	parseFleetFinancialModel,
} from "@hobo/data-postgres";
import { describe, expect, it } from "vitest";
import { validateDirectDatabaseUrl } from "../src/database-connections.js";
import {
	createFleetBudgetCheck,
	DATABASE_BACKEND_PROFILES,
	parseDatabaseFleet,
	RELAY_FLEET_LAYOUT,
} from "../src/database-fleet-config.js";

const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
const env = {
	HOBO_CI_DATABASE_BACKENDS:
		"neon=NEON_,supabase=SUPABASE_,prisma=PRISMA_:prisma-postgres",
	NEON_DATABASE_URL: "postgres://u@ep-a-pooler.eu.neon.tech/db",
	NEON_DATABASE_URL_UNPOOLED: "postgres://u@ep-a.eu.neon.tech/db",
	SUPABASE_POSTGRES_URL: "postgres://u@aws-0.pooler.supabase.com:6543/db",
	SUPABASE_POSTGRES_URL_NON_POOLING:
		"postgres://u@aws-0.pooler.supabase.com:5432/db",
	SUPABASE_HOBO_CI_DATABASE_CA_CERT: CA,
	PRISMA_DATABASE_URL_POOLED: "postgres://u@pooled.db.prisma.io/db",
	PRISMA_DATABASE_URL: "postgres://u@db.prisma.io/db",
};
const NOW = Date.UTC(2026, 10, 11);
const period = billingPeriod(NOW);

describe("parseDatabaseFleet", () => {
	it("is the single-database relay when the list is unset", () => {
		expect(parseDatabaseFleet({ DATABASE_URL: "postgres://u@h/db" })).toBe(
			undefined,
		);
		expect(parseDatabaseFleet({ HOBO_CI_DATABASE_BACKENDS: "" })).toBe(
			undefined,
		);
	});

	it("resolves every backend under its own prefix, in configured order", () => {
		const fleet = parseDatabaseFleet(env);
		expect(fleet?.backends.map((backend) => backend.id)).toEqual([
			"neon",
			"supabase",
			"prisma",
		]);
		expect(fleet?.backends.map((backend) => backend.profileName)).toEqual([
			"neon",
			"supabase",
			"prisma-postgres",
		]);
		const [neon, supabase, prisma] = fleet?.backends ?? [];
		expect(neon?.database).toEqual({
			primary: { connectionString: env.NEON_DATABASE_URL },
			direct: { connectionString: env.NEON_DATABASE_URL_UNPOOLED },
		});
		// One provider's private root is not imposed on the others.
		expect(supabase?.database.primary).toMatchObject({ ssl: { ca: CA } });
		expect(prisma?.database.primary).toEqual({
			connectionString: env.PRISMA_DATABASE_URL_POOLED,
		});
		expect(prisma?.model).toMatchObject({ backend: "prisma", plan: "free" });
		expect(fleet).toMatchObject({
			leaseMs: 30_000,
			graceMs: 5000,
			budgetLimitMicros: 0,
			policy: DEFAULT_FLEET_POLICY,
		});
	});

	it("takes any number of backends, an empty prefix, and unknown ids", () => {
		const fleet = parseDatabaseFleet({
			HOBO_CI_DATABASE_BACKENDS: "main=,vm-2=VM2_",
			DATABASE_URL: "postgres://u@a/db",
			DATABASE_URL_UNPOOLED: "postgres://u@a/db",
			VM2_DATABASE_URL: "postgres://u@b/db",
			VM2_DATABASE_URL_UNPOOLED: "postgres://u@b/db",
			HOBO_CI_DATABASE_RPO_SECONDS: "3600",
			HOBO_CI_DATABASE_LEASE_SECONDS: "12",
			HOBO_CI_DATABASE_FAILOVER_AFTER_SECONDS: "90",
			HOBO_CI_DATABASE_MONTHLY_BUDGET_MICROS: "25000000",
		});
		expect(fleet?.backends.map((backend) => backend.profileName)).toEqual([
			"postgres",
			"postgres",
		]);
		expect(fleet).toMatchObject({
			leaseMs: 12_000,
			graceMs: 2000,
			budgetLimitMicros: 25_000_000,
			policy: { rpoMs: 3_600_000, failoverAfterMs: 90_000 },
		});
	});

	it.each([
		["a list with a bad pair", { HOBO_CI_DATABASE_BACKENDS: "neon" }],
		["an id in upper case", { HOBO_CI_DATABASE_BACKENDS: "Neon=NEON_" }],
		["a prefix that is not a name", { HOBO_CI_DATABASE_BACKENDS: "a=1X_" }],
		["a trailing comma", { ...env, HOBO_CI_DATABASE_BACKENDS: "neon=NEON_," }],
		[
			"a repeated id",
			{ ...env, HOBO_CI_DATABASE_BACKENDS: "neon=NEON_,neon=PRISMA_" },
		],
		[
			"a repeated prefix",
			{ ...env, HOBO_CI_DATABASE_BACKENDS: "neon=NEON_,other=NEON_" },
		],
		[
			"an unknown profile",
			{ ...env, HOBO_CI_DATABASE_BACKENDS: "neon=NEON_:oracle" },
		],
		[
			"a backend with no connection",
			{ ...env, HOBO_CI_DATABASE_BACKENDS: "neon=NEON_,ghost=GHOST_" },
		],
		["a second selector", { ...env, HOBO_CI_DATABASE_ENV_PREFIX: "NEON_" }],
		[
			"a lease that is not a number",
			{ ...env, HOBO_CI_DATABASE_LEASE_SECONDS: "soon" },
		],
		["a lease of zero", { ...env, HOBO_CI_DATABASE_LEASE_SECONDS: "0" }],
		["a negative objective", { ...env, HOBO_CI_DATABASE_RPO_SECONDS: "-5" }],
		[
			"a budget with a unit",
			{ ...env, HOBO_CI_DATABASE_MONTHLY_BUDGET_MICROS: "5usd" },
		],
	])("refuses %s", (_name, bad) => {
		expect(() => parseDatabaseFleet(bad)).toThrow();
	});

	it("never puts a connection string in an error", () => {
		const secret = "postgres://user:hunter2@ep-a-pooler.eu.neon.tech/db";
		try {
			parseDatabaseFleet({
				HOBO_CI_DATABASE_BACKENDS: "neon=NEON_",
				NEON_DATABASE_URL: secret,
				NEON_DATABASE_URL_UNPOOLED: secret,
			});
			throw new Error("accepted a pooler as the session endpoint");
		} catch (error) {
			expect(String(error)).not.toContain("hunter2");
			expect(String(error)).toContain("direct PostgreSQL URL");
		}
	});
});

describe("backend profiles", () => {
	it("keeps pooler rules as data that the session check enforces", () => {
		const samples = [
			[
				DATABASE_BACKEND_PROFILES.neon,
				"postgres://u@ep-a-pooler.eu.neon.tech/db",
			],
			[
				DATABASE_BACKEND_PROFILES.supabase,
				"postgres://u@aws-0.pooler.supabase.com:6543/db",
			],
			[
				DATABASE_BACKEND_PROFILES["prisma-postgres"],
				"postgres://u@pooled.db.prisma.io/db",
			],
		] as const;
		for (const [profile, url] of samples) {
			expect(profile.transactionPoolers.length).toBeGreaterThan(0);
			expect(() => validateDirectDatabaseUrl(url)).toThrow(
				"repair requires a direct PostgreSQL URL",
			);
		}
		expect(DATABASE_BACKEND_PROFILES.postgres.transactionPoolers).toEqual([]);
	});

	it("refuses a same-host pooler port for the backend that has one, and for no other", () => {
		const direct = "postgres://u:p@db.example.test:5432/app";
		const pooled = "postgres://u:p@db.example.test:6432/app";
		for (const name of [
			"planetscale-postgres",
			"azure-postgres-flexible",
			"gcp-cloudsql-postgres",
			"gcp-alloydb",
		] as const) {
			const env = { X_DATABASE_URL: pooled, X_DATABASE_URL_UNPOOLED: direct };
			const fleet = parseDatabaseFleet({
				...env,
				Y_DATABASE_URL: direct,
				Y_DATABASE_URL_UNPOOLED: direct,
				HOBO_CI_DATABASE_BACKENDS: `a=X_:${name},b=Y_:postgres`,
			});
			expect(fleet?.backends.map((backend) => backend.profileName)).toEqual([
				name,
				"postgres",
			]);
			// The session connection on the pooler port is refused for it...
			expect(() =>
				parseDatabaseFleet({
					X_DATABASE_URL: pooled,
					X_DATABASE_URL_UNPOOLED: pooled,
					HOBO_CI_DATABASE_BACKENDS: `a=X_:${name}`,
				}),
			).toThrow("repair requires a direct PostgreSQL URL");
		}
		// ...and allowed for a backend whose provider has no such pooler: a port
		// alone says nothing about a host this relay knows nothing about.
		expect(
			parseDatabaseFleet({
				X_DATABASE_URL: pooled,
				X_DATABASE_URL_UNPOOLED: pooled,
				HOBO_CI_DATABASE_BACKENDS: "a=X_:postgres",
			})?.backends,
		).toHaveLength(1);
		expect(validateDirectDatabaseUrl(pooled)).toBe(pooled);
	});

	it("refuses Supabase's dedicated pooler as well as the shared one", () => {
		for (const url of [
			"postgres://u@aws-0.pooler.supabase.com:6543/db",
			"postgres://u@db.abcdefghijkl.supabase.co:6543/db",
		])
			expect(() => validateDirectDatabaseUrl(url)).toThrow(
				"repair requires a direct PostgreSQL URL",
			);
		for (const url of [
			"postgres://u@aws-0.pooler.supabase.com:5432/db",
			"postgres://u@db.abcdefghijkl.supabase.co:5432/db",
		])
			expect(validateDirectDatabaseUrl(url)).toBe(url);
	});

	it("records a number only with a source, and unknown otherwise", () => {
		for (const [name, profile] of Object.entries(DATABASE_BACKEND_PROFILES)) {
			const model = parseFleetFinancialModel({
				...profile.financial,
				backend: "x",
			});
			expect(model.evidence.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			const stated = model.allowances.filter(
				(allowance) => allowance.included !== undefined,
			);
			if (name === "prisma-postgres") {
				expect(stated.map((allowance) => allowance.included)).toEqual([
					200_000, 2_000_000_000,
				]);
				expect(model.evidence.source).toContain("Vercel Marketplace");
			} else {
				expect(stated).toEqual([]);
				expect(model.fixedMonthlyFeeMicros).toBeUndefined();
				expect(model.evidence.source).toContain("not verified");
			}
		}
	});

	it("copies the relay's tables and never the fleet's own", () => {
		expect(RELAY_FLEET_LAYOUT).toMatchObject({
			dataPrefix: "hobo_ci_",
			assignmentTable: "hobo_ci_fleet_assignments",
			watermarkTable: "hobo_ci_fleet_watermarks",
			usageTable: "hobo_ci_fleet_usage",
		});
	});
});

describe("budget check through the HoBo budget policy evaluator", () => {
	const fleet = parseDatabaseFleet(env);
	const models = fleet?.backends.map((backend) => backend.model) ?? [];
	const check = createFleetBudgetCheck({ limitMicros: 0, models, period });
	const request = (operations: number, costBoundMicros = 0) => ({
		backend: "prisma",
		costBoundMicros,
		measurements: [
			{ unit: "operations" as const, used: operations },
			{ unit: "storage-bytes" as const, used: 50_000_000 },
		],
		nowMs: NOW,
	});

	it("accepts a period that fits the plan and the budget", () => {
		expect(check(request(150_000))).toMatchObject({
			ok: true,
			code: "budget.policy.feasible",
		});
	});

	it("refuses a period that exceeds a stated allowance", () => {
		expect(check(request(200_001))).toMatchObject({
			ok: false,
			code: "budget.policy.constraint",
		});
	});

	it("refuses a cost above the budget", () => {
		expect(check(request(10, 1))).toMatchObject({
			ok: false,
			code: "budget.policy.exhausted",
		});
	});

	it("fails closed when a metric the plan constrains was not measured", () => {
		expect(check({ ...request(10), measurements: [] })).toMatchObject({
			ok: false,
			code: "budget.policy.unsupported-constraint",
		});
	});
});

describe("policy over the recorded profiles", () => {
	const fleet = parseDatabaseFleet(env);
	const models = fleet?.backends.map((backend) => backend.model) ?? [];
	const observed = (
		backend: string,
		operations: number,
	): PostgresFleetObservation => ({
		backend,
		health: "reachable",
		probeLatencyMs: 20,
		failingForMs: 0,
		schemaCurrent: true,
		standbyLagMs: 60_000,
		usage: [
			{ unit: "operations", used: operations },
			{ unit: "storage-bytes", used: 50_000_000 },
		],
	});
	const decide = (writer: string, observations: PostgresFleetObservation[]) =>
		decideFleet({
			assignment: parseFleetAssignment({
				epoch: 2,
				active: writer,
				sealed: false,
				target: undefined,
				reason: "test",
				lossWindowMs: undefined,
				decidedAtMs: NOW - 86_400_000,
				decidedBy: "test",
			}),
			observations,
			models,
			policy: DEFAULT_FLEET_POLICY,
			period,
			checkBudget: createFleetBudgetCheck({ limitMicros: 0, models, period }),
			nowMs: NOW,
		});

	it("sees the metered plan running out, and says there is nowhere proven to go", () => {
		// 190,000 of 200,000 operations used ten days into the month.
		const decision = decide("prisma", [
			observed("prisma", 190_000),
			observed("neon", 100),
			observed("supabase", 100),
		]);
		expect(decision).toMatchObject({
			action: "keep",
			reasons: [
				"operations-exhaustion-projected",
				"budget-infeasible:budget.policy.constraint",
				"no-feasible-standby",
			],
		});
		expect(decision.candidates.map((entry) => entry.feasibility)).toEqual([
			"unknown",
			"unknown",
		]);
	});

	it("moves onto the plan with stated numbers only when the workload fits it", () => {
		const fits = decide("neon", [
			observed("neon", 5000),
			observed("supabase", 100),
			observed("prisma", 100),
		]);
		// Nothing is known to be wrong with the writer, so nothing moves.
		expect(fits.action).toBe("keep");
		expect(
			fits.candidates.find((entry) => entry.backend === "prisma"),
		).toMatchObject({ eligible: true, feasibility: "feasible" });
		const heavy = decide("neon", [
			observed("neon", 150_000),
			observed("supabase", 100),
			observed("prisma", 100),
		]);
		expect(
			heavy.candidates.find((entry) => entry.backend === "prisma"),
		).toMatchObject({ eligible: false, feasibility: "infeasible" });
	});
});
