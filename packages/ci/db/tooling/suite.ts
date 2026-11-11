/**
 * The tests every relay package runs against its own `db/`.
 *
 * Two groups. The first needs no database and runs everywhere: it holds the
 * three sources of schema truth (the Drizzle module, the checked-in
 * migrations, the embedded DDL) to each other. The second needs a real
 * PostgreSQL and is skipped unless `HOBO_TEST_POSTGRES_URL` is set: it builds
 * the schema both ways and compares what PostgreSQL recorded.
 *
 * The lock ties the two groups together. The database-free group fails the
 * moment the embedded DDL stops being the DDL that was last proven equivalent,
 * and the only way to refresh the lock is `db:verify`, which runs the proof.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
	applyMigrations,
	checkEmbeddedDdlLock,
	checkMigrations,
	type EquivalenceProof,
	embeddedTableNames,
	loadMigrationSet,
	type MigrationSet,
	proveEquivalence,
	type RelaySchemaSource,
	readEmbeddedDdl,
	readJournal,
	readSnapshot,
	SCHEMA_LEDGER_TABLE,
	SchemaMigrationError,
	withScratchDatabases,
} from "./index.js";

export const TEST_POSTGRES_URL = process.env.HOBO_TEST_POSTGRES_URL;
const DATABASE_TIMEOUT_MS = 120_000;

export interface SchemaExpectations {
	/** Every table the package owns, sorted. */
	readonly tables: readonly string[];
	/** Impedance findings by code: what the canonical IR could not carry. */
	readonly impedance: Readonly<Partial<Record<string, number>>>;
	/** Statements bound to a `create-table` step for want of their own step. */
	readonly fallbacks: number;
	/**
	 * A rewording of one migration statement that changes the schema without
	 * tripping the violations query, and the catalog fact it must surface as.
	 * This is the control that shows the comparison can fail.
	 */
	readonly control: {
		readonly find: string;
		readonly replace: string;
		readonly surfacesAs: string;
	};
}

function reworded(
	set: MigrationSet,
	control: SchemaExpectations["control"],
): MigrationSet {
	return {
		...set,
		migrations: set.migrations.map((migration) => ({
			...migration,
			statements: migration.statements.map((statement) =>
				statement.replace(control.find, control.replace),
			),
		})),
	};
}

export function defineSchemaSuite(
	source: RelaySchemaSource,
	expected: SchemaExpectations,
): void {
	describe(`${source.scope} postgres schema`, () => {
		it("declares exactly the tables the embedded DDL creates", async () => {
			const snapshot = await readSnapshot(source.directory);
			const embedded = embeddedTableNames(await readEmbeddedDdl(source));

			expect(snapshot?.schemaIr.tables.map((table) => table.name)).toEqual(
				expected.tables,
			);
			expect(embedded).toEqual(expected.tables);
		});

		it("has checked-in migrations that are what db/schema.ts generates", async () => {
			expect(await checkMigrations(source)).toEqual([]);
		});

		it("still carries the embedded DDL that was proven equivalent", async () => {
			expect(await checkEmbeddedDdlLock(source)).toEqual([]);
		});

		it("plans the baseline as forward-only expand steps under the pinned engine", async () => {
			const journal = await readJournal(source.directory);
			const plan = journal?.migrations[0]?.plan;

			expect(journal?.migrations.map((entry) => entry.id)).toEqual([
				"0000_baseline",
			]);
			expect(plan?.engineId).toBe("drizzle-kit");
			// The version it was generated with, which an upgrade does not rewrite.
			expect(plan?.engineVersion).toMatch(/^\d+\.\d+\.\d+/u);
			expect(
				plan?.steps.filter(
					(step) => step.phase !== "expand" || step.destructive,
				),
			).toEqual([]);
			expect(
				plan?.steps
					.filter((step) => step.kind === "create-table")
					.map((step) => step.table),
			).toEqual(expected.tables);
		});

		it("names every construct the canonical IR could not carry", async () => {
			const journal = await readJournal(source.directory);
			const entry = journal?.migrations[0];
			const counts: Partial<Record<string, number>> = {};
			for (const finding of entry?.impedance ?? [])
				counts[finding.code] = (counts[finding.code] ?? 0) + 1;

			expect(counts).toEqual(expected.impedance);
			expect(entry?.fallbacks).toHaveLength(expected.fallbacks);
			// The one construct that is allowed to ride another step's SQL.
			expect(
				entry?.fallbacks.filter(
					(fallback) =>
						!fallback.reason.startsWith(
							"DRIZZLE_INDEX_EXPRESSION_UNREPRESENTABLE",
						),
				),
			).toEqual([]);
		});

		it("guards every statement so it converges on an existing database", async () => {
			const set = await loadMigrationSet(source.directory);
			const statements = set.migrations.flatMap(
				(migration) => migration.statements,
			);

			expect(statements.length).toBeGreaterThan(0);
			expect(
				statements.filter((statement) => !statement.includes("IF NOT EXISTS")),
			).toEqual([]);
		});
	});

	describe.skipIf(!TEST_POSTGRES_URL)(
		`${source.scope} postgres schema on a real database`,
		() => {
			const url = TEST_POSTGRES_URL ?? "";
			let set: MigrationSet;
			let proof: EquivalenceProof;
			beforeAll(async () => {
				set = await loadMigrationSet(source.directory);
				proof = await proveEquivalence(url, {
					migrations: set,
					initializeEmbedded: source.initializeEmbedded,
				});
			}, DATABASE_TIMEOUT_MS);

			it("builds the same catalog from migrations as from the embedded DDL", () => {
				expect(proof.differences).toEqual([]);
				expect(proof.factsCompared).toBeGreaterThan(expected.tables.length);
				expect(proof.justified).toHaveLength(1);
				expect(proof.justified[0]).toContain(SCHEMA_LEDGER_TABLE);
			});

			it("applies the baseline to an empty database", () => {
				expect(proof.appliedToEmpty).toEqual(["0000_baseline"]);
			});

			it("migrates a database the embedded DDL initialised without changing schema or rows", () => {
				expect(proof.appliedToExisting).toEqual(["0000_baseline"]);
				expect(proof.rowsPreserved).toBeGreaterThanOrEqual(
					expected.tables.length,
				);
				expect(proof.existingCatalogChanges).toEqual([]);
				expect(proof.existingDataChanges).toEqual([]);
			});

			it("applies nothing on a second run", () => {
				expect(proof.reapplied).toEqual([]);
			});

			it(
				"sees a reworded statement as a catalog difference",
				async () => {
					const control = await proveEquivalence(url, {
						migrations: reworded(set, expected.control),
						initializeEmbedded: source.initializeEmbedded,
					});

					expect(control.differences).toHaveLength(1);
					expect(control.differences[0]).toContain(expected.control.surfacesAs);
				},
				DATABASE_TIMEOUT_MS,
			);

			it(
				"records nothing for a database it could not converge",
				async () => {
					const stale = expected.tables[0] ?? "";
					await withScratchDatabases(url, ["stale"], async ([database]) => {
						if (!database) throw new Error("scratch database missing");
						// A table of the right name and the wrong layout: the
						// guarded CREATE skips it, so only verification can object.
						await database.pool.query(
							`CREATE TABLE ${stale} (left_behind text)`,
						);

						await expect(
							applyMigrations(database.pool, set),
						).rejects.toBeInstanceOf(SchemaMigrationError);
						await expect(applyMigrations(database.pool, set)).rejects.toThrow(
							/did not converge.*missing/u,
						);

						const ledger = await database.pool.query(
							"SELECT to_regclass($1) AS ledger",
							[SCHEMA_LEDGER_TABLE],
						);
						expect(ledger.rows).toEqual([{ ledger: null }]);
					});
				},
				DATABASE_TIMEOUT_MS,
			);
		},
	);
}
