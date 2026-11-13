/**
 * An assignment replica kept in one key of an `EphemeralStatePort`.
 *
 * Moved from `packages/backend-fleet/src/ephemeral-replica.ts` (62dbc5d4c).
 * The whole log of one member is one value (`log.ts`) holding the newest
 * entries in ascending order. `accept` reads the key, checks the register's
 * rules on what it read, and writes the longer log back conditionally:
 *
 * - **One entry per epoch.** An epoch the log holds answers `duplicate` (the
 *   same entry) or `conflict` (another one). An epoch below the oldest entry
 *   kept answers `conflict`: the log held one, and which is no longer known.
 * - **Only `top + 1`.** Any other epoch answers `gap`. An empty log takes
 *   epoch 1 only.
 * - **Atomic per member.** The write is `putIfAbsent` for an empty log and
 *   `compareAndSet` on the version read otherwise, so two writers racing on
 *   one member cannot both extend the same log: the loser re-reads and
 *   re-checks. A replica that keeps losing races answers `busy`.
 *
 * Every write sets the key's TTL to the port's 30-day cap, and `refresh`
 * resets it without writing (the repair tick calls it on every member).
 *
 * **When a log is lost.** A cache may lose the key: it expires, the store is
 * flushed, or the store evicts it. A lost log reads as empty, so the member
 * simply stops counting as a holder of anything. Safety needs one thing from
 * that: every decided entry stays held by a majority of the members. The
 * repair tick copies the current entry onto every member that answers (see
 * `completeAssignment`), so once it has run, a decided entry is held by all of
 * them, and losing the log of any minority leaves a majority holding it. What
 * it does not survive is losing a log that was part of a *bare* majority
 * before repair copied the entry further, while another holder is silent:
 * then nobody can prove the entry was decided. `ephemeral-replica.test.ts`
 * checks both.
 *
 * An emptied member is brought back by `rejoinAssignmentReplicas`: it is
 * seeded with the current entry only when a majority *other than itself*
 * hold that entry as their newest, which proves it decided and proves no
 * newer entry is decided. The same move admits a member a membership epoch
 * has just added, whose log starts empty.
 */
import {
	EPHEMERAL_STATE_MAX_TTL_MS,
	type EphemeralStatePort,
	type EphemeralTtlMs,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "@hobo/core";
import { FleetParseError } from "../errors.js";
import { type MemberName, parseMemberName } from "../ids.js";
import type {
	AssignmentAcceptOutcome,
	AssignmentEntry,
	AssignmentRegister,
	AssignmentReply,
	EphemeralAssignmentReplica,
	EphemeralAssignmentReplicaOptions,
	FailureClassifier,
	RejoinOutcome,
} from "../ports.js";
import { decodeAssignmentLog, encodeAssignmentLog } from "./log.js";
import {
	assignmentKey,
	parseAssignmentEntry,
	parseAssignmentRegister,
	readAssignmentReplies,
	resolveAssignment,
} from "./register.js";

/** Entries kept per log. Older ones are dropped; the register needs only the newest. */
export const ASSIGNMENT_LOG_MAX_ENTRIES = 32;
// public-contract: unchanged stored key every replica of an unnamed register shares.
export const DEFAULT_ASSIGNMENT_LOG_KEY = "hobo:fleet:assignment";
const RACE_RETRIES = 4;

function judge(
	entries: readonly AssignmentEntry[],
	entry: AssignmentEntry,
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

/** The log of one member, in one key of its ephemeral-state port. */
export function ephemeralAssignmentReplica(
	state: EphemeralStatePort,
	id: MemberName,
	options: EphemeralAssignmentReplicaOptions = {},
): EphemeralAssignmentReplica {
	const replicaId = parseMemberName(id);
	const key = parseEphemeralKey(options.key ?? DEFAULT_ASSIGNMENT_LOG_KEY);
	const ttl: EphemeralTtlMs = parseEphemeralTtlMs(
		options.ttlMs ?? EPHEMERAL_STATE_MAX_TTL_MS,
	);
	const maxEntries = options.maxEntries ?? ASSIGNMENT_LOG_MAX_ENTRIES;
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
		throw new FleetParseError(
			"maxEntries",
			"maxEntries must be a positive integer",
		);

	async function read(limit?: number): Promise<readonly AssignmentEntry[]> {
		const stored = await state.get(key);
		if (stored === undefined) return [];
		const entries = decodeAssignmentLog(stored.value);
		return limit === undefined ? entries : entries.slice(-limit);
	}

	async function accept(
		input: AssignmentEntry,
	): Promise<AssignmentAcceptOutcome> {
		const entry = parseAssignmentEntry(input);
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
		async seed(input: AssignmentEntry) {
			const entry = parseAssignmentEntry(input);
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
	options: Readonly<{ classify?: FailureClassifier }> = {},
): AssignmentRegister &
	Readonly<{ replicas: readonly EphemeralAssignmentReplica[] }> {
	const register = parseAssignmentRegister(replicas, options);
	return Object.freeze({ ...register, replicas: Object.freeze([...replicas]) });
}

/**
 * Seed every member whose log is empty with the current entry, where that is
 * provable without the member: a majority, not counting it, hold the entry as
 * their newest. A member that answered with entries, did not answer, or has
 * no `seed` (a log that cannot be lost) is left alone. Replies may be passed
 * in to save a read.
 */
export async function rejoinAssignmentReplicas(
	register: AssignmentRegister,
	replies?: readonly AssignmentReply[],
): Promise<readonly RejoinOutcome[]> {
	const members = register.replicas.map((replica) => replica.id);
	const seen = replies ?? (await readAssignmentReplies(register));
	const outcomes: RejoinOutcome[] = [];
	for (const replica of register.replicas) {
		if (replica.seed === undefined) continue;
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
