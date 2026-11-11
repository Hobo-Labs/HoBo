import {
	applyMigrations,
	type SchemaMigrationSet,
} from "@hobo/ci/schema-migrations";
import { describe, expect, it } from "vitest";
import { schemaSource as ciSource } from "../../ci/db/source.js";
import {
	compareCatalogs,
	loadMigrationSet,
	SCHEMA_LEDGER_TABLE,
	type ScratchDatabase,
	schemaFacts,
	withScratchDatabases,
} from "../../ci/db/tooling/index.js";
import { TEST_POSTGRES_URL } from "../../ci/db/tooling/suite.js";
import { schemaSource as githubSource } from "../../ci-gh-actions/db/source.js";
import { schemaSource as vercelSource } from "../db/source.js";
import {
	prepareRelaySchema,
	RELAY_SCHEMA_MIGRATIONS,
	RelaySchemaError,
	relaySchemaState,
} from "../src/relay-schema.js";

const url = TEST_POSTGRES_URL ?? "";
const SOURCES = [ciSource, githubSource, vercelSource];
/** Every migration of this release, as the seam reports one it applied. */
const EVERYTHING = RELAY_SCHEMA_MIGRATIONS.flatMap((set) =>
	set.migrations.map((migration) => `${set.scope}/${migration.id}`),
);

function only(databases: readonly ScratchDatabase[]): ScratchDatabase {
	const [database] = databases;
	if (!database) throw new Error("scratch database missing");
	return database;
}

/** The relay's sets with `@hobo/ci` cut back to its first `count` migrations. */
function ciAt(count: number): SchemaMigrationSet[] {
	return RELAY_SCHEMA_MIGRATIONS.map((set) =>
		set.scope === "@hobo/ci"
			? { ...set, migrations: set.migrations.slice(0, count) }
			: set,
	);
}

/** Rows in each relay table, the migration ledger aside. */
async function rowCounts(
	database: ScratchDatabase,
): Promise<[string, number][]> {
	const tables = await database.pool.query<{ name: string }>(
		"SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hobo_ci_%' AND tablename <> $1 ORDER BY 1",
		[SCHEMA_LEDGER_TABLE],
	);
	const counts: [string, number][] = [];
	for (const { name } of tables.rows) {
		const rows = await database.pool.query<{ rows: string }>(
			`SELECT count(*)::text AS rows FROM ${name}`,
		);
		counts.push([name, Number(rows.rows[0]?.rows)]);
	}
	return counts;
}

async function ledger(database: ScratchDatabase): Promise<string[]> {
	return (
		await database.pool.query<{ entry: string }>(
			`SELECT scope || '/' || id AS entry FROM ${SCHEMA_LEDGER_TABLE}`,
		)
	).rows
		.map((row) => row.entry)
		.sort();
}

describe("the relay's schema for a fleet backend", () => {
	it("is the checked-in migrations of the three packages that own its tables", async () => {
		expect(RELAY_SCHEMA_MIGRATIONS.map((set) => set.scope)).toEqual([
			"@hobo/ci",
			"@hobo/ci-gh-actions",
			"@hobo/ci-vercel",
		]);
		// One source of truth: what a host applies is what each package's
		// db/migrations loads to, statement for statement.
		for (const [index, source] of SOURCES.entries())
			expect(RELAY_SCHEMA_MIGRATIONS[index]).toEqual(
				await loadMigrationSet(source.directory),
			);
		expect(EVERYTHING).toContain("@hobo/ci/0001_events_account");
	});
});

describe.skipIf(!TEST_POSTGRES_URL)(
	"a fleet backend's schema on PostgreSQL",
	() => {
		it("gives a fresh standby the full schema and none of the application's rows", async () => {
			await withScratchDatabases(
				url,
				["standby", "writer", "embedded"],
				async ([standby, writer, embedded]) => {
					if (!standby || !writer || !embedded)
						throw new Error("scratch database missing");
					expect(await relaySchemaState(standby.pool)).toBe("behind");
					const prepared = await prepareRelaySchema(
						standby.pool,
						"b1",
						"standby",
					);
					expect(prepared).toEqual({ backend: "b1", applied: EVERYTHING });
					expect(await relaySchemaState(standby.pool)).toBe("current");
					expect(await ledger(standby)).toEqual([...EVERYTHING].sort());

					// The writer path, and the stores' own embedded DDL, build the
					// same catalog: tables, columns, constraints and every index,
					// the events account index among them.
					await prepareRelaySchema(writer.pool, "b0", "writer");
					for (const source of SOURCES)
						await source.initializeEmbedded(embedded.pool);
					const facts = await schemaFacts(standby.pool);
					expect(
						compareCatalogs(
							{ label: "standby", facts },
							{ label: "writer", facts: await schemaFacts(writer.pool) },
						),
					).toEqual([]);
					expect(
						compareCatalogs(
							{ label: "standby", facts },
							{
								label: "embedded DDL",
								facts: await schemaFacts(embedded.pool),
							},
						),
					).toEqual([]);
					expect(
						facts.some((fact) =>
							fact.subject.includes("hobo_ci_events_account_seq"),
						),
					).toBe(true);

					// The fence: nothing of the application's was written to the
					// standby. The stores, opened on the writer, did write there.
					const empty = await rowCounts(standby);
					expect(empty.length).toBeGreaterThan(20);
					expect(empty.filter(([, rows]) => rows > 0)).toEqual([]);
					expect(
						(await rowCounts(writer)).filter(([, rows]) => rows > 0),
					).toContainEqual(["hobo_ci_partitions", 1]);
					expect(await ledger(writer)).toEqual([...EVERYTHING].sort());
				},
			);
		}, 120_000);

		it("catches up a standby that is one migration behind", async () => {
			await withScratchDatabases(url, ["behind"], async (databases) => {
				const standby = only(databases);
				// As the release before the events account migration left it.
				await prepareRelaySchema(standby.pool, "b1", "standby", ciAt(1));
				expect(await relaySchemaState(standby.pool)).toBe("behind");
				const index = () =>
					standby.pool.query(
						"SELECT 1 FROM pg_indexes WHERE indexname = 'hobo_ci_events_account_seq'",
					);
				expect((await index()).rowCount).toBe(0);

				expect(await prepareRelaySchema(standby.pool, "b1", "standby")).toEqual(
					{
						backend: "b1",
						applied: ["@hobo/ci/0001_events_account"],
					},
				);
				expect((await index()).rowCount).toBe(1);
				expect(await relaySchemaState(standby.pool)).toBe("current");
				// Again, and nothing is applied.
				expect(await prepareRelaySchema(standby.pool, "b1", "standby")).toEqual(
					{ backend: "b1", applied: [] },
				);
			});
		}, 120_000);

		it("refuses a backend that is ahead of this relay, and leaves it as it is", async () => {
			await withScratchDatabases(url, ["ahead"], async (databases) => {
				const standby = only(databases);
				// A newer relay prepared it: one migration this release does
				// not have, and the column it added.
				const future = ciAt(2).map((set) =>
					set.scope === "@hobo/ci"
						? {
								...set,
								migrations: [
									...set.migrations,
									{
										id: "0002_from_a_newer_release",
										statements: [
											'ALTER TABLE "hobo_ci_events" ADD COLUMN IF NOT EXISTS "from_the_future" text;',
										],
										sqlSha256: "2".repeat(64),
										planDigest: `sha256:${"2".repeat(64)}`,
										engine: "drizzle-kit@9.9.9",
										violationsQuery:
											"SELECT NULL::text AS object, NULL::text AS name, NULL::text AS problem WHERE false",
									},
								],
							}
						: set,
				);
				await prepareRelaySchema(standby.pool, "b2", "standby", future);
				const before = {
					facts: await schemaFacts(standby.pool),
					ledger: await ledger(standby),
				};
				expect(await relaySchemaState(standby.pool)).toBe("ahead");

				for (const role of ["standby", "writer"] as const) {
					const refusal = await prepareRelaySchema(
						standby.pool,
						"b2",
						role,
					).then(
						() => undefined,
						(error: Error) => error,
					);
					expect(refusal).toBeInstanceOf(RelaySchemaError);
					expect(refusal).toMatchObject({
						backend: "b2",
						failure: "ahead",
						scope: "@hobo/ci",
						migrations: ["0002_from_a_newer_release"],
					});
					// It names the backend by its fleet id and the migration it
					// does not know, and nothing about how to reach the database.
					expect(refusal?.message).toMatch(/fleet backend b2 /u);
					expect(refusal?.message).toMatch(/0002_from_a_newer_release/u);
					expect(refusal?.message).not.toMatch(/postgres|:\/\/|@1|127\.0/iu);
					// Only the parts the URL has: a URL without a password has an
					// empty one, and every string contains the empty string.
					const address = new URL(url);
					const parts = [
						decodeURIComponent(address.password),
						decodeURIComponent(address.username),
						address.host,
						address.hostname,
						standby.name,
					].filter((part) => part !== "");
					expect(parts.length).toBeGreaterThanOrEqual(3);
					for (const part of parts)
						expect(refusal?.message).not.toContain(part);
				}
				// Not downgraded, not touched: the future column and its ledger
				// row are still there, and not even the writer's initialisers ran.
				expect(
					compareCatalogs(
						{ label: "before", facts: before.facts },
						{ label: "after", facts: await schemaFacts(standby.pool) },
					),
				).toEqual([]);
				expect(await ledger(standby)).toEqual(before.ledger);
				expect(
					(await rowCounts(standby)).filter(([, rows]) => rows > 0),
				).toEqual([]);
			});
		}, 120_000);

		it("applies once when several instances prepare the same backend at once", async () => {
			await withScratchDatabases(url, ["raced"], async (databases) => {
				const standby = only(databases);
				const runs = await Promise.all(
					Array.from({ length: 4 }, () =>
						prepareRelaySchema(standby.pool, "b1", "standby"),
					),
				);
				// Every migration was applied by exactly one of them; the others
				// waited at the lock and found it recorded.
				expect(runs.flatMap((run) => run.applied).sort()).toEqual(
					[...EVERYTHING].sort(),
				);
				expect(await ledger(standby)).toEqual([...EVERYTHING].sort());

				// A writer being brought forward meanwhile takes the same lock
				// as a migration run of its store's tables: the store's own
				// initialiser and the migrations do not interleave.
				const [ciSet] = RELAY_SCHEMA_MIGRATIONS;
				if (!ciSet) throw new Error("the relay has no migrations");
				await withScratchDatabases(url, ["mixed"], async (mixed) => {
					const backend = only(mixed);
					const [asWriter, direct] = await Promise.all([
						prepareRelaySchema(backend.pool, "b0", "writer"),
						applyMigrations(backend.pool, ciSet),
					]);
					expect(
						[
							...asWriter.applied,
							...direct.applied.map((id) => `@hobo/ci/${id}`),
						].sort(),
					).toEqual([...EVERYTHING].sort());
					expect(
						compareCatalogs(
							{ label: "raced", facts: await schemaFacts(standby.pool) },
							{ label: "mixed", facts: await schemaFacts(backend.pool) },
						),
					).toEqual([]);
				});
			});
		}, 120_000);

		it("says which backend could not be brought forward, and records nothing for it", async () => {
			await withScratchDatabases(url, ["stale"], async (databases) => {
				const standby = only(databases);
				// A table of the right name and another layout: the guarded
				// CREATE skips it, and the migration cannot converge on it.
				await standby.pool.query(
					"CREATE TABLE hobo_ci_events (left_behind text)",
				);
				const refusal = await prepareRelaySchema(
					standby.pool,
					"b1",
					"standby",
				).then(
					() => undefined,
					(error: Error) => error,
				);
				expect(refusal).toBeInstanceOf(RelaySchemaError);
				expect(refusal).toMatchObject({
					backend: "b1",
					failure: "refused",
					scope: "@hobo/ci",
				});
				expect(refusal?.message).toMatch(/fleet backend b1 /u);
				expect(refusal?.message).not.toContain(new URL(url).host);
				const recorded = await standby.pool.query(
					"SELECT to_regclass($1) AS ledger",
					[SCHEMA_LEDGER_TABLE],
				);
				expect(recorded.rows).toEqual([{ ledger: null }]);
			});
		}, 120_000);
	},
);
