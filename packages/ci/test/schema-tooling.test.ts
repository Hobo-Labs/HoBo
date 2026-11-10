import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DrizzleAdapterError } from "@hobo/adapter-drizzle";
import { sql } from "drizzle-orm";
import { index, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schemaSource } from "../db/source.js";
import {
	checkEmbeddedDdlLock,
	compareCatalogs,
	type DrizzleSchemaModule,
	drizzleKitVersion,
	loadMigrationSet,
	planMigration,
	readEmbeddedDdl,
	renderEmbeddedDdlLock,
	SchemaMigrationError,
	type SchemaSource,
} from "../db/tooling/index.js";

function sourceOf(schemaModule: DrizzleSchemaModule): SchemaSource {
	return {
		scope: "test",
		advisoryLocks: [],
		directory: new URL("./unused/", import.meta.url),
		loadSchema: async () => schemaModule,
	};
}

const things = () => ({
	things: pgTable("things", { id: text("id").primaryKey() }),
});

async function baselineOf(schemaModule: DrizzleSchemaModule) {
	const baseline = await planMigration(
		sourceOf(schemaModule),
		undefined,
		"0000_baseline",
	);
	if (baseline === undefined) throw new Error("baseline was empty");
	return baseline;
}

describe("planMigration", () => {
	it("plans an added column and index as guarded expand steps", async () => {
		const baseline = await baselineOf(things());
		const next = await planMigration(
			sourceOf({
				things: pgTable(
					"things",
					{ id: text("id").primaryKey(), label: text("label") },
					(table) => [index("things_label").on(table.label)],
				),
			}),
			baseline.snapshot,
			"0001_label",
		);

		expect(
			next?.entry.plan.steps.map(
				(step) => `${step.phase} ${step.kind} ${step.column ?? step.index}`,
			),
		).toEqual(["expand add-column label", "expand add-index things_label"]);
		expect(next?.sqlText).toContain(
			'ALTER TABLE "things" ADD COLUMN IF NOT EXISTS "label" text;',
		);
		expect(next?.sqlText).toContain(
			'CREATE INDEX IF NOT EXISTS "things_label" ON "things" USING btree ("label");',
		);
		expect(next?.entry.fallbacks).toEqual([]);
	});

	it("stamps a new plan with the installed toolchain, and the digest moves with the stamp", async () => {
		const installed = await baselineOf(things());
		const other = await planMigration(
			sourceOf(things()),
			undefined,
			"0000_baseline",
			"0.0.1",
		);

		expect(installed.entry.plan.engineId).toBe("drizzle-kit");
		expect(installed.entry.plan.engineVersion).toBe(await drizzleKitVersion());
		expect(other?.entry.plan.steps).toEqual(installed.entry.plan.steps);
		expect(other?.entry.plan.digest).not.toBe(installed.entry.plan.digest);
	});

	it("reports no migration when the schema did not change", async () => {
		const baseline = await baselineOf(things());

		expect(
			await planMigration(sourceOf(things()), baseline.snapshot, "0001_same"),
		).toBeUndefined();
	});

	it("generates the same SQL whatever order the module's exports enumerate in", async () => {
		const first = pgTable("first", { id: text("id").primaryKey() });
		const second = pgTable("second", { id: text("id").primaryKey() });

		const forward = await baselineOf({ first, second });
		const backward = await baselineOf({ second, first });

		expect(backward.sqlText).toBe(forward.sqlText);
		expect(backward.entry.plan.digest).toBe(forward.entry.plan.digest);
	});

	it("binds an expression index to its table's create-table step and says so", async () => {
		const baseline = await baselineOf({
			docs: pgTable("docs", { body: text("body").notNull() }, (table) => [
				index("docs_kind").on(sql`(${table.body}::jsonb ->> 'kind')`),
			]),
		});

		expect(baseline.entry.plan.steps.map((step) => step.kind)).toEqual([
			"create-table",
		]);
		expect(baseline.entry.fallbacks).toEqual([
			{
				statement: "expand:docs:add-index:docs_kind",
				boundTo: "expand:docs:create-table:",
				reason: expect.stringContaining(
					"DRIZZLE_INDEX_EXPRESSION_UNREPRESENTABLE",
				),
			},
		]);
		expect(baseline.entry.sql.statements).toBe(2);
		expect(baseline.entry.verify.afterBackfill).toContain("('docs_kind')");
	});

	it("refuses a destructive change instead of emitting it", async () => {
		const baseline = await baselineOf({
			things: pgTable("things", {
				id: text("id").primaryKey(),
				label: text("label"),
			}),
		});

		await expect(
			planMigration(sourceOf(things()), baseline.snapshot, "0001_drop"),
		).rejects.toThrow(SchemaMigrationError);
	});

	it("refuses a NOT NULL column that would need a backfill it cannot write", async () => {
		const baseline = await baselineOf(things());

		await expect(
			planMigration(
				sourceOf({
					things: pgTable("things", {
						id: text("id").primaryKey(),
						label: text("label").notNull(),
					}),
				}),
				baseline.snapshot,
				"0001_required",
			),
		).rejects.toBeInstanceOf(DrizzleAdapterError);
	});

	it("refuses a change the canonical IR cannot see", async () => {
		const baseline = await baselineOf({
			docs: pgTable("docs", { body: text("body").notNull() }),
		});

		await expect(
			planMigration(
				sourceOf({
					docs: pgTable("docs", { body: text("body").notNull() }, (table) => [
						index("docs_kind").on(sql`(${table.body}::jsonb ->> 'kind')`),
					]),
				}),
				baseline.snapshot,
				"0001_expression",
			),
		).rejects.toThrow(/Write this migration by hand/u);
	});
});

describe("loadMigrationSet", () => {
	it("refuses SQL that was edited after it was generated", async () => {
		const directory = pathToFileURL(
			`${await mkdtemp(join(tmpdir(), "hobo-ci-schema-"))}/`,
		);
		for (const file of ["journal.json", "0000_baseline.sql"])
			await writeFile(
				new URL(file, directory),
				await readFile(new URL(file, schemaSource.directory)),
			);
		const sqlFile = new URL("0000_baseline.sql", directory);
		await writeFile(
			sqlFile,
			(await readFile(sqlFile, "utf8")).replace("text NOT NULL", "text"),
		);

		await expect(loadMigrationSet(directory)).rejects.toThrow(
			/never edited after it is generated/u,
		);
	});
});

describe("the embedded-DDL lock", () => {
	async function packageWith(storeSource: string) {
		const root = await mkdtemp(join(tmpdir(), "hobo-ci-embedded-"));
		await mkdir(join(root, "src", "_generated"), { recursive: true });
		await mkdir(join(root, "db", "migrations"), { recursive: true });
		await writeFile(join(root, "src", "store.ts"), storeSource);
		await writeFile(
			join(root, "src", "_generated", "bundle.ts"),
			'export const bundled = "CREATE TABLE hobo_ci_bundled (id text)";\n',
		);
		const source = {
			packageRoot: pathToFileURL(`${root}/`),
			directory: pathToFileURL(`${root}/db/migrations/`),
		};
		const lock = await renderEmbeddedDdlLock(source, "PostgreSQL test");
		await writeFile(lock.location, lock.text);
		return { root, source };
	}
	const store = [
		"export async function initialize(pool) {",
		"\tawait pool.query(`CREATE TABLE IF NOT EXISTS hobo_ci_things (",
		"\t\tid text PRIMARY KEY)`);",
		'\tawait pool.query("CREATE TABLE IF NOT EXISTS leases (id TEXT)");',
		"}",
		"",
	].join("\n");

	it("reads relay DDL from hand-written source only", async () => {
		const { source } = await packageWith(store);

		expect(await readEmbeddedDdl(source)).toEqual([
			{
				source: "src/store.ts",
				sql: "CREATE TABLE IF NOT EXISTS hobo_ci_things ( id text PRIMARY KEY)",
			},
		]);
		expect(await checkEmbeddedDdlLock(source)).toEqual([]);
	});

	it("fails when an embedded statement is reworded", async () => {
		const { root, source } = await packageWith(store);
		await writeFile(
			join(root, "src", "store.ts"),
			store.replace("id text PRIMARY KEY", "id text PRIMARY KEY, note text"),
		);

		expect(await checkEmbeddedDdlLock(source)).toEqual([
			"embedded DDL not in the lock: src/store.ts: CREATE TABLE IF NOT EXISTS hobo_ci_things ( id text PRIMARY KEY, note text)",
			"locked DDL no longer in source: src/store.ts: CREATE TABLE IF NOT EXISTS hobo_ci_things ( id text PRIMARY KEY)",
		]);
	});

	it("fails when a file it has never seen starts sending DDL", async () => {
		const { root, source } = await packageWith(store);
		await writeFile(
			join(root, "src", "another-store.ts"),
			'export const ddl = "ALTER TABLE hobo_ci_things ADD COLUMN IF NOT EXISTS note text";\n',
		);

		expect(await checkEmbeddedDdlLock(source)).toEqual([
			"embedded DDL not in the lock: src/another-store.ts: ALTER TABLE hobo_ci_things ADD COLUMN IF NOT EXISTS note text",
		]);
	});
});

describe("compareCatalogs", () => {
	const left = {
		label: "left",
		facts: [
			{ subject: "table t", value: "ordinary table" },
			{ subject: "column t.a", value: "type text | not null" },
			{ subject: "index t.t_a", value: "CREATE INDEX t_a ON t (a)" },
		],
	};

	it("finds nothing between identical catalogs", () => {
		expect(compareCatalogs(left, { ...left, label: "right" })).toEqual([]);
	});

	it("reports a changed, a missing and an extra fact, each once", () => {
		const right = {
			label: "right",
			facts: [
				{ subject: "table t", value: "ordinary table" },
				{ subject: "column t.a", value: "type text | nullable" },
				{ subject: "column t.b", value: "type text | nullable" },
			],
		};

		expect(compareCatalogs(left, right)).toEqual([
			"column t.a: left has (type text | not null); right has (type text | nullable)",
			"column t.b: only in right (type text | nullable)",
			"index t.t_a: only in left (CREATE INDEX t_a ON t (a))",
		]);
	});
});
