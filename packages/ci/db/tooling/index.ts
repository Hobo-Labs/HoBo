/**
 * Schema tooling for the CI relay's PostgreSQL tables.
 *
 * Shared by `@hobo/ci`, `@hobo/ci-gh-actions` and `@hobo/ci-vercel`, each of
 * which owns a `db/schema.ts` (the Drizzle definition of its tables), a
 * `db/source.ts` (how to find that schema and how to run the embedded DDL it
 * mirrors) and a `db/migrations/` directory (what this tooling writes).
 *
 * Development and operations only. Nothing here is imported by the packages'
 * `src/`, and drizzle-orm and drizzle-kit are dev dependencies: the relay's
 * request path keeps its hand-written SQL through `pg` (ADR-0160).
 *
 * Two things cross into `src/`, in that direction only. The runner
 * (`applyMigrations`) lives in `@hobo/ci`'s `src/schema-migrations.ts` and is
 * re-exported here. And each package ships its checked-in migrations as
 * `src/_generated-assets/schema-migrations.ts`, which this tooling writes and
 * `db:check` holds to `db/migrations/`: a host that prepares a database at run
 * time applies exactly the SQL that was reviewed.
 */

import type { Pool } from "pg";
import type { EmbeddedDdlSource } from "./embedded-ddl.js";
import type { SchemaSource } from "./generate.js";
import type { ShippedMigrationsSource } from "./ship.js";

export {
	type AppliedMigrations,
	applyMigrations,
	readSchemaLedger,
	SCHEMA_LEDGER_TABLE,
	SchemaAheadError,
	type SchemaLedgerState,
} from "./apply.js";
export {
	type CatalogFact,
	compareCatalogs,
	readCatalog,
} from "./catalog.js";
export {
	checkEmbeddedDdlLock,
	type EmbeddedDdlSource,
	embeddedTableNames,
	readEmbeddedDdl,
	renderEmbeddedDdlLock,
} from "./embedded-ddl.js";
export {
	checkMigrations,
	type DrizzleSchemaModule,
	drizzleKitVersion,
	type GeneratedMigration,
	generateNextMigration,
	planMigration,
	type SchemaSource,
} from "./generate.js";
export {
	loadMigrationSet,
	type MigrationSet,
	readJournal,
	readSnapshot,
	type SchemaJournal,
	SchemaMigrationError,
} from "./journal.js";
export {
	type EquivalenceProof,
	proveEquivalence,
	type ScratchDatabase,
	schemaFacts,
	withScratchDatabases,
} from "./proof.js";
export {
	checkShippedMigrations,
	renderShippedMigrations,
	type ShippedMigrationsSource,
} from "./ship.js";

/** Everything the tooling needs to know about one package's tables. */
export interface RelaySchemaSource
	extends SchemaSource,
		EmbeddedDdlSource,
		ShippedMigrationsSource {
	/** Runs the package's embedded DDL exactly as production does today. */
	readonly initializeEmbedded: (pool: Pool) => Promise<void>;
}
