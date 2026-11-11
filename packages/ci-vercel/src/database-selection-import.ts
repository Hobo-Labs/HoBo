/**
 * Carrying the relay's data from the store it left into the store it chose,
 * once.
 *
 * The case: the old store went over its quota, the relay started empty on a
 * new one, and a month later the old store answers again. If the new store
 * still holds no GitHub App registration and no account, the old store's
 * tables are copied into it, so the registration comes across instead of
 * being made again.
 *
 * The copy is the fleet's (`copySnapshot` in `@hobo/data-postgres`): one
 * consistent snapshot of the source, the target replaced in one transaction,
 * the same table set (`RELAY_FLEET_LAYOUT`), and the same refusal of
 * catalogs that differ and of a source over the size limits. What differs is
 * the rule for who may be overwritten. The fleet asks the target's
 * assignment log; two stores that were never a fleet have none, so the rule
 * here is "the target is pristine", checked inside the target's transaction
 * with the tables that decide it locked against writers.
 *
 * It is a one-time import, not replication: it never runs twice into one
 * store, never into a store that is in use, and never merges.
 */
import {
	copySnapshot,
	type ReplicationLimits,
	type ReplicationRefusal,
	ReplicationRefused,
	type SqlSession,
} from "@hobo/data-postgres";
import pg from "pg";
import type { RelayDatabase } from "./database-connections.js";
import { RELAY_FLEET_LAYOUT } from "./database-fleet-config.js";
import { pgExecutor } from "./database-fleet-executor.js";
import {
	readStoreMarker,
	STORE_SELECTION_LOCK,
} from "./database-selection-marker.js";
import {
	prepareRelaySchema,
	RelaySchemaError,
	type RelaySchemaRole,
} from "./relay-schema.js";

/**
 * What makes a store not pristine, one query per table. A store is
 * **pristine** when none of these finds a row:
 *
 * - `hobo_ci_platform_app`: a platform App that is registered (`ready`) or
 *   whose conversion at GitHub has begun (`converting`). A `pending` row is a
 *   claim that created nothing yet.
 * - `hobo_ci_app_credentials`: any stored App credential.
 * - `hobo_ci_app_installations`: any installation bound to an account.
 * - `hobo_ci_configuration`: a stored configuration that lists an account.
 *
 * A table that does not exist yet holds nothing.
 */
const REGISTRATION_EVIDENCE = [
	{
		table: "hobo_ci_platform_app",
		holds: "SELECT 1 FROM hobo_ci_platform_app WHERE status <> 'pending'",
	},
	{
		table: "hobo_ci_app_credentials",
		holds: "SELECT 1 FROM hobo_ci_app_credentials",
	},
	{
		table: "hobo_ci_app_installations",
		holds: "SELECT 1 FROM hobo_ci_app_installations",
	},
	{
		table: "hobo_ci_configuration",
		holds: `SELECT 1 FROM hobo_ci_configuration
			WHERE body::jsonb #> '{configuration,accounts}' IS NOT NULL
				AND body::jsonb #> '{configuration,accounts}' <> '[]'::jsonb`,
	},
];

/** Whether a store holds a GitHub App registration or an account: the
 * opposite of pristine. Reads only; creates nothing. */
export async function storeHoldsRegistration(
	session: SqlSession,
): Promise<boolean> {
	const present = (
		await session.query(
			`SELECT ${REGISTRATION_EVIDENCE.map(
				(entry, index) =>
					`(to_regclass('${entry.table}') IS NOT NULL)::text AS t${index}`,
			).join(", ")}`,
		)
	).rows[0];
	const checks = REGISTRATION_EVIDENCE.filter(
		(_, index) => present?.[`t${index}`] === "true",
	);
	if (checks.length === 0) return false;
	const held = await session.query(
		checks
			.map((entry) => `SELECT EXISTS (${entry.holds})::text AS held`)
			.join("\nUNION ALL\n"),
	);
	return held.rows.some((row) => row.held === "true");
}

/**
 * The most the import will copy. Lower than the fleet's limits because this
 * runs while a function instance is starting, not on a schedule: a source
 * over the limit is refused as `oversized` and has to be restored by hand.
 */
export const STORE_IMPORT_LIMITS = {
	maxRows: 500_000,
	maxBytes: 128 * 1024 * 1024,
} satisfies Partial<ReplicationLimits>;

/** Why an import did not happen. `ReplicationRefusal` is the copy's own. */
export type ImportRefusal =
	| "already-imported"
	| "not-pristine"
	| "not-selected"
	/** A store records migrations this release does not have. */
	| "schema-ahead"
	/** A store's tables could not be brought to this release's schema. */
	| "schema-refused"
	| ReplicationRefusal;

export type ImportOutcome =
	| { status: "imported"; tables: number; rows: number; bytes: number }
	| {
			status: "refused";
			refusal: ImportRefusal;
			/** Names a table or column; never data and never a connection. */
			detail: string;
	  };

/** The answer for a store that already holds a registration or an account. */
export const NOT_PRISTINE = {
	status: "refused",
	refusal: "not-pristine",
	detail: "the store already holds a registration or an account",
} satisfies ImportOutcome;

class ImportRefused extends Error {
	constructor(
		readonly refusal: "already-imported" | "not-pristine" | "not-selected",
		readonly detail: string,
	) {
		super(refusal);
	}
}

/** Bring both sides to this release's schema, target first. A schema the
 * runner refuses is an answer, not a failure: nothing was changed. */
async function prepareSides(
	source: pg.Pool,
	target: pg.Pool,
): Promise<ImportOutcome | undefined> {
	for (const [pool, side, role] of [
		[target, "target", "writer"],
		[source, "source", "standby"],
	] satisfies [pg.Pool, string, RelaySchemaRole][]) {
		try {
			await prepareRelaySchema(pool, side, role);
		} catch (error) {
			if (!(error instanceof RelaySchemaError)) throw error;
			return {
				status: "refused",
				refusal: error.failure === "ahead" ? "schema-ahead" : "schema-refused",
				detail:
					error.failure === "ahead"
						? `the ${side} records ${error.scope} migrations this release does not have: ${error.migrations.join(", ")}`
						: `a ${error.scope} migration was refused on the ${side} and rolled back`,
			};
		}
	}
	return undefined;
}

/** One side of an import: the store's digest, as selection logs it, and the
 * settings of its session-scoped connection. */
export type ImportSide = {
	database: string;
	settings: RelayDatabase["direct"];
};

/**
 * Copy the relay's tables from `source` into `target`, if `target` is the
 * selected store, is pristine and was never imported into.
 *
 * Both stores are first brought to this release's schema, each the way its
 * role calls for (`prepareRelaySchema`, the fleet's seam):
 *
 * - **The target** is the store the relay runs on, so it gets what a writer
 *   gets: the stores' own initialisers, then the checked-in migrations.
 * - **The source** only has to be read. It gets what a fleet standby gets:
 *   the checked-in migrations and nothing else. Those are guarded DDL plus
 *   the migration ledger, which is never copied, so a table the old store
 *   never needed is created empty and no row of its own is changed. The
 *   stores' initialisers are not run there: they move rows (the inbox hash
 *   backfill, the snapshot import), and a store the relay has left is not
 *   one it writes to. A source at an older table layout is therefore
 *   refused (`schema-refused`) rather than rewritten, and one that records
 *   migrations this release does not have (`schema-ahead`) is left alone.
 *
 * Then, in one transaction on the target:
 *
 * 1. the selection lock, without waiting (`busy` if another import or a
 *    promotion holds it);
 * 2. the marker row must exist (`not-selected`) and must not record an
 *    import (`already-imported`);
 * 3. the tables that decide "pristine" are locked against writers and
 *    checked (`not-pristine`), so a registration cannot arrive between the
 *    check and the copy;
 * 4. the copy, with its own refusals (`schema-mismatch`, `oversized`,
 *    `digest-mismatch`);
 * 5. the marker row records the source's digest and the time.
 *
 * A refusal is returned. A failed connection or statement is thrown. Either
 * way the target is left exactly as it was.
 */
export async function importRelayData(request: {
	source: ImportSide;
	target: ImportSide;
	limits?: Partial<ReplicationLimits> | undefined;
}): Promise<ImportOutcome> {
	const open = (side: ImportSide) => {
		const pool = new pg.Pool({
			...side.settings,
			max: 2,
			connectionTimeoutMillis: 5000,
			idleTimeoutMillis: 1000,
		});
		pool.on("error", () => {});
		return pool;
	};
	const source = open(request.source);
	const target = open(request.target);
	try {
		const refusal = await prepareSides(source, target);
		if (refusal) return refusal;
		return await copySnapshot<ImportOutcome>({
			source: pgExecutor(source),
			target: pgExecutor(target),
			layout: RELAY_FLEET_LAYOUT,
			limits: { ...STORE_IMPORT_LIMITS, ...request.limits },
			admit: async (to) => {
				const lock = await to.query(
					"SELECT pg_try_advisory_xact_lock(hashtext($1))::text AS locked",
					[STORE_SELECTION_LOCK],
				);
				if (lock.rows[0]?.locked !== "true")
					throw new ReplicationRefused(
						"busy",
						"another import into this store is running",
					);
				const marker = await readStoreMarker(to);
				if (marker.generation === 0)
					throw new ImportRefused(
						"not-selected",
						"the store holds no selection marker",
					);
				if (marker.imported)
					throw new ImportRefused(
						"already-imported",
						"an import into this store is already recorded",
					);
				// Writers wait; a writer that holds one of these for longer than
				// this fails the import, which the next start-up tries again.
				await to.query("SET LOCAL lock_timeout = '5s'");
				await to.query(
					`LOCK TABLE ${REGISTRATION_EVIDENCE.map((entry) => entry.table).join(", ")} IN SHARE ROW EXCLUSIVE MODE`,
				);
				if (await storeHoldsRegistration(to))
					throw new ImportRefused("not-pristine", NOT_PRISTINE.detail);
			},
			record: async (to, copy) => {
				const recorded = await to.query(
					`UPDATE hobo_ci_store_selection SET imported_from = $1::text, imported_at = clock_timestamp()
					WHERE generation = (SELECT max(generation) FROM hobo_ci_store_selection)
					RETURNING generation::text AS generation`,
					[request.source.database],
				);
				if (recorded.rows.length !== 1)
					throw new Error("store selection marker missing");
				return {
					status: "imported",
					tables: copy.tables.length,
					rows: copy.rowCount,
					bytes: copy.byteCount,
				};
			},
		});
	} catch (error) {
		if (error instanceof ImportRefused || error instanceof ReplicationRefused)
			return {
				status: "refused",
				refusal: error.refusal,
				detail: error.detail,
			};
		throw error;
	} finally {
		await Promise.all([
			source.end().catch(() => {}),
			target.end().catch(() => {}),
		]);
	}
}
