import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	planBetterAuthBundle,
	planBetterAuthRelationalMigrations,
} from "@hobo/pack-better-auth";
import { Schema } from "effect";

import { parseBetterAuthHostDotEnv } from "./better-auth-host-harness.js";

const isNonEmptyString = Schema.is(Schema.NonEmptyString);

const SQLITE_AFFINITY = {
	boolean: "INTEGER",
	text: "TEXT",
	"timestamp with time zone": "TEXT",
} as const satisfies Record<string, string>;

export interface SyntheticBetterAuthSession {
	readonly sessionId: string;
	readonly sessionToken: string;
	readonly userId: string;
	readonly expiresAtIso: string;
}

function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function sqliteColumnSql(column: {
	readonly name: string;
	readonly type: string;
	readonly nullable: boolean;
	readonly primaryKey: boolean;
	readonly unique: boolean;
}): string {
	const affinity = SQLITE_AFFINITY[column.type];
	if (affinity === undefined) {
		throw new Error(
			`no sqlite affinity for Better Auth column type ${column.type}`,
		);
	}
	const parts = [quoteIdent(column.name), affinity];
	if (column.primaryKey) parts.push("PRIMARY KEY");
	if (!column.nullable) parts.push("NOT NULL");
	if (column.unique && !column.primaryKey) parts.push("UNIQUE");
	return parts.join(" ");
}

function applyBetterAuthCreateTables(database: DatabaseSync): void {
	const inputs = parseBetterAuthHostDotEnv();
	const bundlePlan = planBetterAuthBundle(
		inputs.configInput,
		inputs.portsInput,
	);
	const planned = planBetterAuthRelationalMigrations(bundlePlan);
	const tables = new Map(
		planned.desiredSchema.tables.map((table) => [table.name, table]),
	);
	for (const step of planned.migrationPlan.steps) {
		if (step.kind !== "create-table") continue;
		const table = tables.get(step.table);
		if (table === undefined) {
			throw new Error(
				`migration plan create-table ${step.table} is missing from the desired schema`,
			);
		}
		const columns = table.columns.map((column) => sqliteColumnSql(column));
		database.exec(
			`CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (${columns.join(", ")})`,
		);
	}
}

export function openBetterAuthSessionStore(path: string): DatabaseSync {
	mkdirSync(dirname(path), { recursive: true });
	const database = new DatabaseSync(path);
	applyBetterAuthCreateTables(database);
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

export function loadSyntheticBetterAuthSession(
	database: DatabaseSync,
	sessionToken: string,
): SyntheticBetterAuthSession | null {
	const maybeRow = database
		.prepare(
			`SELECT id, token, userId, expiresAt FROM session WHERE token = ? LIMIT 1`,
		)
		.get(sessionToken);
	if (maybeRow === null || maybeRow === undefined) {
		return null;
	}
	const { id, token, userId, expiresAt } = maybeRow;
	if (
		!isNonEmptyString(id) ||
		!isNonEmptyString(token) ||
		!isNonEmptyString(userId) ||
		!isNonEmptyString(expiresAt)
	) {
		return null;
	}
	return Object.freeze({
		sessionId: id,
		sessionToken: token,
		userId,
		expiresAtIso: expiresAt,
	});
}

export function simulateProcessRestart(
	path: string,
	database: DatabaseSync,
): DatabaseSync {
	closeBetterAuthSessionStore(database);
	return openBetterAuthSessionStore(path);
}
