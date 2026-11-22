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

export function ephemeralAssignmentRegister(
	replicas: readonly EphemeralAssignmentReplica[],
	options: Readonly<{ classify?: FailureClassifier }> = {},
): AssignmentRegister &
	Readonly<{ replicas: readonly EphemeralAssignmentReplica[] }> {
	const register = parseAssignmentRegister(replicas, options);
	return Object.freeze({ ...register, replicas: Object.freeze([...replicas]) });
}

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
