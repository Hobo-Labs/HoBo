import { createHash } from "node:crypto";
import * as m0001 from "./0001_initial.js";
import * as m0002 from "./0002_actor_fences.js";

export type Migration = Readonly<{
	version: number;
	name: string;
	sql: (s: string) => string;
}>;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
	Object.freeze({ version: 1, name: m0001.name, sql: m0001.sql }),
	Object.freeze({ version: 2, name: m0002.name, sql: m0002.sql }),
]);

export const SCHEMA_VERSION: number = MIGRATIONS.length;

export function migrationChecksum(migration: Migration): string {
	return createHash("sha256")
		.update(`${migration.version}:${migration.name}\n`)
		.update(migration.sql('"__schema__"'))
		.digest("hex");
}
