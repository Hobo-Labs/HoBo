import { describe, expect, it } from "vitest";
import {
	applyMigrations,
	compareCatalogs,
	loadMigrationSet,
	schemaFacts,
	withScratchDatabases,
} from "../../ci/db/tooling/index.js";
import { TEST_POSTGRES_URL } from "../../ci/db/tooling/suite.js";
import { schemaSource } from "../db/source.js";

const url = TEST_POSTGRES_URL ?? "";

/**
 * The bootstrap tables as they were before `PostgresAppBootstrapStore` grew
 * the `ALTER TABLE` statements it runs today: the `CREATE TABLE` text minus
 * the columns those statements add, and with the NOT NULL one of them drops.
 */
const EARLIER_TABLES = [
	"CREATE TABLE hobo_ci_platform_app (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), status text NOT NULL, session_digest text NOT NULL, token_digest text NOT NULL, state_digest text NOT NULL, expires_ms bigint NOT NULL, app_id bigint)",
	"CREATE TABLE hobo_ci_platform_app_attempts (session_digest text PRIMARY KEY, status text NOT NULL, expires_ms bigint NOT NULL)",
	"CREATE TABLE hobo_ci_platform_app_invitations (invitation_digest text PRIMARY KEY, session_digest text UNIQUE NOT NULL, expires_ms bigint NOT NULL)",
];

describe.skipIf(!TEST_POSTGRES_URL)(
	"@hobo/ci-gh-actions postgres schema on a database with a history",
	() => {
		it("migrates a database from an earlier release, which keeps the layout its history gave it", async () => {
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
						"INSERT INTO hobo_ci_platform_app_attempts VALUES ('session-1', 'pending', 1)",
					);
					await schemaSource.initializeEmbedded(earlier.pool);
					const result = await applyMigrations(earlier.pool, set);
					const kept = await earlier.pool.query(
						"SELECT session_digest, created_ms FROM hobo_ci_platform_app_attempts",
					);
					const differences = compareCatalogs(
						{ label: "new", facts: await schemaFacts(fresh.pool) },
						{ label: "earlier", facts: await schemaFacts(earlier.pool) },
					);

					expect(result.applied).toEqual(["0000_baseline"]);
					expect(kept.rows).toEqual([
						{ session_digest: "session-1", created_ms: "0" },
					]);
					// Not introduced by the migration: the embedded DDL itself
					// leaves these behind. A column added by ALTER lands after the
					// existing ones and keeps the DEFAULT it was added with, while
					// a new database gets it in CREATE TABLE position, without one.
					expect(differences).toEqual([
						"column hobo_ci_platform_app_attempts.created_ms: new has (position 3 | type bigint | not null | default (none) | identity (none) | generated (none) | collation (none)); earlier has (position 4 | type bigint | not null | default 0 | identity (none) | generated (none) | collation (none))",
						"column hobo_ci_platform_app_attempts.expires_ms: new has (position 4 | type bigint | not null | default (none) | identity (none) | generated (none) | collation (none)); earlier has (position 3 | type bigint | not null | default (none) | identity (none) | generated (none) | collation (none))",
					]);
				},
			);
		}, 120_000);
	},
);
