import { createHash } from "node:crypto";
import * as m0001 from "./0001_initial.js";

export type Migration = Readonly<{
	version: number;
	name: string;
	/** SQL for one schema; `s` is the already-quoted schema identifier. */
	sql: (s: string) => string;
}>;

/** Ordered, append-only migration list. Never edit an entry once released. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
	Object.freeze({ version: 1, name: m0001.name, sql: m0001.sql }),
]);

/** Highest schema version this build knows. */
export const SCHEMA_VERSION: number = MIGRATIONS.length;

/**
 * Checksum of a migration, independent of the schema it is applied to, so a
 * store in `hobo_eventstore` and one in a test schema record the same value.
 */
export function migrationChecksum(migration: Migration): string {
	return createHash("sha256")
		.update(`${migration.version}:${migration.name}\n`)
		.update(migration.sql('"__schema__"'))
		.digest("hex");
}
