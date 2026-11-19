import {
	EventStoreError,
	UnsupportedSchemaVersionError,
} from "@hobo/core/eventstore";
import { asNumber, asText, type SqliteDriver } from "./driver.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

function normalizeSql(sql: string): string {
	return sql
		.replace(/\bIF NOT EXISTS\s+/iu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

function verifyJournalSchema(db: SqliteDriver): void {
	const lookup = db.prepare(
		"SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
	);
	for (const statement of SCHEMA_SQL.split(";")) {
		const sql = statement.trim();
		if (!sql) continue;
		const match = /^CREATE\s+(TABLE|INDEX)\s+IF NOT EXISTS\s+(\w+)/iu.exec(sql);
		if (!match)
			throw new Error("journal schema contains an unsupported statement");
		const [, kind, name] = match;
		if (!kind || !name) throw new Error("journal schema object is unnamed");
		const row = lookup.get(kind.toLowerCase(), name);
		if (
			!row ||
			normalizeSql(asText(row.sql, `${name}.sql`)) !== normalizeSql(sql)
		) {
			throw new EventStoreError(
				"INTEGRITY_FAILURE",
				`journal schema mismatch: ${name}`,
			);
		}
	}
}

function readSchemaVersion(db: SqliteDriver): number {
	const row = db.prepare("PRAGMA user_version").get();
	return row ? asNumber(Object.values(row)[0], "user_version") : 0;
}

export function initializeJournalSchema(db: SqliteDriver): void {
	const initialVersion = readSchemaVersion(db);
	if (initialVersion === SCHEMA_VERSION) {
		verifyJournalSchema(db);
		return;
	}
	if (initialVersion !== 0)
		throw new UnsupportedSchemaVersionError(initialVersion, SCHEMA_VERSION);
	db.beginImmediate();
	try {
		const version = readSchemaVersion(db);
		if (version !== 0 && version !== SCHEMA_VERSION)
			throw new UnsupportedSchemaVersionError(version, SCHEMA_VERSION);
		if (version === 0) {
			const existing = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
				)
				.get();
			if (existing) {
				throw new EventStoreError(
					"INTEGRITY_FAILURE",
					"journal database is not empty",
				);
			}
			db.exec(SCHEMA_SQL);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		}
		verifyJournalSchema(db);
		db.commit();
	} catch (error) {
		db.rollback();
		throw error;
	}
}

export function assertIntegrity(db: SqliteDriver): void {
	const integrity = db.prepare("PRAGMA integrity_check").get();
	const integrityValue = integrity
		? String(Object.values(integrity)[0] ?? "")
		: "";
	if (integrityValue !== "ok") {
		throw new EventStoreError(
			"INTEGRITY_FAILURE",
			`PRAGMA integrity_check failed: ${integrityValue}`,
		);
	}
	const violations = db.prepare("PRAGMA foreign_key_check").all();
	if (violations.length > 0) {
		throw new EventStoreError(
			"INTEGRITY_FAILURE",
			`PRAGMA foreign_key_check found ${violations.length} violation(s)`,
		);
	}
}
