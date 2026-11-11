/**
 * The migration runner, as the tooling uses it.
 *
 * The runner itself lives in `src/schema-migrations.ts`, because a host also
 * calls it at run time (to prepare a database fleet's standbys) and nothing
 * under `src/` may import from `db/`. There is one runner either way.
 */

export {
	type AppliedMigrations,
	applyMigrations,
	readSchemaLedger,
	SCHEMA_LEDGER_TABLE,
	SchemaAheadError,
	type SchemaLedgerState,
} from "../../src/schema-migrations.js";
