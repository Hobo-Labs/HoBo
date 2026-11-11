/**
 * The generation a store holds: one row in `hobo_ci_store_selection`, on the
 * store itself. The store with the highest generation is the one the relay
 * runs on (see `database-selection.ts`).
 *
 * The table is not copied between stores: what one store says about itself
 * says nothing about another. `RELAY_FLEET_LAYOUT` excludes it for that
 * reason, which keeps it out of the one-time import and out of the fleet.
 */
import {
	inTransaction,
	type SqlExecutor,
	type SqlSession,
} from "@hobo/data-postgres";
import type { SelectionReason } from "./database-selection.js";

// public-contract: the advisory lock the marker table is created and written under; listed in db/source.ts.
export const STORE_SELECTION_LOCK = "hobo-ci-store-selection-v1";

/** At most one row: the store's current generation, when and why it was
 * written, and whether the one-time import into this store has happened. */
// public-contract: the marker table's DDL, declared in db/schema.ts and held to it by db:verify.
export const STORE_SELECTION_TABLE = `CREATE TABLE IF NOT EXISTS hobo_ci_store_selection (
			generation bigint PRIMARY KEY, selected_at timestamptz NOT NULL, reason text NOT NULL,
			imported_from text, imported_at timestamptz
		)`;

const NEWEST_MARKER = `SELECT generation::text AS generation, (imported_at IS NOT NULL)::text AS imported
	FROM hobo_ci_store_selection ORDER BY generation DESC LIMIT 1`;

/** What a store says about itself. A generation of 0 is "no marker". */
export type StoreMarker = { generation: number; imported: boolean };

const NO_MARKER: StoreMarker = { generation: 0, imported: false };

function parseGeneration(value: string | null | undefined): number {
	const parsed = /^\d{1,15}$/u.test(value ?? "") ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 1)
		throw new Error("store selection marker is not a generation");
	return parsed;
}

async function newestMarker(session: SqlSession): Promise<StoreMarker> {
	const row = (await session.query(NEWEST_MARKER)).rows[0];
	return row === undefined
		? NO_MARKER
		: {
				generation: parseGeneration(row.generation),
				imported: row.imported === "true",
			};
}

async function lockSelection(session: SqlSession): Promise<void> {
	await session.query(
		"SELECT pg_advisory_xact_lock(hashtext($1))::text AS locked",
		[STORE_SELECTION_LOCK],
	);
}

/** Create the marker table. Idempotent, and serialised with every other
 * writer of the table by the selection lock. */
export async function ensureStoreSelectionTable(
	executor: SqlExecutor,
): Promise<void> {
	await inTransaction(executor, "BEGIN", async (session) => {
		await lockSelection(session);
		await session.query(STORE_SELECTION_TABLE);
	});
}

/** Read a store's marker without creating anything on it: a store that is
 * only looked at is left exactly as it was. */
export async function readStoreMarker(
	session: SqlSession,
): Promise<StoreMarker> {
	const present = await session.query(
		"SELECT (to_regclass('hobo_ci_store_selection') IS NOT NULL)::text AS present",
	);
	return present.rows[0]?.present === "true"
		? newestMarker(session)
		: NO_MARKER;
}

export type StorePromotion = {
	/** The generation this instance saw on the store; 0 for none. */
	held: number;
	/** The lowest generation that may be written. */
	atLeast: number;
	reason: SelectionReason;
};

/**
 * Write a new generation on the chosen store and return the generation it
 * holds afterwards.
 *
 * The generation is the larger of `atLeast` and the store's own clock in
 * milliseconds since 1970. The clock is what lets a store promoted while another
 * could not be read outrank whatever that other store holds: the other
 * store's marker was written earlier. `atLeast` keeps the number rising even
 * where a clock does not.
 *
 * The store is read again under the lock. If it already holds more than this
 * instance saw, another instance promoted it in the meantime and that row is
 * the answer; nothing is written, so two instances promoting at once leave
 * one row. The one-time import's record moves to the new row.
 */
export async function promoteStore(
	executor: SqlExecutor,
	promotion: StorePromotion,
): Promise<number> {
	return inTransaction(executor, "BEGIN", async (session) => {
		await lockSelection(session);
		await session.query(STORE_SELECTION_TABLE);
		const current = await newestMarker(session);
		if (current.generation > promotion.held) return current.generation;
		const written = await session.query(
			`INSERT INTO hobo_ci_store_selection (generation, selected_at, reason, imported_from, imported_at)
			SELECT GREATEST($1::bigint, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint),
				clock_timestamp(), $2::text,
				(SELECT imported_from FROM hobo_ci_store_selection ORDER BY generation DESC LIMIT 1),
				(SELECT imported_at FROM hobo_ci_store_selection ORDER BY generation DESC LIMIT 1)
			RETURNING generation::text AS generation`,
			[promotion.atLeast, promotion.reason],
		);
		const generation = parseGeneration(written.rows[0]?.generation);
		// One row per store: an older generation says nothing the newest does not.
		await session.query(
			"DELETE FROM hobo_ci_store_selection WHERE generation < $1::bigint",
			[generation],
		);
		return generation;
	});
}
