import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnsupportedSchemaVersionError } from "@hobo/core/eventstore";
import { describe, expect, it } from "vitest";
import type { SqliteDriver } from "../src/driver.js";
import { SqliteJournal } from "../src/journal.js";
import {
	createMemoryNodeSqliteDriver,
	createNodeSqliteDriver,
} from "../src/node-driver.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/schema.js";
import { initializeJournalSchema } from "../src/schema-initialization.js";

function schemaObjects(db: SqliteDriver) {
	return db
		.prepare(
			"SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all();
}

describe("journal schema initialization", () => {
	it("creates the schema once and keeps data on repeated opens", () => {
		const db = createMemoryNodeSqliteDriver();
		try {
			initializeJournalSchema(db);
			db.prepare(
				"INSERT INTO streams (stream_id, revision, owner_epoch, created_at, updated_at) VALUES (?, 0, 0, ?, ?)",
			).run("orders", "2026-01-01", "2026-01-01");
			const before = schemaObjects(db);
			initializeJournalSchema(db);
			expect(schemaObjects(db)).toEqual(before);
			expect(db.prepare("SELECT stream_id FROM streams").get()?.stream_id).toBe(
				"orders",
			);
			expect(db.pragma("user_version")).toBe(String(SCHEMA_VERSION));
		} finally {
			db.close();
		}
	});

	it("refuses an uninitialized database containing unrelated data", () => {
		const db = createMemoryNodeSqliteDriver();
		try {
			db.exec(
				"CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES ('preserved')",
			);
			const before = schemaObjects(db);
			expect(() => initializeJournalSchema(db)).toThrow(
				"journal database is not empty",
			);
			expect(schemaObjects(db)).toEqual(before);
			expect(db.prepare("SELECT value FROM existing").get()?.value).toBe(
				"preserved",
			);
		} finally {
			db.close();
		}
	});

	it("refuses a different schema version without changing it", () => {
		const db = createMemoryNodeSqliteDriver();
		try {
			initializeJournalSchema(db);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
			const before = schemaObjects(db);
			expect(() => initializeJournalSchema(db)).toThrow(
				UnsupportedSchemaVersionError,
			);
			expect(schemaObjects(db)).toEqual(before);
			expect(db.pragma("user_version")).toBe(String(SCHEMA_VERSION + 1));
		} finally {
			db.close();
		}
	});

	it("refuses an incompatible file before changing journal settings", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-schema-"));
		const db = createNodeSqliteDriver({
			path: join(directory, "journal.sqlite"),
		});
		try {
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
			const journalMode = db.pragma("journal_mode");
			expect(() => new SqliteJournal(db)).toThrow(
				UnsupportedSchemaVersionError,
			);
			expect(db.pragma("journal_mode")).toBe(journalMode);
			expect(schemaObjects(db)).toEqual([]);
		} finally {
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses a database whose stamped schema has been changed", () => {
		const db = createMemoryNodeSqliteDriver();
		try {
			initializeJournalSchema(db);
			db.exec("DROP INDEX events_stream_seq");
			expect(() => initializeJournalSchema(db)).toThrow(
				"journal schema mismatch: events_stream_seq",
			);
			expect(
				db
					.prepare("SELECT name FROM sqlite_master WHERE name = ?")
					.get("events_stream_seq"),
			).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("rolls back partial schema creation on failure", () => {
		const db = createMemoryNodeSqliteDriver();
		const failing: SqliteDriver = {
			...db,
			exec(sql) {
				if (sql === SCHEMA_SQL) {
					db.exec("CREATE TABLE partial (value TEXT)");
					throw new Error("injected creation failure");
				}
				db.exec(sql);
			},
		};
		try {
			expect(() => initializeJournalSchema(failing)).toThrow(
				"injected creation failure",
			);
			expect(schemaObjects(db)).toEqual([]);
			expect(db.pragma("user_version")).toBe("0");
			initializeJournalSchema(db);
		} finally {
			db.close();
		}
	});
});
