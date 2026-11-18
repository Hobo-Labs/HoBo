import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	pgTable,
	serial,
	text,
	varchar,
} from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDrizzleMigration, toDataMigrationPlan } from "../src/index.js";

const beforeUsers = pgTable(
	"users",
	{ id: integer().primaryKey(), email: text() },
	(table) => [index("users_email_idx").on(table.email)],
);
const afterUsers = pgTable(
	"users",
	{ id: integer().primaryKey(), email: text(), name: text().notNull() },
	(table) => [index("users_email_idx").on(table.name)],
);
const backfillKey = "backfill:users:backfill-column:name";
const backfill = 'UPDATE "users" SET "name" = "email" WHERE "name" IS NULL';

async function applyStatements(db: PGlite, statements: readonly string[]) {
	await db.exec("BEGIN");
	try {
		for (const statement of statements) await db.exec(statement);
		await db.exec("COMMIT");
	} catch (error) {
		await db.exec("ROLLBACK");
		throw error;
	}
}

describe("Drizzle SQL emission", () => {
	let database: PGlite;

	beforeAll(async () => {
		database = new PGlite();
		await database.waitReady;
	});

	afterAll(async () => {
		await database.close();
	});
	it("creates a table and index using the real Drizzle toolchain", async () => {
		const artifact = await generateDrizzleMigration({
			current: {},
			desired: { users: beforeUsers },
		});
		const db = database;
		try {
			await applyStatements(
				db,
				artifact.statements.map((entry) => entry.sql),
			);
			await db.exec(
				'INSERT INTO "users" ("id", "email") VALUES (1, \'a@example.test\')',
			);
			const result = await db.query<{ email: string }>(
				'SELECT "email" FROM "users" WHERE "id" = 1',
			);
			expect(result.rows).toEqual([{ email: "a@example.test" }]);
			const indexes = await db.query<{ indexname: string }>(
				"SELECT indexname FROM pg_indexes WHERE tablename = 'users' ORDER BY indexname",
			);
			expect(indexes.rows.map((row) => row.indexname)).toContain(
				"users_email_idx",
			);
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});

	it("backfills a required column before replacing an index", async () => {
		const initial = await generateDrizzleMigration({
			current: {},
			desired: { users: beforeUsers },
		});
		const artifact = await generateDrizzleMigration({
			current: { users: beforeUsers },
			desired: { users: afterUsers },
			backfills: { [backfillKey]: backfill },
		});
		const migration = toDataMigrationPlan({
			plan: artifact.plan,
			emitted: artifact.statements,
			migrationId: "users-v2",
			verify: {
				afterBackfill: 'SELECT "id" FROM "users" WHERE "name" IS NULL',
			},
		});
		const db = database;
		try {
			await applyStatements(
				db,
				initial.statements.map((entry) => entry.sql),
			);
			await db.exec(
				'INSERT INTO "users" ("id", "email") VALUES (1, \'a@example.test\')',
			);
			await applyStatements(db, migration.expand);
			await applyStatements(db, migration.backfill);
			await applyStatements(db, migration.contract);
			const result = await db.query<{ name: string }>(
				'SELECT "name" FROM "users" WHERE "id" = 1',
			);
			expect(result.rows).toEqual([{ name: "a@example.test" }]);
			const indexes = await db.query<{ indexdef: string }>(
				"SELECT indexdef FROM pg_indexes WHERE indexname = 'users_email_idx'",
			);
			expect(indexes.rows[0]?.indexdef).toContain("(name)");
			await expect(
				db.exec('INSERT INTO "users" ("id") VALUES (2)'),
			).rejects.toThrow();
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});

	it("requires a matching explicit backfill and binds its SQL to the artifact", async () => {
		const input = {
			current: { users: beforeUsers },
			desired: { users: afterUsers },
		};
		await expect(generateDrizzleMigration(input)).rejects.toThrow(
			/Backfill SQL is required/u,
		);
		await expect(
			generateDrizzleMigration({
				...input,
				backfills: { unexpected: "SELECT 1" },
			}),
		).rejects.toThrow(/does not match/u);
		const first = await generateDrizzleMigration({
			...input,
			backfills: { [backfillKey]: backfill },
		});
		const repeat = await generateDrizzleMigration({
			...input,
			backfills: { [backfillKey]: backfill },
		});
		const changed = await generateDrizzleMigration({
			...input,
			backfills: { [backfillKey]: 'UPDATE "users" SET "name" = \'unknown\'' },
		});
		expect(first.sqlDigest).toBe(repeat.sqlDigest);
		expect(first.plan.digest).toBe(changed.plan.digest);
		expect(first.sqlDigest).not.toBe(changed.sqlDigest);
	});

	it("emits an alteration of a widened column", async () => {
		const before = pgTable("labels", { name: varchar({ length: 20 }) });
		const after = pgTable("labels", { name: varchar({ length: 80 }) });
		const artifact = await generateDrizzleMigration({
			current: { labels: before },
			desired: { labels: after },
		});
		expect(artifact.statements.map((entry) => entry.step.kind)).toEqual([
			"widen-column",
		]);
		expect(artifact.statements[0]?.sql).toContain("varchar(80)");
	});

	it("adds a serial column and fills existing rows from its sequence", async () => {
		const before = pgTable("items", { id: integer() });
		const after = pgTable("items", { id: integer(), sequence: serial() });
		const initial = await generateDrizzleMigration({
			current: {},
			desired: { items: before },
		});
		const migration = await generateDrizzleMigration({
			current: { items: before },
			desired: { items: after },
		});
		expect(migration.plan.steps.map((step) => step.kind)).toEqual([
			"add-column",
		]);
		const db = database;
		try {
			await applyStatements(
				db,
				initial.statements.map((entry) => entry.sql),
			);
			await db.exec('INSERT INTO "items" ("id") VALUES (10), (20)');
			await applyStatements(
				db,
				migration.statements.map((entry) => entry.sql),
			);
			const result = await db.query<{ id: number; sequence: number }>(
				'SELECT "id", "sequence" FROM "items" ORDER BY "id"',
			);
			expect(result.rows).toEqual([
				{ id: 10, sequence: 1 },
				{ id: 20, sequence: 2 },
			]);
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});

	it("changes a default and removes a unique constraint", async () => {
		const before = pgTable("contacts", {
			id: integer().primaryKey(),
			email: text().unique(),
		});
		const after = pgTable("contacts", {
			id: integer().primaryKey(),
			email: text().default("pending"),
		});
		const initial = await generateDrizzleMigration({
			current: {},
			desired: { contacts: before },
		});
		const migration = await generateDrizzleMigration({
			current: { contacts: before },
			desired: { contacts: after },
		});
		const db = database;
		try {
			await applyStatements(
				db,
				initial.statements.map((entry) => entry.sql),
			);
			await applyStatements(
				db,
				migration.statements.map((entry) => entry.sql),
			);
			await db.exec('INSERT INTO "contacts" ("id") VALUES (1), (2)');
			const result = await db.query<{ email: string }>(
				'SELECT "email" FROM "contacts" ORDER BY "id"',
			);
			expect(result.rows).toEqual([{ email: "pending" }, { email: "pending" }]);
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});

	it("drops an index before its indexed column", async () => {
		const after = pgTable("users", { id: integer().primaryKey() });
		const initial = await generateDrizzleMigration({
			current: {},
			desired: { users: beforeUsers },
		});
		const migration = await generateDrizzleMigration({
			current: { users: beforeUsers },
			desired: { users: after },
		});
		const db = database;
		try {
			await applyStatements(
				db,
				initial.statements.map((entry) => entry.sql),
			);
			await applyStatements(
				db,
				migration.statements.map((entry) => entry.sql),
			);
			const columns = await db.query<{ column_name: string }>(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'users'",
			);
			expect(columns.rows).toEqual([{ column_name: "id" }]);
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});

	it("moves an index name when its original table is removed", async () => {
		const oldTable = pgTable("z_old", { id: integer() }, (table) => [
			index("shared_idx").on(table.id),
		]);
		const newTable = pgTable("a_new", { id: integer() }, (table) => [
			index("shared_idx").on(table.id),
		]);
		const initial = await generateDrizzleMigration({
			current: {},
			desired: { oldTable },
		});
		const migration = await generateDrizzleMigration({
			current: { oldTable },
			desired: { newTable },
		});
		const db = database;
		try {
			await applyStatements(
				db,
				initial.statements.map((entry) => entry.sql),
			);
			await applyStatements(
				db,
				migration.statements.map((entry) => entry.sql),
			);
			const indexes = await db.query<{ tablename: string }>(
				"SELECT tablename FROM pg_indexes WHERE indexname = 'shared_idx'",
			);
			expect(indexes.rows).toEqual([{ tablename: "a_new" }]);
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});

	it("rejects defaults absent from the canonical schema IR", async () => {
		const events = pgTable("events", {
			id: integer().default(sql`nextval('event_ids')`),
		});
		await expect(
			generateDrizzleMigration({ current: {}, desired: { events } }),
		).rejects.toThrow(/DRIZZLE_DEFAULT_UNREPRESENTABLE/u);
	});

	it("rejects converting an existing column to a serial type", async () => {
		const before = pgTable("items", { id: integer().notNull() });
		const after = pgTable("items", { id: serial() });
		await expect(
			generateDrizzleMigration({
				current: { items: before },
				desired: { items: after },
			}),
		).rejects.toThrow(/Changing a serial column type is not supported/u);
	});

	it("widens a column before backfilling and making it required", async () => {
		const before = pgTable("labels", { name: varchar({ length: 20 }) });
		const after = pgTable("labels", {
			name: varchar({ length: 80 }).notNull(),
		});
		const initial = await generateDrizzleMigration({
			current: {},
			desired: { labels: before },
		});
		const migration = await generateDrizzleMigration({
			current: { labels: before },
			desired: { labels: after },
			backfills: {
				"backfill:labels:backfill-column:name":
					'UPDATE "labels" SET "name" = \'default\' WHERE "name" IS NULL',
			},
		});
		const db = database;
		try {
			await applyStatements(
				db,
				initial.statements.map((entry) => entry.sql),
			);
			await db.exec('INSERT INTO "labels" VALUES (NULL)');
			await applyStatements(
				db,
				migration.statements.map((entry) => entry.sql),
			);
			const result = await db.query<{ name: string }>(
				'SELECT "name" FROM "labels"',
			);
			expect(result.rows).toEqual([{ name: "default" }]);
			await expect(
				db.exec('INSERT INTO "labels" VALUES (NULL)'),
			).rejects.toThrow();
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});

	it("adds a unique constraint on an existing column", async () => {
		const before = pgTable("contacts", { email: text() });
		const after = pgTable("contacts", { email: text().unique() });
		const initial = await generateDrizzleMigration({
			current: {},
			desired: { contacts: before },
		});
		const migration = await generateDrizzleMigration({
			current: { contacts: before },
			desired: { contacts: after },
		});
		const db = database;
		try {
			await applyStatements(
				db,
				initial.statements.map((entry) => entry.sql),
			);
			await applyStatements(
				db,
				migration.statements.map((entry) => entry.sql),
			);
			await db.exec("INSERT INTO \"contacts\" VALUES ('a')");
			await expect(
				db.exec("INSERT INTO \"contacts\" VALUES ('a')"),
			).rejects.toThrow();
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});

	it("moves a primary key between existing columns", async () => {
		const before = pgTable("keys", {
			z_old: integer().primaryKey(),
			a_new: integer(),
		});
		const after = pgTable("keys", {
			z_old: integer().notNull(),
			a_new: integer().primaryKey(),
		});
		const initial = await generateDrizzleMigration({
			current: {},
			desired: { keys: before },
		});
		const migration = await generateDrizzleMigration({
			current: { keys: before },
			desired: { keys: after },
			backfills: {
				"backfill:keys:backfill-column:a_new":
					'UPDATE "keys" SET "a_new" = "z_old" WHERE "a_new" IS NULL',
			},
		});
		const db = database;
		try {
			await applyStatements(
				db,
				initial.statements.map((entry) => entry.sql),
			);
			await db.exec(
				'ALTER TABLE "keys" RENAME CONSTRAINT "keys_pkey" TO "custom_pk"',
			);
			await db.exec('INSERT INTO "keys" ("z_old") VALUES (1)');
			await applyStatements(
				db,
				migration.statements.map((entry) => entry.sql),
			);
			const result = await db.query<{ a_new: number }>(
				'SELECT "a_new" FROM "keys"',
			);
			expect(result.rows).toEqual([{ a_new: 1 }]);
			await expect(
				db.exec('INSERT INTO "keys" VALUES (2, 1)'),
			).rejects.toThrow();
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});

	it("moves an existing primary key to a newly added serial column", async () => {
		const before = pgTable("keys", { old_id: integer().primaryKey() });
		const after = pgTable("keys", {
			old_id: integer().notNull(),
			new_id: serial().primaryKey(),
		});
		const initial = await generateDrizzleMigration({
			current: {},
			desired: { keys: before },
		});
		const migration = await generateDrizzleMigration({
			current: { keys: before },
			desired: { keys: after },
		});
		expect(migration.plan.steps.map((step) => step.kind)).toEqual([
			"add-column",
			"narrow-column",
			"narrow-column",
		]);
		const db = database;
		try {
			await applyStatements(
				db,
				initial.statements.map((entry) => entry.sql),
			);
			await db.exec('INSERT INTO "keys" ("old_id") VALUES (10), (20)');
			await applyStatements(
				db,
				migration.statements.map((entry) => entry.sql),
			);
			const result = await db.query<{ old_id: number; new_id: number }>(
				'SELECT "old_id", "new_id" FROM "keys" ORDER BY "old_id"',
			);
			expect(result.rows).toEqual([
				{ old_id: 10, new_id: 1 },
				{ old_id: 20, new_id: 2 },
			]);
			await expect(
				db.exec('INSERT INTO "keys" ("old_id", "new_id") VALUES (30, 1)'),
			).rejects.toThrow();
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});

	it("backfills a new column before assigning it the primary key", async () => {
		const before = pgTable("keys", { old_id: integer().primaryKey() });
		const after = pgTable("keys", {
			old_id: integer().notNull(),
			new_id: integer().primaryKey(),
		});
		const initial = await generateDrizzleMigration({
			current: {},
			desired: { keys: before },
		});
		const migration = await generateDrizzleMigration({
			current: { keys: before },
			desired: { keys: after },
			backfills: {
				"backfill:keys:backfill-column:new_id":
					'UPDATE "keys" SET "new_id" = "old_id"',
			},
		});
		const db = database;
		try {
			await applyStatements(
				db,
				initial.statements.map((entry) => entry.sql),
			);
			await db.exec('INSERT INTO "keys" ("old_id") VALUES (10), (20)');
			await applyStatements(
				db,
				migration.statements.map((entry) => entry.sql),
			);
			const result = await db.query<{ new_id: number }>(
				'SELECT "new_id" FROM "keys" ORDER BY "new_id"',
			);
			expect(result.rows).toEqual([{ new_id: 10 }, { new_id: 20 }]);
			await expect(
				db.exec('INSERT INTO "keys" VALUES (30, 10)'),
			).rejects.toThrow();
		} finally {
			await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
		}
	});
});
