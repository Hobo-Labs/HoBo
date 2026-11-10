/**
 * Real SQLite DDL the engine conformance kit drives `in-place-evolve` with.
 * Exported so any harness around a SQLite binding can prove the schema port —
 * a harness that supplies no fixture leaves those cases `not-run`, and the
 * report `unknown`.
 */
import type { SchemaFixture } from "@hobo/data-core";

export const SQLITE_SCHEMA_FIXTURE: SchemaFixture = Object.freeze({
	setup: [
		"CREATE TABLE checkout (id TEXT PRIMARY KEY, email TEXT NOT NULL)",
		"INSERT INTO checkout (id, email) VALUES ('1', 'a@example.test'), ('2', 'b@example.test')",
	],
	plan: {
		migrationId: "sqlite-conformance",
		expand: ["ALTER TABLE checkout ADD COLUMN requester_ref TEXT"],
		backfill: [
			"UPDATE checkout SET requester_ref = 'ref:' || id WHERE requester_ref IS NULL",
		],
		contract: ["ALTER TABLE checkout DROP COLUMN email"],
		verify: {
			afterBackfill: "SELECT id FROM checkout WHERE requester_ref IS NULL",
		},
	},
	provesContractApplied:
		"SELECT 1 AS applied WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info('checkout') WHERE name = 'email')",
	failingStatement: "ALTER TABLE checkout DROP COLUMN no_such_column",
	// Two statements with separate effects, for the probes that put more than
	// one statement where one belongs.
	probes: {
		first: "CREATE TABLE checkout_probe_first (id TEXT PRIMARY KEY)",
		second: "CREATE TABLE checkout_probe_second (id TEXT PRIMARY KEY)",
		provesFirst:
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkout_probe_first'",
		provesSecond:
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkout_probe_second'",
	},
});
