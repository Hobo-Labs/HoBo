import { describe, expect, it } from "vitest";
import { schemaSource } from "../db/source.js";
import {
	applyMigrations,
	compareCatalogs,
	loadMigrationSet,
	SCHEMA_LEDGER_TABLE,
	schemaFacts,
	withScratchDatabases,
} from "../db/tooling/index.js";
import { TEST_POSTGRES_URL } from "../db/tooling/suite.js";

const url = TEST_POSTGRES_URL ?? "";

/**
 * The four tables as they were before `PostgresCiStore.initialize` grew the
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements it runs today: the
 * `CREATE TABLE` text minus the columns those statements add.
 */
const EARLIER_TABLES = [
	"CREATE TABLE hobo_ci_partitions (id text PRIMARY KEY, snapshot bytea)",
	"CREATE TABLE hobo_ci_assigned_jobs (partition_id text NOT NULL, job_key text NOT NULL, lease_id text NOT NULL, PRIMARY KEY(partition_id,job_key))",
	"CREATE TABLE hobo_ci_sandbox_proxies (partition_id text NOT NULL,lease_id text NOT NULL,account_id text NOT NULL,proxy_session_id text NOT NULL,token_sha256 text NOT NULL,PRIMARY KEY(partition_id,lease_id),UNIQUE(partition_id,proxy_session_id))",
	"CREATE TABLE hobo_ci_inbox (seq bigserial, partition_id text NOT NULL, delivery_id text NOT NULL, fingerprint text NOT NULL, event text NOT NULL, installation_id bigint NOT NULL, repository_id bigint NOT NULL, raw_body bytea NOT NULL, received_at text NOT NULL, claim_token text, claim_until bigint NOT NULL DEFAULT 0, completed boolean NOT NULL DEFAULT false, attempts integer NOT NULL DEFAULT 0, quarantined boolean NOT NULL DEFAULT false, PRIMARY KEY(partition_id,delivery_id))",
];

interface LedgerRow {
	readonly scope: string;
	readonly id: string;
	readonly sql_sha256: string;
	readonly plan_digest: string;
	readonly engine: string;
}

describe.skipIf(!TEST_POSTGRES_URL)(
	"@hobo/ci postgres schema on databases with a history",
	() => {
		it("converges a database from an earlier release on the catalog of a new one", async () => {
			const set = await loadMigrationSet(schemaSource.directory);
			await withScratchDatabases(
				url,
				["new", "earlier"],
				async ([fresh, earlier]) => {
					if (!fresh || !earlier) throw new Error("scratch database missing");
					await schemaSource.initializeEmbedded(fresh.pool);
					for (const statement of EARLIER_TABLES)
						await earlier.pool.query(statement);
					await earlier.pool.query(
						"INSERT INTO hobo_ci_assigned_jobs VALUES ('default', 'job-1', 'lease-1')",
					);
					// Today's release starts against it and brings it forward…
					await schemaSource.initializeEmbedded(earlier.pool);
					// …and only then is it migrated.
					const result = await applyMigrations(earlier.pool, set);
					const kept = await earlier.pool.query(
						"SELECT job_key, lease_id FROM hobo_ci_assigned_jobs",
					);

					expect(result.applied).toEqual(["0000_baseline"]);
					expect(kept.rows).toEqual([
						{ job_key: "job-1", lease_id: "lease-1" },
					]);
					expect(
						compareCatalogs(
							{ label: "new", facts: await schemaFacts(fresh.pool) },
							{ label: "earlier", facts: await schemaFacts(earlier.pool) },
						),
					).toEqual([]);
				},
			);
		}, 120_000);

		it("refuses an earlier-release database today's release has not started against", async () => {
			const set = await loadMigrationSet(schemaSource.directory);
			await withScratchDatabases(url, ["unstarted"], async ([database]) => {
				if (!database) throw new Error("scratch database missing");
				for (const statement of EARLIER_TABLES)
					await database.pool.query(statement);

				// The first statement that needs a later column fails, and the
				// whole run rolls back with it.
				await expect(applyMigrations(database.pool, set)).rejects.toThrow(
					/0000_baseline failed and was rolled back.*"received_ms" does not exist.*CREATE INDEX/u,
				);
				const ledger = await database.pool.query(
					"SELECT to_regclass($1) AS ledger, to_regclass('hobo_ci_events') AS created",
					[SCHEMA_LEDGER_TABLE],
				);
				expect(ledger.rows).toEqual([{ ledger: null, created: null }]);
			});
		}, 120_000);

		it("records each applied migration once per scope and holds later runs to it", async () => {
			const set = await loadMigrationSet(schemaSource.directory);
			const baseline = set.migrations[0];
			if (!baseline) throw new Error("baseline missing");
			await withScratchDatabases(url, ["ledger"], async ([database]) => {
				if (!database) throw new Error("scratch database missing");
				await applyMigrations(database.pool, set);
				const again = await applyMigrations(database.pool, set);
				const other = await applyMigrations(database.pool, {
					...set,
					scope: "another-package",
				});
				const ledger = await database.pool.query<LedgerRow>(
					`SELECT scope, id, sql_sha256, plan_digest, engine FROM ${SCHEMA_LEDGER_TABLE} ORDER BY scope`,
				);

				expect(again).toEqual({
					scope: "@hobo/ci",
					applied: [],
					alreadyApplied: ["0000_baseline"],
				});
				expect(other.applied).toEqual(["0000_baseline"]);
				expect(ledger.rows).toEqual([
					{
						scope: "@hobo/ci",
						id: "0000_baseline",
						sql_sha256: baseline.sqlSha256,
						plan_digest: baseline.planDigest,
						engine: baseline.engine,
					},
					{
						scope: "another-package",
						id: "0000_baseline",
						sql_sha256: baseline.sqlSha256,
						plan_digest: baseline.planDigest,
						engine: baseline.engine,
					},
				]);

				await expect(
					applyMigrations(database.pool, {
						...set,
						migrations: [{ ...baseline, sqlSha256: "0".repeat(64) }],
					}),
				).rejects.toThrow(/applied with different SQL/u);
				await expect(
					applyMigrations(database.pool, { ...set, migrations: [] }),
				).rejects.toThrow(/ahead of this code/u);
			});
		}, 120_000);

		it("applies a later migration on top of a recorded baseline, once", async () => {
			const set = await loadMigrationSet(schemaSource.directory);
			const baseline = set.migrations[0];
			if (!baseline) throw new Error("baseline missing");
			const later = {
				...baseline,
				id: "0001_note",
				statements: [
					'ALTER TABLE "hobo_ci_configuration" ADD COLUMN IF NOT EXISTS "note" text;',
				],
				sqlSha256: "1".repeat(64),
			};
			await withScratchDatabases(url, ["later"], async ([database]) => {
				if (!database) throw new Error("scratch database missing");
				await applyMigrations(database.pool, set);
				const extended = { ...set, migrations: [baseline, later] };
				const first = await applyMigrations(database.pool, extended);
				const second = await applyMigrations(database.pool, extended);
				const column = await database.pool.query(
					"SELECT 1 FROM information_schema.columns WHERE table_name = 'hobo_ci_configuration' AND column_name = 'note'",
				);

				expect(first).toEqual({
					scope: "@hobo/ci",
					applied: ["0001_note"],
					alreadyApplied: ["0000_baseline"],
				});
				expect(second.applied).toEqual([]);
				expect(column.rowCount).toBe(1);
			});
		}, 120_000);
	},
);
