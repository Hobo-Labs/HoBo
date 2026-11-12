/**
 * An assignment replica kept in one key of an `EphemeralStatePort`.
 *
 * The whole log of one backend is one value: a `FleetAssignmentLog` (protobuf
 * JSON, `data-models/backend_fleet.proto`) holding the newest entries in
 * ascending order. `accept` reads the key, checks the register's rules on
 * what it read, and writes the longer log back conditionally:
 *
 * - **One entry per epoch.** An epoch the log holds answers `duplicate` (the
 *   same entry) or `conflict` (another one). An epoch below the oldest entry
 *   kept answers `conflict`: the log held one, and which is no longer known.
 * - **Only `top + 1`.** Any other epoch answers `gap`. An empty log takes
 *   epoch 1 only.
 * - **Atomic per backend.** The write is `putIfAbsent` for an empty log and
 *   `compareAndSet` on the version read otherwise, so two writers racing on
 *   one backend cannot both extend the same log: the loser re-reads and
 *   re-checks. A replica that keeps losing races answers `busy`.
 *
 * Every write sets the key's TTL to the port's 30-day cap, and `refresh`
 * resets it without writing (the repair tick calls it on every member).
 *
 * **When a log is lost.** A cache may lose the key: it expires, the store is
 * flushed, or the store evicts it. A lost log reads as empty, so the backend
 * simply stops counting as a holder of anything. Safety needs one thing from
 * that: every decided entry stays held by a majority of the members. The
 * repair tick copies the current entry onto every member that answers (see
 * `completeAssignment`), so once it has run, a decided entry is held by all of
 * them, and losing the log of any minority leaves a majority holding it. Under
 * that precondition the register still never resolves two entries for one
 * epoch and never goes back to an older epoch: a reader that sees the
 * emptied member also sees a majority holding the current entry, and a
 * proposal still needs that majority. What it does not survive is losing a
 * log that was part of a *bare* majority before repair copied the entry
 * further, while another holder is silent: then nobody can prove the entry
 * was decided. `test/ephemeral-replica.test.ts` checks both.
 *
 * An emptied member is brought back by `rejoinAssignmentReplicas`: it is
 * seeded with the current entry only when a majority of all members *other
 * than itself* hold that entry as their newest, which proves it decided and
 * proves no newer entry is decided (a newer one would be held by a majority,
 * which would intersect those holders). Ordinary repair cannot do this once
 * the oldest epochs have been trimmed from every log.
 */
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	EPHEMERAL_STATE_MAX_TTL_MS,
	type EphemeralKey,
	type EphemeralStatePort,
	type EphemeralTtlMs,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "@hobo/core";
import {
	FleetAssignmentLogSchema,
	FleetAssignmentSchema,
} from "./_generated/backend_fleet_pb.js";
import {
	type AssignmentAcceptOutcome,
	type AssignmentRegister,
	type AssignmentReplica,
	type AssignmentReply,
	assignmentKey,
	type FleetAssignment,
	parseAssignmentRegister,
	parseFleetAssignment,
	readAssignmentReplies,
	resolveAssignment,
} from "./assignment.js";
import { parseFleetBackendId } from "./backend.js";
import { BackendFleetError } from "./errors.js";

/** Entries kept per log. Older ones are dropped; the register needs only the newest. */
export const ASSIGNMENT_LOG_MAX_ENTRIES = 32;
/** The key a log is kept under when the host names none. */
// public-contract: the stored key every replica of an unnamed register shares.
export const DEFAULT_ASSIGNMENT_LOG_KEY = "hobo:fleet:assignment";
const LOG_FORMAT = 1;
const RACE_RETRIES = 4;

/** An `AssignmentReplica` on a cache, with the two extra moves a cache needs. */
export type EphemeralAssignmentReplica = AssignmentReplica & {
	readonly key: EphemeralKey;
	/** Reset the log's TTL. False when the log is absent (never written, or lost). */
	refresh(): Promise<boolean>;
	/**
	 * Start an empty log at `entry`. Only `rejoinAssignmentReplicas` calls it,
	 * after proving `entry` current without this replica's vote.
	 */
	seed(entry: FleetAssignment): Promise<"seeded" | "not-empty">;
};

export type EphemeralAssignmentReplicaOptions = {
	/** The key the log lives under; namespace it per deployment environment. */
	readonly key?: string;
	/** TTL set on every write and refresh. Default and maximum: 30 days. */
	readonly ttlMs?: number;
	/** Entries kept. Default 32. */
	readonly maxEntries?: number;
};

function toWire(entry: FleetAssignment) {
	return create(FleetAssignmentSchema, {
		epoch: BigInt(entry.epoch),
		active: entry.active,
		sealed: entry.sealed,
		target: entry.target,
		reason: entry.reason,
		lossWindowMs:
			entry.lossWindowMs === undefined ? undefined : BigInt(entry.lossWindowMs),
		decidedAtMs: BigInt(entry.decidedAtMs),
		decidedBy: entry.decidedBy,
	});
}

/** A uint64 off the wire as a safe integer, or a record error. */
function safeNumber(value: bigint): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER))
		throw new BackendFleetError(
			"FLEET_RECORD_INVALID",
			"stored assignment log carries a number out of range",
		);
	return Number(value);
}

/** Encode a log for storage. Entries must already be parsed and ascending. */
export function encodeAssignmentLog(
	entries: readonly FleetAssignment[],
): string {
	return toJsonString(
		FleetAssignmentLogSchema,
		create(FleetAssignmentLogSchema, {
			format: LOG_FORMAT,
			entries: entries.map(toWire),
		}),
	);
}

/**
 * Parse a stored log into entries, ascending with no gap. Anything else is a
 * record error: a log that does not parse is never read as empty, because
 * empty is a vote ("holds nothing") and a corrupt log is not.
 */
export function decodeAssignmentLog(value: string): FleetAssignment[] {
	let log: ReturnType<typeof create<typeof FleetAssignmentLogSchema>>;
	try {
		log = fromJsonString(FleetAssignmentLogSchema, value);
	} catch {
		throw new BackendFleetError(
			"FLEET_RECORD_INVALID",
			"stored assignment log does not parse",
		);
	}
	if (log.format !== LOG_FORMAT)
		throw new BackendFleetError(
			"FLEET_RECORD_INVALID",
			"stored assignment log has an unknown format",
		);
	const entries = log.entries.map((entry) =>
		parseFleetAssignment({
			epoch: safeNumber(entry.epoch),
			active: entry.active,
			sealed: entry.sealed,
			target: entry.target,
			reason: entry.reason,
			lossWindowMs:
				entry.lossWindowMs === undefined
					? undefined
					: safeNumber(entry.lossWindowMs),
			decidedAtMs: safeNumber(entry.decidedAtMs),
			decidedBy: entry.decidedBy,
		}),
	);
	for (let index = 1; index < entries.length; index += 1)
		if (entries[index]?.epoch !== (entries[index - 1]?.epoch ?? 0) + 1)
			throw new BackendFleetError(
				"FLEET_RECORD_INVALID",
				"stored assignment log is not contiguous",
			);
	return entries;
}

/** The log of one backend, in one key of its ephemeral-state port. */
export function ephemeralAssignmentReplica(
	state: EphemeralStatePort,
	id: string,
	options: EphemeralAssignmentReplicaOptions = {},
): EphemeralAssignmentReplica {
	const replicaId = parseFleetBackendId(id);
	const key = parseEphemeralKey(options.key ?? DEFAULT_ASSIGNMENT_LOG_KEY);
	const ttl: EphemeralTtlMs = parseEphemeralTtlMs(
		options.ttlMs ?? EPHEMERAL_STATE_MAX_TTL_MS,
	);
	const maxEntries = options.maxEntries ?? ASSIGNMENT_LOG_MAX_ENTRIES;
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
		throw new BackendFleetError(
			"FLEET_CONFIGURATION_INVALID",
			"maxEntries must be a positive integer",
			{ detail: { field: "maxEntries" } },
		);

	async function read(limit?: number): Promise<readonly FleetAssignment[]> {
		const stored = await state.get(key);
		if (stored === undefined) return [];
		const entries = decodeAssignmentLog(stored.value);
		return limit === undefined ? entries : entries.slice(-limit);
	}

	function judge(
		entries: readonly FleetAssignment[],
		entry: FleetAssignment,
	): AssignmentAcceptOutcome | undefined {
		const held = entries.find((row) => row.epoch === entry.epoch);
		if (held !== undefined)
			return assignmentKey(held) === assignmentKey(entry)
				? "duplicate"
				: "conflict";
		const first = entries[0]?.epoch;
		if (first !== undefined && entry.epoch < first) return "conflict";
		const top = entries.at(-1)?.epoch ?? 0;
		return entry.epoch === top + 1 ? undefined : "gap";
	}

	async function accept(
		input: FleetAssignment,
	): Promise<AssignmentAcceptOutcome> {
		const entry = parseFleetAssignment(input);
		for (let attempt = 0; attempt < RACE_RETRIES; attempt += 1) {
			const stored = await state.get(key);
			const entries =
				stored === undefined ? [] : decodeAssignmentLog(stored.value);
			const refused = judge(entries, entry);
			if (refused !== undefined) return refused;
			const value = encodeAssignmentLog([...entries, entry].slice(-maxEntries));
			const write =
				stored === undefined
					? await state.putIfAbsent(key, value, ttl)
					: await state.compareAndSet(key, stored.version, value, ttl);
			if (write.applied) return "accepted";
			// Another writer changed the log between the read and the write.
		}
		return "busy";
	}

	return Object.freeze({
		id: replicaId,
		key,
		read,
		accept,
		refresh: () => state.expire(key, ttl),
		async seed(input: FleetAssignment) {
			const entry = parseFleetAssignment(input);
			const write = await state.putIfAbsent(
				key,
				encodeAssignmentLog([entry]),
				ttl,
			);
			return write.applied ? "seeded" : "not-empty";
		},
	});
}

/** A register over cache replicas, in configured order. */
export function ephemeralAssignmentRegister(
	replicas: readonly EphemeralAssignmentReplica[],
	options: Parameters<typeof parseAssignmentRegister>[1] = {},
): AssignmentRegister & {
	readonly replicas: readonly EphemeralAssignmentReplica[];
} {
	const register = parseAssignmentRegister(replicas, options);
	return Object.freeze({ ...register, replicas: Object.freeze([...replicas]) });
}

export type RejoinOutcome = {
	readonly replica: string;
	readonly outcome: "seeded" | "not-empty" | "unproven" | "silent";
};

/**
 * Seed every member whose log is empty with the current entry, where that is
 * provable without the member: a majority of *all* members, not counting it,
 * hold the entry as their newest. A member that answered with entries, or did
 * not answer, is left alone. Replies may be passed in to save a read.
 */
export async function rejoinAssignmentReplicas(
	register: AssignmentRegister & {
		readonly replicas: readonly EphemeralAssignmentReplica[];
	},
	replies?: readonly AssignmentReply[],
): Promise<readonly RejoinOutcome[]> {
	const members = register.replicas.map((replica) => replica.id);
	const seen = replies ?? (await readAssignmentReplies(register));
	const outcomes: RejoinOutcome[] = [];
	for (const replica of register.replicas) {
		const own = seen.find((reply) => reply.replica === replica.id);
		if (own === undefined || !("rows" in own) || own.rows.length > 0) continue;
		const others = seen.filter((reply) => reply.replica !== replica.id);
		const resolution = resolveAssignment(members, others);
		if (resolution.status !== "current") {
			outcomes.push({ replica: replica.id, outcome: "unproven" });
			continue;
		}
		try {
			outcomes.push({
				replica: replica.id,
				outcome: await replica.seed(resolution.assignment),
			});
		} catch {
			outcomes.push({ replica: replica.id, outcome: "silent" });
		}
	}
	return outcomes;
}
