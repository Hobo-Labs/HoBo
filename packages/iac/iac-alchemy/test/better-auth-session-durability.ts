import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SyntheticBetterAuthSession {
	readonly sessionId: string;
	readonly sessionToken: string;
	readonly userId: string;
	readonly expiresAtIso: string;
}

const SESSION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  userId TEXT NOT NULL
)`;

export function openBetterAuthSessionStore(path: string): DatabaseSync {
	mkdirSync(dirname(path), { recursive: true });
	const database = new DatabaseSync(path);
	database.exec(SESSION_TABLE_DDL);
	return database;
}

export function closeBetterAuthSessionStore(database: DatabaseSync): void {
	database.close();
}

export function recordSyntheticBetterAuthSignIn(
	database: DatabaseSync,
	options?: {
		readonly sessionId?: string;
		readonly sessionToken?: string;
		readonly userId?: string;
		readonly nowIso?: string;
	},
): SyntheticBetterAuthSession {
	const nowIso = options?.nowIso ?? "2026-11-25T12:00:00.000Z";
	const sessionId = options?.sessionId ?? "sess_fixture_restart";
	const sessionToken = options?.sessionToken ?? "tok_fixture_restart";
	const userId = options?.userId ?? "user_fixture_restart";
	const expiresAtIso = "2026-12-25T12:00:00.000Z";
	database
		.prepare(
			`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
       VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(sessionId, expiresAtIso, sessionToken, nowIso, nowIso, userId);
	return Object.freeze({
		sessionId,
		sessionToken,
		userId,
		expiresAtIso,
	});
}

interface SqliteSessionRow {
	readonly id: string;
	readonly token: string;
	readonly userId: string;
	readonly expiresAt: string;
}

export function loadSyntheticBetterAuthSession(
	database: DatabaseSync,
	sessionToken: string,
): SyntheticBetterAuthSession | null {
	const maybeRow = database
		.prepare(`SELECT id, token, userId, expiresAt FROM session WHERE token = ? LIMIT 1`)
		.get(sessionToken);
	if (maybeRow === null || maybeRow === undefined) {
		return null;
	}
	// SAFETY: `StatementSync.get` returns a row object whose keys match this SELECT list.
	const row = maybeRow as SqliteSessionRow;
	if (
		row.id.length === 0 ||
		row.token.length === 0 ||
		row.userId.length === 0 ||
		row.expiresAt.length === 0
	) {
		return null;
	}
	return Object.freeze({
		sessionId: row.id,
		sessionToken: row.token,
		userId: row.userId,
		expiresAtIso: row.expiresAt,
	});
}

export function simulateProcessRestart(path: string, database: DatabaseSync): DatabaseSync {
	closeBetterAuthSessionStore(database);
	return openBetterAuthSessionStore(path);
}