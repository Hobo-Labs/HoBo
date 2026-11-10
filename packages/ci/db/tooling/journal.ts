/**
 * The checked-in record of a package's schema migrations.
 *
 * Three files live beside each other under `db/migrations/`:
 *
 * - `NNNN_<name>.sql` is what runs. One statement per `--> statement-breakpoint`
 *   chunk, each already guarded (`IF NOT EXISTS`) so it converges on a database
 *   the embedded DDL created first.
 * - `journal.json` says which SQL files exist, in order, and binds each to the
 *   HoBo `MigrationPlan` it was emitted for: the plan steps, the engine id and
 *   version, the plan digest, the SHA-256 of the SQL, every impedance finding
 *   the canonical IR could not carry, and every statement that had to be bound
 *   to a step by fallback.
 * - `snapshot.json` is the schema after the last migration, as the canonical
 *   IR and as the drizzle-kit snapshot the next diff starts from.
 *
 * Everything here is parsed, not trusted: a journal that names a missing file
 * or a file whose digest moved is refused before any statement is sent.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type MigrationPlan, parseSchemaIr, type SchemaIr } from "@hobo/core";
import type { DrizzleSnapshotJSON } from "drizzle-kit/api";
import { z } from "zod";

export const SCHEMA_JOURNAL_CONTRACT = "hobo.ci.schema-journal/v1";
export const SCHEMA_SNAPSHOT_CONTRACT = "hobo.ci.schema-snapshot/v1";
export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export class SchemaMigrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SchemaMigrationError";
	}
}

const MigrationId = z.string().regex(/^\d{4}_[a-z0-9_]+$/u);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const PlanStep = z.object({
	phase: z.enum(["expand", "backfill", "contract"]),
	kind: z.enum([
		"create-table",
		"add-column",
		"add-index",
		"widen-column",
		"backfill-column",
		"drop-column",
		"drop-index",
		"drop-table",
		"narrow-column",
	]),
	table: z.string().min(1),
	column: z.string().min(1).optional(),
	index: z.string().min(1).optional(),
	destructive: z.boolean(),
});

const Plan = z.object({
	contract: z.literal("hobo.migration-plan/v1"),
	steps: z.array(PlanStep),
	engineId: z.string().min(1),
	engineVersion: z.string().min(1),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});

const Finding = z.object({
	code: z.string().min(1),
	detail: z.string().min(1),
});

/** A statement the canonical IR gave no plan step, and where it was put. */
const FallbackBinding = z.object({
	statement: z.string().min(1),
	boundTo: z.string().min(1),
	reason: z.string().min(1),
});

const JournalEntry = z.object({
	id: MigrationId,
	sql: z.object({
		file: z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/u),
		sha256: Sha256,
		statements: z.number().int().positive(),
	}),
	plan: Plan,
	impedance: z.array(Finding),
	fallbacks: z.array(FallbackBinding),
	verify: z.object({ afterBackfill: z.string().min(1) }),
});

const Journal = z.object({
	contract: z.literal(SCHEMA_JOURNAL_CONTRACT),
	scope: z.string().min(1),
	advisoryLocks: z.array(z.string().min(1)),
	migrations: z.array(JournalEntry),
});

const Snapshot = z.object({
	contract: z.literal(SCHEMA_SNAPSHOT_CONTRACT),
	schemaIr: z.json(),
	drizzleKit: z.custom<DrizzleSnapshotJSON>(
		(value) => value !== null && value !== undefined,
	),
});

export type SchemaJournalEntry = z.infer<typeof JournalEntry>;
export type SchemaJournal = z.infer<typeof Journal>;
export type FallbackBindingRecord = z.infer<typeof FallbackBinding>;

/** A core `MigrationPlan` in the form the journal stores it. */
export function journalPlan(plan: MigrationPlan): SchemaJournalEntry["plan"] {
	return Plan.parse(plan);
}

export interface SchemaSnapshot {
	readonly schemaIr: SchemaIr;
	readonly drizzleKit: DrizzleSnapshotJSON;
}

/** One migration, loaded and digest-checked: exactly what the runner applies. */
export interface LoadedMigration {
	readonly id: string;
	readonly statements: readonly string[];
	readonly sqlSha256: string;
	readonly planDigest: string;
	readonly engine: string;
	readonly violationsQuery: string;
}

export interface MigrationSet {
	readonly scope: string;
	readonly advisoryLocks: readonly string[];
	readonly migrations: readonly LoadedMigration[];
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function splitStatements(sqlText: string): string[] {
	return sqlText
		.split(STATEMENT_BREAKPOINT)
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0);
}

export function serializeJson<T>(value: T): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

async function readOptional(location: URL): Promise<string | undefined> {
	try {
		return await readFile(location, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw error;
	}
}

export async function readJournal(
	directory: URL,
): Promise<SchemaJournal | undefined> {
	const text = await readOptional(new URL("journal.json", directory));
	if (text === undefined) return undefined;
	return Journal.parse(JSON.parse(text));
}

export async function readSnapshot(
	directory: URL,
): Promise<SchemaSnapshot | undefined> {
	const text = await readOptional(new URL("snapshot.json", directory));
	if (text === undefined) return undefined;
	const parsed = Snapshot.parse(JSON.parse(text));
	return {
		schemaIr: parseSchemaIr(parsed.schemaIr),
		drizzleKit: parsed.drizzleKit,
	};
}

/**
 * Loads what the runner applies. A SQL file that is missing, or whose bytes no
 * longer hash to what the journal recorded, is refused here: the journal's plan
 * digest describes the SQL that was reviewed, not whatever is on disk now.
 */
export async function loadMigrationSet(directory: URL): Promise<MigrationSet> {
	const journal = await readJournal(directory);
	if (journal === undefined)
		throw new SchemaMigrationError(
			`no journal.json under ${directory.pathname}; generate the baseline first`,
		);
	const migrations: LoadedMigration[] = [];
	for (const entry of journal.migrations) {
		const sqlText = await readOptional(new URL(entry.sql.file, directory));
		if (sqlText === undefined)
			throw new SchemaMigrationError(
				`migration ${entry.id} names ${entry.sql.file}, which does not exist`,
			);
		if (sha256Hex(sqlText) !== entry.sql.sha256)
			throw new SchemaMigrationError(
				`migration ${entry.id}: ${entry.sql.file} does not hash to the journal's sha256; a migration is never edited after it is generated`,
			);
		const statements = splitStatements(sqlText);
		if (statements.length !== entry.sql.statements)
			throw new SchemaMigrationError(
				`migration ${entry.id}: expected ${entry.sql.statements} statements, found ${statements.length}`,
			);
		migrations.push({
			id: entry.id,
			statements,
			sqlSha256: entry.sql.sha256,
			planDigest: entry.plan.digest,
			engine: `${entry.plan.engineId}@${entry.plan.engineVersion}`,
			violationsQuery: entry.verify.afterBackfill,
		});
	}
	return {
		scope: journal.scope,
		advisoryLocks: journal.advisoryLocks,
		migrations,
	};
}
