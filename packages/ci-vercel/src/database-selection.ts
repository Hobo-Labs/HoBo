/**
 * Choosing the relay's store when more than one database is attached.
 *
 * A Vercel project can have a second PostgreSQL store connected while the
 * first is still there, which is exactly the state an operator is in when the
 * first one has stopped answering. Nothing is configured by hand in that
 * state, so the relay chooses, and it must choose the same store on every
 * function instance and stay on it.
 *
 * - Each candidate is probed once, on its session-scoped connection, and is
 *   `serving`, `refusing` or `unknown`.
 * - Any `unknown` and the relay does not choose at all. Two instances that
 *   see different subsets of the candidates must never pick different stores,
 *   and a store that merely did not answer in time may be the one in use.
 * - Among the serving stores the one holding the highest **generation** is
 *   the active one; equal generations go to discovery order. A generation is
 *   a row in `hobo_ci_store_selection` on the store itself.
 *
 * This file is the rule, as pure functions. `database-selection-marker.ts`
 * holds the generation, `database-selection-import.ts` carries data over once,
 * and `database-selection-relay.ts` probes the stores and runs the relay on
 * the chosen one.
 *
 * This is not consensus and not replication. `database-fleet.ts` is the
 * mechanism for several stores that are all meant to be in use.
 */
import { sqlState } from "@hobo/data-postgres";

/**
 * The answers a store gives that will not change by asking again. A store
 * that answers with one of these is `refusing`: the server itself was reached
 * and said no. Everything else that goes wrong (a timeout, a failed name
 * lookup, a TLS failure, a reset connection, `57P03` "starting up", `53300`
 * "too many connections", any other `53xxx`) is `unknown`, because it may
 * clear by itself and says nothing about which store is in use.
 */
export const STORE_REFUSAL_SQLSTATES = {
	/** `53000`: what Neon answers on every connection once the project is over
	 * its plan quota. `3D000`: the database the connection names is gone. */
	codes: ["53000", "3D000"],
	/** By two-character class. `28`: invalid authorization, which is a wrong
	 * or revoked credential (`28000`, `28P01`). */
	classes: ["28"],
} satisfies { codes: readonly string[]; classes: readonly string[] };

/** Why a probe did not find a serving store. */
export type StoreFailure =
	| { class: "refusing"; sqlstate: string }
	/** `code` is the driver's or server's fixed error token, when it has one. */
	| { class: "unknown"; code: string | undefined };

/** What one probe learned. A generation of 0 is "no marker". */
export type StoreObservation =
	| { class: "serving"; generation: number }
	| StoreFailure;

/** Classify a failed connection or statement. Only codes leave this function:
 * a driver's message can carry a host name, so it is never read. */
export function classifyStoreFailure(error: Error | undefined): StoreFailure {
	const state = sqlState(error);
	if (
		state !== undefined &&
		(STORE_REFUSAL_SQLSTATES.codes.includes(state) ||
			STORE_REFUSAL_SQLSTATES.classes.some((prefix) =>
				state.startsWith(prefix),
			))
	)
		return { class: "refusing", sqlstate: state };
	const code = error !== undefined && "code" in error ? String(error.code) : "";
	return {
		class: "unknown",
		code: /^[A-Z0-9_]{1,40}$/u.test(code) ? code : undefined,
	};
}

// public-contract: the reasons logged in hobo_ci_database_selected and stored in the marker row.
export const SELECTION_REASONS = [
	"only-candidate",
	"marker",
	"first-run",
	"previous-refusing",
] as const;
export type SelectionReason = (typeof SELECTION_REASONS)[number];

export type StoreChoice =
	| {
			status: "chosen";
			/** Position in the candidate list. */
			index: number;
			reason: SelectionReason;
			/** The generation the chosen store holds now; 0 for none. */
			held: number;
			/** Whether a new generation must be written on it. */
			promote: boolean;
			/** The lowest generation a promotion may write. */
			atLeast: number;
	  }
	| {
			status: "undecided";
			cause: "unclassified-candidate" | "no-serving-candidate";
	  };

type Holder = { index: number; generation: number };

/**
 * The store to run on, from what the probes learned. Pure: the same
 * observations give the same answer on every instance.
 *
 * - Any `unknown` candidate: undecided. An unreachable store may hold the
 *   highest generation, and two instances that reach different subsets must
 *   never pick different stores.
 * - Otherwise the serving candidate with the highest generation, the earliest
 *   in discovery order when generations are equal (which includes "no marker
 *   anywhere", the first run).
 * - A new generation is written when the chosen store holds none, and also
 *   whenever another candidate is refusing: a refusing store cannot be read,
 *   so it may hold any generation, and the store being used instead has to
 *   outrank it when it comes back.
 */
export function chooseStore(
	observations: readonly StoreObservation[],
): StoreChoice {
	if (observations.some((entry) => entry.class === "unknown"))
		return { status: "undecided", cause: "unclassified-candidate" };
	let chosen: Holder | undefined;
	for (const [index, entry] of observations.entries())
		if (
			entry.class === "serving" &&
			(chosen === undefined || entry.generation > chosen.generation)
		)
			chosen = { index, generation: entry.generation };
	if (chosen === undefined)
		return { status: "undecided", cause: "no-serving-candidate" };
	const refusing = observations.some((entry) => entry.class === "refusing");
	const reason: SelectionReason =
		observations.length === 1
			? "only-candidate"
			: refusing
				? "previous-refusing"
				: chosen.generation > 0
					? "marker"
					: "first-run";
	return {
		status: "chosen",
		index: chosen.index,
		reason,
		held: chosen.generation,
		promote: chosen.generation === 0 || refusing,
		atLeast: chosen.generation + 1,
	};
}
