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

export const ASSIGNMENT_LOG_MAX_ENTRIES = 32;
// public-contract: the stored key every replica of an unnamed register shares.
export const DEFAULT_ASSIGNMENT_LOG_KEY = "hobo:fleet:assignment";
const LOG_FORMAT = 1;
const RACE_RETRIES = 4;

export type EphemeralAssignmentReplica = AssignmentReplica & {
	readonly key: EphemeralKey;
	refresh(): Promise<boolean>;
	seed(entry: FleetAssignment): Promise<"seeded" | "not-empty">;
};

export type EphemeralAssignmentReplicaOptions = {
	readonly key?: string;
	readonly ttlMs?: number;
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

function safeNumber(value: bigint): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER))
		throw new BackendFleetError(
			"FLEET_RECORD_INVALID",
			"stored assignment log carries a number out of range",
		);
	return Number(value);
}

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
