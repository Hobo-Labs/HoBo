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

const MIGRATIONS = ["0000_baseline", "0001_events_account"];

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

					expect(result.applied).toEqual(MIGRATIONS);
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
			const checkedIn = await loadMigrationSet(schemaSource.directory);
			const baseline = checkedIn.migrations[0];
			if (!baseline) throw new Error("baseline missing");
			const set = { ...checkedIn, migrations: [baseline] };
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
			await withScratchDatabases(url, ["later"], async ([database]) => {
				if (!database) throw new Error("scratch database missing");
				// A database one migration behind: only the baseline is recorded.
				await applyMigrations(database.pool, {
					...set,
					migrations: [baseline],
				});
				const first = await applyMigrations(database.pool, set);
				const second = await applyMigrations(database.pool, set);

				expect(first).toEqual({
					scope: "@hobo/ci",
					applied: MIGRATIONS.slice(1),
					alreadyApplied: ["0000_baseline"],
				});
				expect(second).toEqual({
					scope: "@hobo/ci",
					applied: [],
					alreadyApplied: MIGRATIONS,
				});
			});
		}, 120_000);

		it("adds the events account column and index to a journal with rows, and rewrites none", async () => {
			const set = await loadMigrationSet(schemaSource.directory);
			const baseline = set.migrations[0];
			if (!baseline) throw new Error("baseline missing");
			await withScratchDatabases(url, ["journal"], async ([database]) => {
				if (!database) throw new Error("scratch database missing");
				await applyMigrations(database.pool, {
					...set,
					migrations: [baseline],
				});
				// What a release from before the column journalled.
				await database.pool.query(
					`INSERT INTO hobo_ci_events(partition_id,body)
					 SELECT 'default', '{"type":"ci.ControlRecordUpdated","accountId":"mine"}'
					 FROM generate_series(1,500)`,
				);
				const before = await database.pool.query(
					"SELECT ctid::text AS place, seq::text AS seq FROM hobo_ci_events ORDER BY seq",
				);
				await applyMigrations(database.pool, set);
				const after = await database.pool.query(
					"SELECT ctid::text AS place, seq::text AS seq FROM hobo_ci_events ORDER BY seq",
				);
				const stamped = await database.pool.query(
					"SELECT count(*)::text AS rows FROM hobo_ci_events WHERE account_id IS NOT NULL",
				);
				const index = await database.pool.query(
					"SELECT indexdef FROM pg_indexes WHERE indexname = 'hobo_ci_events_account_seq'",
				);

				// Every row is the tuple it was: the migration is two catalog
				// changes and an index build, never a rewrite or a fill-in. The
				// store stamps old rows afterwards, in batches, on the writer.
				expect(after.rows).toEqual(before.rows);
				expect(stamped.rows).toEqual([{ rows: "0" }]);
				expect(index.rows).toEqual([
					{
						indexdef:
							"CREATE INDEX hobo_ci_events_account_seq ON public.hobo_ci_events USING btree (partition_id, account_id, seq)",
					},
				]);
			});
		}, 120_000);
	},
);
