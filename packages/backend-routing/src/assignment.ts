/**
 * The assignment register: which backend of a fleet is active.
 *
 * Every backend keeps a small append-only log. A log entry names the active
 * backend (the writer) for one **epoch**. An epoch is **decided** when a
 * majority of the configured backends hold the same entry for it, and the
 * **current assignment** is the highest decided epoch. Three local rules are
 * all the safety there is:
 *
 * 1. A backend holds at most one entry per epoch.
 * 2. A backend takes an entry for epoch `e` only when its highest entry is
 *    `e - 1`, checked and written atomically on that backend.
 * 3. An entry that names a backend as the writer is written to that backend
 *    first, and to no other backend if it does not take it.
 *
 * From 1 and 2, two different entries can never both reach a majority for one
 * epoch, and a proposal made on a stale view lands only on backends that were
 * behind, which are a minority. From 3, a backend's own log always contains
 * every decided entry that makes it the writer, so a check made on one backend
 * alone is enough to refuse overwriting it.
 *
 * A reader needs answers from a majority. With fewer, or when the highest
 * epoch it can see is not decided, the answer is not a guess at the previous
 * writer: it is `no-majority` or `undecided`, and a caller stops.
 *
 * Nothing here knows an engine. A replica is anything that can `read` its log
 * and `accept` one entry under rules 1 and 2: a SQL table
 * (`sqlAssignmentReplica` in `@hobo/data-postgres`) or one key of a cache
 * (`ephemeralAssignmentReplica` here). What the rules do not survive by
 * themselves, a backend that comes back having lost its log, is discussed
 * where a replica can lose its log (`ephemeral-replica.ts`).
 */
import {
	type FleetFailureClass,
	type FleetFailureClassifier,
	parseFleetBackendId,
	unclassifiedFailure,
} from "./backend.js";
import { BackendFleetError } from "./errors.js";

/** The first epoch. An empty log takes this epoch and no other. */
export const FIRST_ASSIGNMENT_EPOCH = 1;

// domain-view: the parsed entry, constructible only through parseFleetAssignment; the generated FleetAssignment in backend_fleet_pb.ts is its wire form.
export type FleetAssignment = {
	readonly epoch: number;
	/** The writer. Absent means the fleet has deliberately no writer. */
	readonly active: string | undefined;
	/** True while a planned move is in flight: nobody may write. */
	readonly sealed: boolean;
	/** Where a sealed fleet is moving to. Set exactly when `sealed`. */
	readonly target: string | undefined;
	readonly reason: string;
	/** Upper bound on writes lost by an unplanned move, in milliseconds. */
	readonly lossWindowMs: number | undefined;
	readonly decidedAtMs: number;
	readonly decidedBy: string;
};

/** What a proposer chooses; the register supplies epoch, time and author. */
export type FleetAssignmentValue = {
	readonly active: string | undefined;
	readonly sealed: boolean;
	readonly target: string | undefined;
	readonly reason: string;
	readonly lossWindowMs: number | undefined;
};

const REASON = /^[a-z0-9][a-z0-9:._ -]{0,199}$/u;
const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/u;

function invalid(message: string, field: string): never {
	throw new BackendFleetError("FLEET_RECORD_INVALID", message, {
		detail: { field },
	});
}

/**
 * Parse an assignment entry. After this, a sealed entry always has a target
 * other than its writer, an unsealed entry never has one, and every number is
 * a non-negative safe integer.
 */
export function parseFleetAssignment(input: FleetAssignment): FleetAssignment {
	if (
		!Number.isSafeInteger(input.epoch) ||
		input.epoch < FIRST_ASSIGNMENT_EPOCH
	)
		invalid("assignment epoch must be a positive integer", "epoch");
	const active =
		input.active === undefined
			? undefined
			: parseFleetBackendId(input.active, "active");
	const target =
		input.target === undefined
			? undefined
			: parseFleetBackendId(input.target, "target");
	if (input.sealed && (target === undefined || target === active))
		invalid("a sealed assignment names a different target", "target");
	if (!input.sealed && target !== undefined)
		invalid("only a sealed assignment has a target", "target");
	if (!REASON.test(input.reason))
		invalid("assignment reason must be a short plain token", "reason");
	if (
		input.lossWindowMs !== undefined &&
		(!Number.isSafeInteger(input.lossWindowMs) || input.lossWindowMs < 0)
	)
		invalid("loss window must be a non-negative integer", "lossWindowMs");
	if (!Number.isSafeInteger(input.decidedAtMs) || input.decidedAtMs < 0)
		invalid("decision time must be a non-negative integer", "decidedAtMs");
	if (!AUTHOR.test(input.decidedBy))
		invalid("assignment author must be a short plain token", "decidedBy");
	return Object.freeze({
		epoch: input.epoch,
		active,
		sealed: input.sealed,
		target,
		reason: input.reason,
		lossWindowMs: input.lossWindowMs,
		decidedAtMs: input.decidedAtMs,
		decidedBy: input.decidedBy,
	});
}

/** Identity of an entry. Two entries are the same decision when keys match. */
export function assignmentKey(assignment: FleetAssignment): string {
	return JSON.stringify([
		assignment.epoch,
		assignment.active ?? null,
		assignment.sealed,
		assignment.target ?? null,
		assignment.reason,
		assignment.lossWindowMs ?? null,
		assignment.decidedAtMs,
		assignment.decidedBy,
	]);
}

/** How many backends make a majority of `count` configured ones. */
export function fleetMajority(count: number): number {
	if (!Number.isSafeInteger(count) || count < 1)
		throw new BackendFleetError(
			"FLEET_CONFIGURATION_INVALID",
			"a fleet needs at least one backend",
		);
	return Math.floor(count / 2) + 1;
}

export const ASSIGNMENT_ACCEPT_OUTCOMES = [
	"accepted",
	"duplicate",
	"conflict",
	"gap",
	"busy",
] as const;

/**
 * What one backend did with an entry. `duplicate` means it already held the
 * identical entry; `conflict` that it holds a different one for that epoch;
 * `gap` that its log is too short to take it; `busy` that a copy into that
 * backend is in progress.
 */
export type AssignmentAcceptOutcome =
	(typeof ASSIGNMENT_ACCEPT_OUTCOMES)[number];

/** One backend's copy of the log. */
export type AssignmentReplica = {
	readonly id: string;
	/** Entries in ascending epoch order; `limit` keeps only the highest ones. */
	read(limit?: number): Promise<readonly FleetAssignment[]>;
	accept(assignment: FleetAssignment): Promise<AssignmentAcceptOutcome>;
};

export type AssignmentReply =
	| {
			readonly replica: string;
			readonly rows: readonly FleetAssignment[];
	  }
	| { readonly replica: string; readonly failure: FleetFailureClass };

export type AssignmentContender = {
	readonly assignment: FleetAssignment;
	readonly holders: readonly string[];
};

export type AssignmentResolution =
	| {
			readonly status: "current";
			readonly assignment: FleetAssignment;
			readonly holders: readonly string[];
			/** Backends that answered and do not hold the current entry. */
			readonly behind: readonly string[];
			readonly silent: readonly string[];
	  }
	| { readonly status: "empty"; readonly silent: readonly string[] }
	| {
			readonly status: "undecided";
			readonly epoch: number;
			readonly contenders: readonly AssignmentContender[];
			readonly silent: readonly string[];
	  }
	| {
			readonly status: "no-majority";
			readonly answered: number;
			readonly required: number;
			readonly silent: readonly string[];
	  };

function contendersAt(
	replies: readonly AssignmentReply[],
	epoch: number,
): AssignmentContender[] {
	const byKey = new Map<
		string,
		{ assignment: FleetAssignment; holders: string[] }
	>();
	for (const reply of replies) {
		if (!("rows" in reply)) continue;
		const held = reply.rows.find((row) => row.epoch === epoch);
		if (held === undefined) continue;
		const key = assignmentKey(held);
		const entry = byKey.get(key) ?? { assignment: held, holders: [] };
		entry.holders.push(reply.replica);
		byKey.set(key, entry);
	}
	return [...byKey.entries()]
		.sort(
			([leftKey, left], [rightKey, right]) =>
				right.holders.length - left.holders.length ||
				(leftKey < rightKey ? -1 : 1),
		)
		.map(([, entry]) => entry);
}

function highestEpoch(replies: readonly AssignmentReply[]): number {
	let top = 0;
	for (const reply of replies)
		if ("rows" in reply)
			for (const row of reply.rows) top = Math.max(top, row.epoch);
	return top;
}

/**
 * Decide what a set of replies proves. Pure: no clock, no I/O.
 *
 * `current` is returned only for the highest epoch seen, and only when a
 * majority of the *configured* members hold the same entry for it. An entry
 * held by fewer is never treated as the answer, and neither is the decided
 * epoch below it: something newer may already be decided out of sight.
 */
export function resolveAssignment(
	members: readonly string[],
	replies: readonly AssignmentReply[],
): AssignmentResolution {
	const required = fleetMajority(members.length);
	const known = new Map<string, AssignmentReply>();
	for (const reply of replies)
		if (members.includes(reply.replica) && !known.has(reply.replica))
			known.set(reply.replica, reply);
	const answered = [...known.values()].filter((reply) => "rows" in reply);
	const silent = members.filter((member) => {
		const reply = known.get(member);
		return reply === undefined || !("rows" in reply);
	});
	if (answered.length < required)
		return {
			status: "no-majority",
			answered: answered.length,
			required,
			silent,
		};
	const epoch = highestEpoch(answered);
	if (epoch === 0) return { status: "empty", silent };
	const contenders = contendersAt(answered, epoch);
	const leader = contenders[0];
	if (leader !== undefined && leader.holders.length >= required)
		return {
			status: "current",
			assignment: leader.assignment,
			holders: leader.holders,
			behind: answered
				.map((reply) => reply.replica)
				.filter((replica) => !leader.holders.includes(replica)),
			silent,
		};
	return { status: "undecided", epoch, contenders, silent };
}

/** The members of one fleet's register, in configured order. */
export type AssignmentRegister = {
	readonly replicas: readonly AssignmentReplica[];
	/** How a replica's failed read is classified. Default: `unknown`. */
	readonly classify?: FleetFailureClassifier;
};

export function parseAssignmentRegister(
	replicas: readonly AssignmentReplica[],
	options: { readonly classify?: FleetFailureClassifier } = {},
): AssignmentRegister {
	const ids = replicas.map((replica) => parseFleetBackendId(replica.id));
	if (ids.length === 0 || new Set(ids).size !== ids.length)
		throw new BackendFleetError(
			"FLEET_CONFIGURATION_INVALID",
			"a fleet needs at least one backend and no repeated id",
		);
	const register: AssignmentRegister = {
		replicas: Object.freeze([...replicas]),
	};
	return Object.freeze(
		options.classify === undefined
			? register
			: { ...register, classify: options.classify },
	);
}

/** Ask every member for its log. A member that fails is a classified absence. */
export async function readAssignmentReplies(
	register: AssignmentRegister,
	limit?: number,
): Promise<readonly AssignmentReply[]> {
	return Promise.all(
		register.replicas.map(async (replica): Promise<AssignmentReply> => {
			try {
				return { replica: replica.id, rows: await replica.read(limit) };
			} catch (error) {
				return {
					replica: replica.id,
					failure: (register.classify ?? unclassifiedFailure)(
						error instanceof Error ? error : undefined,
					),
				};
			}
		}),
	);
}

/**
 * Majority read of the current assignment. Reads only the newest entry.
 *
 * It answers as soon as the replies in hand prove a current assignment, without
 * waiting for a backend that is slow or gone: a newest entry held by a majority
 * of the configured members is decided whatever the rest would say, and no
 * decided epoch above it can exist without one of those members holding it.
 */
export function readCurrentAssignment(
	register: AssignmentRegister,
): Promise<AssignmentResolution> {
	const members = register.replicas.map((replica) => replica.id);
	const replies: AssignmentReply[] = [];
	return new Promise((resolve) => {
		let settled = false;
		for (const replica of register.replicas)
			void readAssignmentReplies({ ...register, replicas: [replica] }, 1).then(
				([reply]) => {
					if (settled || reply === undefined) return;
					replies.push(reply);
					const resolution = resolveAssignment(members, replies);
					if (
						resolution.status === "current" ||
						replies.length === members.length
					) {
						settled = true;
						resolve(resolution);
					}
				},
			);
	});
}

async function offer(
	replica: AssignmentReplica,
	assignment: FleetAssignment,
): Promise<AssignmentAcceptOutcome | "silent"> {
	try {
		return await replica.accept(assignment);
	} catch {
		return "silent";
	}
}

/**
 * Copy entries that already exist onto members whose logs are shorter, up to
 * `upTo`. Nothing is invented: each copied entry is one a member holds, and
 * for an epoch with more than one entry the most widely held one is copied.
 */
async function repairLogs(
	register: AssignmentRegister,
	replies: readonly AssignmentReply[],
	upTo: number,
): Promise<void> {
	for (const reply of replies) {
		if (!("rows" in reply)) continue;
		const replica = register.replicas.find(
			(candidate) => candidate.id === reply.replica,
		);
		if (replica === undefined) continue;
		let next = (reply.rows.at(-1)?.epoch ?? 0) + 1;
		while (next <= upTo) {
			const source = contendersAt(replies, next)[0];
			if (source === undefined) break;
			const outcome = await offer(replica, source.assignment);
			if (outcome !== "accepted" && outcome !== "duplicate") break;
			next += 1;
		}
	}
}

export type AssignmentProposalOutcome =
	| {
			readonly status: "decided";
			readonly assignment: FleetAssignment;
			readonly holders: readonly string[];
	  }
	| {
			/** Written to fewer than a majority. It may still be completed later. */
			readonly status: "undecided";
			readonly assignment: FleetAssignment;
			readonly holders: readonly string[];
	  }
	| {
			/** The caller's expected epoch is no longer the current one. */
			readonly status: "stale";
			readonly resolution: AssignmentResolution;
	  }
	| {
			/** No majority answered, or the newest epoch is not decided. */
			readonly status: "unavailable";
			readonly resolution: AssignmentResolution;
	  }
	| {
			/** The backend the entry names as writer did not take it. */
			readonly status: "refused";
			readonly replica: string;
			readonly outcome: AssignmentAcceptOutcome | "silent" | "not-a-member";
	  };

/**
 * Write one entry: to the backend it names as writer first, then to the rest
 * in configured order.
 *
 * A proposer stops at the first member that holds a different entry for the
 * epoch, because somebody else's proposal got there first; stopping leaves the
 * remaining members free, so a contested epoch can still be settled. Completion
 * does not stop: it offers the entry it chose to every member that can take it.
 */
async function place(
	register: AssignmentRegister,
	assignment: FleetAssignment,
	mode: "propose" | "complete",
): Promise<AssignmentProposalOutcome> {
	const required = fleetMajority(register.replicas.length);
	const writer = register.replicas.find(
		(replica) => replica.id === assignment.active,
	);
	if (assignment.active !== undefined && writer === undefined)
		return {
			status: "refused",
			replica: assignment.active,
			outcome: "not-a-member",
		};
	const holders: string[] = [];
	if (writer !== undefined) {
		const outcome = await offer(writer, assignment);
		if (outcome !== "accepted" && outcome !== "duplicate")
			return { status: "refused", replica: writer.id, outcome };
		holders.push(writer.id);
	}
	for (const replica of register.replicas) {
		if (replica === writer) continue;
		const outcome = await offer(replica, assignment);
		if (outcome === "accepted" || outcome === "duplicate")
			holders.push(replica.id);
		else if (outcome === "conflict" && mode === "propose") break;
	}
	return {
		status: holders.length >= required ? "decided" : "undecided",
		assignment,
		holders,
	};
}

export type AssignmentProposal = {
	/** The epoch the caller believes is current; 0 when nothing is decided. */
	readonly expectedEpoch: number;
	readonly value: FleetAssignmentValue;
	readonly decidedBy: string;
	readonly nowMs: number;
};

/**
 * Propose the next assignment, as a compare-and-set on the current epoch.
 *
 * The proposer never decides on older information: if the newest epoch it can
 * see is not decided it returns `unavailable` and writes nothing. Only
 * `decided` means the entry is the current assignment. Any other outcome means
 * "read again"; an `undecided` entry may still be completed by someone else.
 */
export async function proposeAssignment(
	register: AssignmentRegister,
	proposal: AssignmentProposal,
): Promise<AssignmentProposalOutcome> {
	const replies = await readAssignmentReplies(register);
	const resolution = resolveAssignment(
		register.replicas.map((replica) => replica.id),
		replies,
	);
	if (resolution.status !== "current" && resolution.status !== "empty")
		return { status: "unavailable", resolution };
	const currentEpoch =
		resolution.status === "current" ? resolution.assignment.epoch : 0;
	if (currentEpoch !== proposal.expectedEpoch)
		return { status: "stale", resolution };
	const assignment = parseFleetAssignment({
		...proposal.value,
		epoch: currentEpoch + 1,
		decidedAtMs: proposal.nowMs,
		decidedBy: proposal.decidedBy,
	});
	await repairLogs(register, replies, currentEpoch);
	return place(register, assignment, "propose");
}

/**
 * The first assignment of a fleet with empty logs.
 *
 * The entry is the same bytes no matter who writes it, so any number of
 * instances starting at once agree instead of splitting the first epoch.
 */
export async function bootstrapAssignment(
	register: AssignmentRegister,
	active: string,
): Promise<AssignmentProposalOutcome> {
	return proposeAssignment(register, {
		expectedEpoch: 0,
		value: {
			active,
			sealed: false,
			target: undefined,
			reason: "bootstrap",
			lossWindowMs: undefined,
		},
		decidedBy: "bootstrap",
		nowMs: 0,
	});
}

/**
 * Finish what an interrupted proposer started.
 *
 * When the newest epoch is held by fewer than a majority, copy that same entry
 * (same epoch, same value) onto more members. No new value is chosen. Members
 * that are behind are first brought up to the epoch before it.
 */
export async function completeAssignment(
	register: AssignmentRegister,
): Promise<AssignmentResolution> {
	const members = register.replicas.map((replica) => replica.id);
	const replies = await readAssignmentReplies(register);
	const resolution = resolveAssignment(members, replies);
	if (resolution.status === "current") {
		if (resolution.behind.length > 0)
			await repairLogs(register, replies, resolution.assignment.epoch);
		return resolution;
	}
	if (resolution.status !== "undecided") return resolution;
	await repairLogs(register, replies, resolution.epoch - 1);
	for (const contender of resolution.contenders) {
		const outcome = await place(register, contender.assignment, "complete");
		if (outcome.status === "decided") break;
	}
	return resolveAssignment(members, await readAssignmentReplies(register));
}

export type AssignmentOverride = {
	readonly value: FleetAssignmentValue;
	readonly decidedBy: string;
	readonly nowMs: number;
};

/**
 * Operator override. Writes a new epoch above everything visible, whatever the
 * current epoch is or whether it is decided.
 *
 * This is the only way to break a split epoch and the only way to promote a
 * standby beyond the recovery point objective. It skips the compare-and-set on
 * purpose, so it belongs to a person, never to a scheduled job. It still needs
 * a majority to answer and still writes to the named writer first.
 */
export async function overrideAssignment(
	register: AssignmentRegister,
	override: AssignmentOverride,
): Promise<AssignmentProposalOutcome> {
	const members = register.replicas.map((replica) => replica.id);
	const replies = await readAssignmentReplies(register);
	const resolution = resolveAssignment(members, replies);
	if (resolution.status === "no-majority")
		return { status: "unavailable", resolution };
	const top = highestEpoch(replies);
	await repairLogs(register, replies, top);
	return place(
		register,
		parseFleetAssignment({
			...override.value,
			epoch: top + 1,
			decidedAtMs: override.nowMs,
			decidedBy: override.decidedBy,
		}),
		"complete",
	);
}
