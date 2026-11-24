import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMigrationsConfig,
	declareDrizzleSchema,
	declareNeonPostgresStack,
	declarePlanetscalePostgresStack,
	declarePrismaPostgresStack,
	declareTursoLibsqlStack,
	declareTursoTenantDatabaseFleet,
	describeSqlProviderCatalog,
	inspectDrizzleMigrationsDir,
	Migrations,
	runDrizzleMigrationsOnSqlite,
	selectDatabaseBranchForStage,
} from "../src/sql/index.js";

const tempDirs: string[] = [];

function createTempDrizzleDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-alchemy-drizzle-"));
	tempDirs.push(dir);
	return dir;
}

function writeDrizzleMigration(
	baseDir: string,
	name: string,
	sql: string,
): void {
	const folder = join(baseDir, name);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "migration.sql"), sql, "utf8");
	writeFileSync(
		join(folder, "snapshot.json"),
		JSON.stringify({ version: "7", id: name }),
		"utf8",
	);
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("@hobo/iac-alchemy/sql (Drizzle migrations, Postgres, and libSQL)", () => {
	it("applies Drizzle v1 migrations via __alchemy_migrations, stays idempotent, and applies incremental deltas", async () => {
		const dir = createTempDrizzleDir();
		writeDrizzleMigration(
			dir,
			"20260721010000_create_tenants",
			"CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);",
		);
		writeDrizzleMigration(
			dir,
			"20260721020000_create_leases",
			"CREATE TABLE leases (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);\n--> statement-breakpoint\nCREATE INDEX idx_leases_tenant ON leases(tenant_id);",
		);

		const inspection = await inspectDrizzleMigrationsDir(dir);
		expect(inspection.layout).toBe("directory");
		expect(inspection.table).toBe(Migrations.ALCHEMY_DEFAULT_TABLE);
		expect(inspection.records.map((record) => record.name)).toEqual([
			"20260721010000_create_tenants",
			"20260721020000_create_leases",
		]);

		const db = new DatabaseSync(":memory:");
		try {
			const first = await runDrizzleMigrationsOnSqlite({
				db,
				migrations: dir,
			});
			expect(first.resolved.table).toBe("__alchemy_migrations");
			expect(Object.keys(first.hashes)).toHaveLength(2);

			db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").run(
				"t-1",
				"Hobo Labs",
			);
			const second = await runDrizzleMigrationsOnSqlite({
				db,
				migrations: dir,
				priorTable: first.resolved.table,
			});
			expect(second.hashes).toEqual(first.hashes);

			writeDrizzleMigration(
				dir,
				"20260721030000_add_region",
				"ALTER TABLE tenants ADD COLUMN region TEXT NOT NULL DEFAULT 'us-east-1';",
			);
			const third = await runDrizzleMigrationsOnSqlite({
				db,
				migrations: dir,
				priorTable: second.resolved.table,
			});
			expect(Object.keys(third.hashes)).toHaveLength(3);

			const row = db
				.prepare("SELECT id, name, region FROM tenants WHERE id = ?")
				.get("t-1");
			expect(row).toEqual({
				id: "t-1",
				name: "Hobo Labs",
				region: "us-east-1",
			});
		} finally {
			db.close();
		}
	});

	it("fails closed on non-linear or rewritten Drizzle migration history", async () => {
		const dir = createTempDrizzleDir();
		writeDrizzleMigration(
			dir,
			"20260721020000_initial",
			"CREATE TABLE items (id TEXT PRIMARY KEY);",
		);

		const db = new DatabaseSync(":memory:");
		try {
			await runDrizzleMigrationsOnSqlite({ db, migrations: dir });

			writeDrizzleMigration(
				dir,
				"20260721010000_out_of_order",
				"CREATE TABLE late_insert (id TEXT PRIMARY KEY);",
			);
			await expect(
				runDrizzleMigrationsOnSqlite({ db, migrations: dir }),
			).rejects.toThrow();

			rmSync(join(dir, "20260721010000_out_of_order"), {
				recursive: true,
				force: true,
			});
			writeDrizzleMigration(
				dir,
				"20260721020000_initial",
				"CREATE TABLE items (id TEXT PRIMARY KEY, mutated INTEGER);",
			);
			await expect(
				runDrizzleMigrationsOnSqlite({ db, migrations: dir }),
			).rejects.toThrow();
		} finally {
			db.close();
		}
	});

	it("constructs Drizzle, Neon, PlanetScale, Prisma, and Turso Alchemy programs with stage-aware branching", () => {
		expect(selectDatabaseBranchForStage("prod")).toBe("main");
		expect(selectDatabaseBranchForStage("production")).toBe("main");
		expect(selectDatabaseBranchForStage("pr-42")).toBe("preview-pr-42");

		const resolved = createMigrationsConfig({
			out: "./drizzle-migrations",
		});
		expect(resolved).toEqual({
			dir: "./drizzle-migrations",
			table: "__alchemy_migrations",
		});

		expect(
			declareDrizzleSchema({
				id: "AppSchema",
				schema: "./src/schema.ts",
				out: "./migrations",
				dialect: "postgres",
			}),
		).toBeDefined();
		expect(
			declareNeonPostgresStack({
				projectId: "HoboNeon",
				branchId: "HoboNeonBranch",
				stage: "staging",
				migrations: "./migrations",
				roleId: "HoboNeonRole",
			}),
		).toBeDefined();
		expect(
			declarePlanetscalePostgresStack({
				databaseId: "HoboPsDb",
				branchId: "HoboPsBranch",
				stage: "prod",
				clusterSize: "PS_10",
				migrationsDir: "./migrations",
			}),
		).toBeDefined();
		expect(
			declarePrismaPostgresStack({
				projectId: "HoboPrisma",
				databaseId: "HoboPrismaDb",
				stage: "staging",
			}),
		).toBeDefined();
		expect(
			declareTursoLibsqlStack({
				groupId: "HoboTursoGroup",
				databaseId: "HoboTursoDb",
				stage: "prod",
				migrations: "./migrations",
			}),
		).toBeDefined();
		expect(
			declareTursoTenantDatabaseFleet({
				groupId: "TenantGroup",
				tenantIds: ["acme", "globex"],
				migrations: "./migrations",
			}),
		).toBeDefined();

		const catalog = describeSqlProviderCatalog();
		expect(catalog.map((item) => item.id)).toEqual([
			"drizzle",
			"neon",
			"planetscale",
			"prisma",
			"turso",
		]);
		expect(catalog.every((item) => item.supportsDrizzleMigrations)).toBe(true);
	});
});
