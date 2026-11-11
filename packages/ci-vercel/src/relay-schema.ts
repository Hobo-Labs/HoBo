import { PostgresCiStore } from "@hobo/ci/postgres";
import {
	applyMigrations,
	ciSchemaMigrations,
	readSchemaLedger,
	SchemaAheadError,
	SchemaMigrationError,
	type SchemaMigrationSet,
} from "@hobo/ci/schema-migrations";
import {
	hostedRelaySchemaMigrations,
	initializeHostedRelaySchema,
} from "@hobo/ci-gh-actions";
import type pg from "pg";
import { schemaMigrations as vercelSchemaMigrations } from "./_generated-assets/schema-migrations.js";
import { DATABASE_PROBE_TABLE } from "./database-connections.js";
import { PostgresWorkerHealth } from "./worker-health.js";

/**
 * The relay's whole schema: the checked-in migrations of the three packages
 * that own its tables, in the order they are applied. Each set is the copy
 * its package ships of its own `db/migrations/`, held to it by `db:check`, so
 * this is the same SQL `pnpm run db:migrate` applies and the same schema the
 * stores' embedded DDL is proven to build. There is no other list.
 */
export const RELAY_SCHEMA_MIGRATIONS: readonly SchemaMigrationSet[] = [
	ciSchemaMigrations,
	hostedRelaySchemaMigrations,
	vercelSchemaMigrations,
];

/** Which side of the fleet a backend is while its schema is prepared. */
export type RelaySchemaRole = "writer" | "standby";

export type RelaySchemaFailure =
	/** The backend records a migration this release does not have. */
	| "ahead"
	/** A migration was refused or did not converge; nothing was recorded. */
	| "refused";

/**
 * A backend's schema could not be prepared. The message names the backend by
 * its fleet id and the migrations by their ids, and nothing else: no host, no
 * connection string and no text from the server.
 */
export class RelaySchemaError extends Error {
	constructor(
		readonly backend: string,
		readonly failure: RelaySchemaFailure,
		readonly scope: string,
		/** For `ahead`: the recorded migrations this release does not know. */
		readonly migrations: readonly string[],
		cause: Error,
	) {
		super(
			failure === "ahead"
				? `fleet backend ${backend} is on a schema this relay does not know: ${scope} records ${migrations.join(", ")}, which this release does not have. A newer relay prepared it; nothing was changed. Deploy that release here, or remove the backend from the fleet.`
				: `fleet backend ${backend} could not be brought to this relay's schema: a ${scope} migration was refused and rolled back; nothing was recorded.`,
			{ cause },
		);
		this.name = "RelaySchemaError";
	}
}

export type RelaySchemaReport = {
	readonly backend: string;
	/** Migrations this call applied, as `scope/id`; empty when all were recorded. */
	readonly applied: readonly string[];
};

/** A migration id as the journal writes one; anything else is not repeated. */
const MIGRATION_ID = /^\d{4}_[a-z0-9_]{1,80}$/u;

function ahead(backend: string, error: SchemaAheadError): RelaySchemaError {
	return new RelaySchemaError(
		backend,
		"ahead",
		error.scope,
		// The ids come from the backend's own ledger: only ones shaped like a
		// migration id are named.
		error.unknown.map((id) => (MIGRATION_ID.test(id) ? id : "(unreadable)")),
		error,
	);
}

/**
 * Bring one fleet backend to this release's schema.
 *
 * - **A standby** gets the checked-in migrations and nothing else. The relay's
 *   stores are never opened on it: the application does not write to a
 *   standby, and the runner's only writes are DDL and its own ledger
 *   (`hobo_ci_schema_migrations`, which the fleet does not copy). A fresh
 *   standby gets every table; one behind gets what it lacks.
 * - **The writer** is first brought forward the way the application itself
 *   starts on it, by the stores' own initialisers, which is the only thing
 *   that moves a table from an earlier release's layout. Then the same
 *   migrations are applied and recorded, so its ledger says what it holds.
 *
 * It is safe to repeat and to race: each migration set runs in one
 * transaction under the migration lock and the locks the stores' own
 * initialisation takes, so of several callers one applies and the others find
 * it recorded. A backend whose ledger holds a migration this release does not
 * have is refused before any statement runs and is left exactly as it is.
 *
 * A failure of the connection or the server passes through as it is, for the
 * fleet to classify; it is never put into a message here.
 */
export async function prepareRelaySchema(
	pool: pg.Pool,
	backend: string,
	role: RelaySchemaRole,
	sets: readonly SchemaMigrationSet[] = RELAY_SCHEMA_MIGRATIONS,
): Promise<RelaySchemaReport> {
	// Asked first, so a backend ahead of this release is refused before the
	// writer's initialisers run on it either.
	const ledger = await readSchemaLedger(pool, sets);
	if (ledger.status === "ahead")
		throw ahead(backend, new SchemaAheadError(ledger.scope, ledger.unknown));
	if (role === "writer") {
		await new PostgresCiStore(pool).initialize();
		await initializeHostedRelaySchema(pool);
		await new PostgresWorkerHealth(pool).initialize();
		await pool.query(DATABASE_PROBE_TABLE);
	}
	const applied: string[] = [];
	for (const set of sets) {
		try {
			const result = await applyMigrations(pool, set);
			applied.push(...result.applied.map((id) => `${set.scope}/${id}`));
		} catch (error) {
			if (error instanceof SchemaAheadError) throw ahead(backend, error);
			if (error instanceof SchemaMigrationError)
				throw new RelaySchemaError(backend, "refused", set.scope, [], error);
			throw error;
		}
	}
	return { backend, applied };
}

/**
 * Whether a backend already holds every migration of this release, from its
 * ledger alone: one read, no lock and no change. `ahead` is reported, not
 * thrown, so a caller can decide what an unknown schema means for it.
 */
export async function relaySchemaState(
	pool: Pick<pg.Pool, "query">,
	sets: readonly SchemaMigrationSet[] = RELAY_SCHEMA_MIGRATIONS,
): Promise<"current" | "behind" | "ahead"> {
	return (await readSchemaLedger(pool, sets)).status;
}
