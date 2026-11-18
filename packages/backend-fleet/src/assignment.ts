import {
	type FleetFailureClass,
	type FleetFailureClassifier,
	parseFleetBackendId,
	unclassifiedFailure,
} from "./backend.js";
import { BackendFleetError } from "./errors.js";

export const FIRST_ASSIGNMENT_EPOCH = 1;

export type FleetAssignment = {
	readonly epoch: number;
	readonly active: string | undefined;
	readonly sealed: boolean;
	readonly target: string | undefined;
	readonly reason: string;
	readonly lossWindowMs: number | undefined;
	readonly decidedAtMs: number;
	readonly decidedBy: string;
};

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

export type AssignmentAcceptOutcome =
	(typeof ASSIGNMENT_ACCEPT_OUTCOMES)[number];

export type AssignmentReplica = {
	readonly id: string;
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

export type AssignmentRegister = {
	readonly replicas: readonly AssignmentReplica[];
	readonly classify?: FleetFailureClassifier;
	readonly earlyCurrent?: (
		resolution: Extract<AssignmentResolution, { status: "current" }>,
		replies: readonly AssignmentReply[],
	) => boolean;
	readonly stopAfterMajority?: boolean;
};

export function parseAssignmentRegister(
	replicas: readonly AssignmentReplica[],
	options: {
		readonly classify?: FleetFailureClassifier;
		readonly earlyCurrent?: AssignmentRegister["earlyCurrent"];
		readonly stopAfterMajority?: boolean;
	} = {},
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
	return Object.freeze({
		...register,
		...(options.classify ? { classify: options.classify } : undefined),
		...(options.earlyCurrent
			? { earlyCurrent: options.earlyCurrent }
			: undefined),
		...(options.stopAfterMajority ? { stopAfterMajority: true } : undefined),
	});
}

export async function readAssignmentReplies(
	register: AssignmentRegister,
	limit?: number,
): Promise<readonly AssignmentReply[]> {
	const reads = register.replicas.map(
		async (replica): Promise<AssignmentReply> => {
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
		},
	);
	if (!register.earlyCurrent) return Promise.all(reads);
	const members = register.replicas.map((replica) => replica.id);
	const acceptCurrent = register.earlyCurrent;
	return new Promise((resolve) => {
		const replies: AssignmentReply[] = [];
		let done = false;
		for (const read of reads)
			void read.then((reply) => {
				if (done) return;
				replies.push(reply);
				const resolution = resolveAssignment(members, replies);
				let sufficient = false;
				if (resolution.status === "current") {
					try {
						sufficient = acceptCurrent(resolution, replies);
					} catch {}
				}
				if (sufficient || replies.length === members.length) {
					done = true;
					resolve([...replies]);
				}
			});
	});
}

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
			readonly status: "undecided";
			readonly assignment: FleetAssignment;
			readonly holders: readonly string[];
	  }
	| {
			readonly status: "stale";
			readonly resolution: AssignmentResolution;
	  }
	| {
			readonly status: "unavailable";
			readonly resolution: AssignmentResolution;
	  }
	| {
			readonly status: "refused";
			readonly replica: string;
			readonly outcome: AssignmentAcceptOutcome | "silent" | "not-a-member";
	  };

async function place(
	register: AssignmentRegister,
	assignment: FleetAssignment,
	mode: "propose" | "complete",
	priority: readonly string[] = [],
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
		if (register.stopAfterMajority && holders.length >= required)
			return { status: "decided", assignment, holders };
	}
	const responsive = new Set(priority);
	const ordered = register.stopAfterMajority
		? [...register.replicas].sort(
				(a, b) => Number(!responsive.has(a.id)) - Number(!responsive.has(b.id)),
			)
		: register.replicas;
	for (const replica of ordered) {
		if (replica === writer) continue;
		const outcome = await offer(replica, assignment);
		if (outcome === "accepted" || outcome === "duplicate") {
			holders.push(replica.id);
			if (register.stopAfterMajority && holders.length >= required)
				return { status: "decided", assignment, holders };
		} else if (outcome === "conflict" && mode === "propose") break;
	}
	return {
		status: holders.length >= required ? "decided" : "undecided",
		assignment,
		holders,
	};
}

export type AssignmentProposal = {
	readonly expectedEpoch: number;
	readonly value: FleetAssignmentValue;
	readonly decidedBy: string;
	readonly nowMs: number;
};

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
	return place(
		register,
		assignment,
		"propose",
		replies.filter((reply) => "rows" in reply).map((reply) => reply.replica),
	);
}

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
		const outcome = await place(
			register,
			contender.assignment,
			"complete",
			replies.filter((reply) => "rows" in reply).map((reply) => reply.replica),
		);
		if (outcome.status === "decided") break;
	}
	return resolveAssignment(members, await readAssignmentReplies(register));
}

export type AssignmentOverride = {
	readonly value: FleetAssignmentValue;
	readonly decidedBy: string;
	readonly nowMs: number;
};

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
