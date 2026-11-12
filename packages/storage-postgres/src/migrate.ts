import type { MigrationRecord } from "./_generated/storage_postgres_pb.js";
import { StoragePostgresError } from "./errors.js";
import {
	migrationLockKey,
	quoteSchema,
	type SchemaName,
} from "./identifiers.js";
import {
	MIGRATIONS,
	type Migration,
	migrationChecksum,
} from "./migrations/index.js";
import { type PgClientLike, int4, text } from "./pg.js";

export type MigrationReport = Readonly<{
	serverMajorVersion: number;
	fromVersion: number;
	toVersion: number;
	applied: readonly Omit<MigrationRecord, "$typeName" | "$unknown">[];
}>;

export type MigrateOptions = Readonly<{
	schema: SchemaName;
	minServerMajorVersion: number;
	now: string;
	/** Override for tests that prove drift and schema-ahead refusals. */
	migrations?: readonly Migration[];
}>;

/** Major version from `server_version_num` (e.g. 160015 → 16). */
export function serverMajorVersion(serverVersionNum: number): number {
	return Math.floor(serverVersionNum / 10_000);
}

/**
 * Bring one schema to the newest migration this build ships.
 *
 * Runs in one transaction under a transaction-scoped advisory lock keyed by
 * the schema, so concurrent starters (several `hobo serve cd` replicas)
 * migrate exactly once and the others see the finished result. DDL is
 * transactional in PostgreSQL: a failure leaves the schema as it was.
 *
 * Refuses (fail closed) when the server is older than the minimum, when an
 * applied migration's checksum differs from the shipped one, or when the
 * schema is newer than this build.
 */
export async function migrateSchema(
	client: PgClientLike,
	options: MigrateOptions,
): Promise<MigrationReport> {
	const migrations = options.migrations ?? MIGRATIONS;
	const version = await client.query(
		"SELECT current_setting('server_version_num')::integer AS num",
	);
	const row = version.rows[0];
	if (row === undefined) {
		throw new StoragePostgresError("unavailable", "server version unreadable");
	}
	const major = serverMajorVersion(int4(row, "num"));
	if (major < options.minServerMajorVersion) {
		throw new StoragePostgresError(
			"server-too-old",
			`PostgreSQL ${major} is older than the required ${options.minServerMajorVersion}`,
		);
	}

	const s = quoteSchema(options.schema);
	await client.query("BEGIN");
	try {
		await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
			migrationLockKey(options.schema),
		]);
		await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
		await client.query(
			`CREATE TABLE IF NOT EXISTS ${s}.schema_migrations (
         version     integer PRIMARY KEY CHECK (version > 0),
         name        text NOT NULL,
         checksum    text NOT NULL,
         applied_at  text NOT NULL
       )`,
		);
		const existing = await client.query(
			`SELECT version, name, checksum FROM ${s}.schema_migrations ORDER BY version`,
		);
		const known = new Map(migrations.map((m) => [m.version, m]));
		let fromVersion = 0;
		for (const applied of existing.rows) {
			const appliedVersion = int4(applied, "version");
			fromVersion = Math.max(fromVersion, appliedVersion);
			const shipped = known.get(appliedVersion);
			if (shipped === undefined) {
				throw new StoragePostgresError(
					"schema-ahead",
					`schema ${options.schema} has migration ${appliedVersion} (${text(applied, "name")}); this build ships up to ${migrations.length}`,
				);
			}
			if (text(applied, "checksum") !== migrationChecksum(shipped)) {
				throw new StoragePostgresError(
					"migration-drift",
					`migration ${appliedVersion} (${shipped.name}) in schema ${options.schema} does not match this build's checksum`,
				);
			}
		}
		const applied: MigrationReport["applied"][number][] = [];
		for (const migration of migrations) {
			if (migration.version <= fromVersion) continue;
			await client.query(migration.sql(s));
			const checksum = migrationChecksum(migration);
			await client.query(
				`INSERT INTO ${s}.schema_migrations (version, name, checksum, applied_at)
         VALUES ($1, $2, $3, $4)`,
				[migration.version, migration.name, checksum, options.now],
			);
			applied.push(
				Object.freeze({
					version: migration.version,
					name: migration.name,
					checksum,
					appliedAt: options.now,
				}),
			);
		}
		await client.query("COMMIT");
		return Object.freeze({
			serverMajorVersion: major,
			fromVersion,
			toVersion: Math.max(fromVersion, migrations.length),
			applied: Object.freeze(applied),
		});
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	}
}
