import { Health } from "../_generated/fleet_pb.js";
import { FleetParseError } from "../errors.js";
import { type MemberName, parseMemberName } from "../ids.js";
import type {
	AssignmentAcceptOutcome,
	AssignmentContender,
	AssignmentEntry,
	AssignmentOverride,
	AssignmentProposal,
	AssignmentProposalOutcome,
	AssignmentRegister,
	AssignmentReplica,
	AssignmentReply,
	AssignmentResolution,
	AssignmentValue,
	FailureClassifier,
} from "../ports.js";

export const FIRST_ASSIGNMENT_EPOCH = 1;
export const ASSIGNMENT_ACCEPT_OUTCOMES = [
	"accepted",
	"duplicate",
	"conflict",
	"gap",
	"busy",
] as const;

const PIN_REASON = "pin-members";
const ADMIT = "admit:";
const REMOVE = "remove:";
const REASON = /^[a-z0-9][a-z0-9:._ -]{0,199}$/u;
const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/u;

function invalid(message: string, field: string): never {
	throw new FleetParseError(field, message);
}

const unclassifiedFailure: FailureClassifier = () => Health.UNKNOWN;

function sortedSet(names: Iterable<MemberName>): MemberName[] {
	return [...new Set(names)].sort();
}

function parseMembers(
	input: readonly MemberName[] | undefined,
	reason: string,
): readonly MemberName[] | undefined {
	if (input === undefined) return undefined;
	if (input.length === 0) invalid("a member set is never empty", "members");
	const members = input.map((name) => parseMemberName(name, "members"));
	for (let index = 1; index < members.length; index += 1)
		if ((members[index - 1] ?? "") >= (members[index] ?? ""))
			invalid("a member set is sorted and has no repeats", "members");
	const changed = membershipChange(reason);
	if (changed?.kind === "admit" && !members.includes(changed.name))
		invalid("an admitting entry holds the admitted name", "members");
	if (changed?.kind === "remove" && members.includes(changed.name))
		invalid("a removing entry no longer holds the removed name", "members");
	return Object.freeze(members);
}

function membershipChange(
	reason: string,
): Readonly<{ kind: "admit" | "remove"; name: MemberName }> | undefined {
	if (reason.startsWith(ADMIT))
		return {
			kind: "admit",
			name: parseMemberName(reason.slice(ADMIT.length), "reason"),
		};
	if (reason.startsWith(REMOVE))
		return {
			kind: "remove",
			name: parseMemberName(reason.slice(REMOVE.length), "reason"),
		};
	return undefined;
}

export function parseAssignmentEntry(input: AssignmentEntry): AssignmentEntry {
	if (
		!Number.isSafeInteger(input.epoch) ||
		input.epoch < FIRST_ASSIGNMENT_EPOCH
	)
		invalid("assignment epoch must be a positive integer", "epoch");
	const active =
		input.active === undefined
			? undefined
			: parseMemberName(input.active, "active");
	const target =
		input.target === undefined
			? undefined
			: parseMemberName(input.target, "target");
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
		members: parseMembers(input.members, input.reason),
	});
}

export function assignmentKey(entry: AssignmentEntry): string {
	const key: (string | number | boolean | null | readonly string[])[] = [
		entry.epoch,
		entry.active ?? null,
		entry.sealed,
		entry.target ?? null,
		entry.reason,
		entry.lossWindowMs ?? null,
		entry.decidedAtMs,
		entry.decidedBy,
	];
	if (entry.members !== undefined) key.push(entry.members);
	return JSON.stringify(key);
}

export function fleetMajority(count: number): number {
	if (!Number.isSafeInteger(count) || count < 1)
		invalid("a fleet needs at least one member", "members");
	return Math.floor(count / 2) + 1;
}

export function decidingSet(
	entry: AssignmentEntry,
): readonly MemberName[] | undefined {
	if (entry.members === undefined) return undefined;
	const changed = membershipChange(entry.reason);
	if (changed === undefined) return entry.members;
	return changed.kind === "admit"
		? entry.members.filter((name) => name !== changed.name)
		: sortedSet([...entry.members, changed.name]);
}

function decidersOf(
	entry: AssignmentEntry,
	configured: readonly MemberName[],
): readonly MemberName[] {
	return decidingSet(entry) ?? configured;
}

function contendersAt(
	replies: readonly AssignmentReply[],
	epoch: number,
	configured: readonly MemberName[],
): AssignmentContender[] {
	const byKey = new Map<
		string,
		{ assignment: AssignmentEntry; holders: MemberName[]; deciding: number }
	>();
	for (const reply of replies) {
		if (!("rows" in reply)) continue;
		const held = reply.rows.find((row) => row.epoch === epoch);
		if (held === undefined) continue;
		const key = assignmentKey(held);
		const entry = byKey.get(key) ?? {
			assignment: held,
			holders: [],
			deciding: 0,
		};
		entry.holders.push(reply.replica);
		if (decidersOf(held, configured).includes(reply.replica))
			entry.deciding += 1;
		byKey.set(key, entry);
	}
	return [...byKey.entries()]
		.sort(
			([leftKey, left], [rightKey, right]) =>
				right.deciding - left.deciding ||
				right.holders.length - left.holders.length ||
				(leftKey < rightKey ? -1 : 1),
		)
		.map(([, entry]) => ({
			assignment: entry.assignment,
			holders: entry.holders,
		}));
}

function highestEpoch(replies: readonly AssignmentReply[]): number {
	let top = 0;
	for (const reply of replies)
		if ("rows" in reply)
			for (const row of reply.rows) top = Math.max(top, row.epoch);
	return top;
}

function decidingHolders(
	contender: AssignmentContender,
	configured: readonly MemberName[],
): number {
	const deciders = decidersOf(contender.assignment, configured);
	return contender.holders.filter((holder) => deciders.includes(holder)).length;
}

export function resolveAssignment(
	members: readonly MemberName[],
	replies: readonly AssignmentReply[],
): AssignmentResolution {
	const known = new Map<MemberName, AssignmentReply>();
	for (const reply of replies)
		if (members.includes(reply.replica) && !known.has(reply.replica))
			known.set(reply.replica, reply);
	const answered = [...known.values()].filter((reply) => "rows" in reply);
	const epoch = highestEpoch(answered);
	const contenders = epoch === 0 ? [] : contendersAt(answered, epoch, members);
	const leader = contenders[0];
	const deciders =
		leader === undefined ? members : decidersOf(leader.assignment, members);
	const required = fleetMajority(deciders.length);
	const answering = answered.filter((reply) =>
		deciders.includes(reply.replica),
	).length;
	const silent = [
		...members,
		...deciders.filter((name) => !members.includes(name)),
	].filter((member) => {
		const reply = known.get(member);
		return reply === undefined || !("rows" in reply);
	});
	if (answering < required)
		return { status: "no-majority", answered: answering, required, silent };
	if (leader === undefined) return { status: "empty", silent };
	if (decidingHolders(leader, members) >= required)
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

function idsOf(register: AssignmentRegister): MemberName[] {
	return register.replicas.map((replica) => replica.id);
}

export function parseAssignmentRegister(
	replicas: readonly AssignmentReplica[],
	options: Readonly<{
		classify?: FailureClassifier;
		earlyCurrent?: AssignmentRegister["earlyCurrent"];
		stopAfterMajority?: boolean;
	}> = {},
): AssignmentRegister {
	const ids = replicas.map((replica) => parseMemberName(replica.id));
	if (ids.length === 0 || new Set(ids).size !== ids.length)
		invalid("a fleet needs at least one member and no repeated id", "members");
	let register: AssignmentRegister = {
		replicas: Object.freeze([...replicas]),
	};
	if (options.classify !== undefined)
		register = { ...register, classify: options.classify };
	if (options.earlyCurrent !== undefined)
		register = { ...register, earlyCurrent: options.earlyCurrent };
	if (options.stopAfterMajority === true)
		register = { ...register, stopAfterMajority: true };
	return Object.freeze(register);
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
	const enough = register.earlyCurrent;
	if (enough === undefined) return Promise.all(reads);
	const members = idsOf(register);
	return new Promise((answer) => {
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
						sufficient = enough(resolution, replies);
					} catch {
						sufficient = false;
					}
				}
				if (sufficient || replies.length === members.length) {
					done = true;
					answer([...replies]);
				}
			});
	});
}

export function readCurrentAssignment(
	register: AssignmentRegister,
): Promise<AssignmentResolution> {
	const members = idsOf(register);
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
	entry: AssignmentEntry,
): Promise<AssignmentAcceptOutcome | "silent"> {
	try {
		return await replica.accept(entry);
	} catch {
		return "silent";
	}
}

async function repairLogs(
	register: AssignmentRegister,
	replies: readonly AssignmentReply[],
	upTo: number,
): Promise<void> {
	const configured = idsOf(register);
	for (const reply of replies) {
		if (!("rows" in reply)) continue;
		const replica = register.replicas.find(
			(candidate) => candidate.id === reply.replica,
		);
		if (replica === undefined) continue;
		let next = (reply.rows.at(-1)?.epoch ?? 0) + 1;
		while (next <= upTo) {
			const source = contendersAt(replies, next, configured)[0];
			if (source === undefined) break;
			const outcome = await offer(replica, source.assignment);
			if (outcome !== "accepted" && outcome !== "duplicate") break;
			next += 1;
		}
	}
}

function answeredOf(replies: readonly AssignmentReply[]): MemberName[] {
	return replies.flatMap((reply) => ("rows" in reply ? [reply.replica] : []));
}

async function place(
	register: AssignmentRegister,
	entry: AssignmentEntry,
	mode: "propose" | "complete",
	answered: readonly MemberName[] = [],
): Promise<AssignmentProposalOutcome> {
	const deciders = decidersOf(entry, idsOf(register));
	const required = fleetMajority(deciders.length);
	const decided = (holders: readonly MemberName[]) =>
		holders.filter((holder) => deciders.includes(holder)).length >= required;
	const writer = register.replicas.find(
		(replica) => replica.id === entry.active,
	);
	if (entry.active !== undefined && writer === undefined)
		return {
			status: "refused",
			replica: entry.active,
			outcome: "not-a-member",
		};
	const holders: MemberName[] = [];
	if (writer !== undefined) {
		const outcome = await offer(writer, entry);
		if (outcome !== "accepted" && outcome !== "duplicate")
			return { status: "refused", replica: writer.id, outcome };
		holders.push(writer.id);
		if (register.stopAfterMajority === true && decided(holders))
			return { status: "decided", assignment: entry, holders };
	}
	const responsive = new Set(answered);
	const ordered =
		register.stopAfterMajority === true
			? [...register.replicas].sort(
					(a, b) =>
						Number(!responsive.has(a.id)) - Number(!responsive.has(b.id)),
				)
			: register.replicas;
	for (const replica of ordered) {
		if (replica === writer) continue;
		const outcome = await offer(replica, entry);
		if (outcome === "accepted" || outcome === "duplicate") {
			holders.push(replica.id);
			if (register.stopAfterMajority === true && decided(holders))
				return { status: "decided", assignment: entry, holders };
		} else if (outcome === "conflict" && mode === "propose") break;
	}
	return {
		status: decided(holders) ? "decided" : "undecided",
		assignment: entry,
		holders,
	};
}

type Prepared = Readonly<
	| {
			ok: true;
			current: AssignmentEntry | undefined;
			replies: readonly AssignmentReply[];
			resolution: AssignmentResolution;
	  }
	| { ok: false; outcome: AssignmentProposalOutcome }
>;

async function prepare(
	register: AssignmentRegister,
	expectedEpoch: number,
): Promise<Prepared> {
	const replies = await readAssignmentReplies(register);
	const resolution = resolveAssignment(idsOf(register), replies);
	if (resolution.status !== "current" && resolution.status !== "empty")
		return { ok: false, outcome: { status: "unavailable", resolution } };
	const current =
		resolution.status === "current" ? resolution.assignment : undefined;
	if ((current?.epoch ?? 0) !== expectedEpoch)
		return { ok: false, outcome: { status: "stale", resolution } };
	return { ok: true, current, replies, resolution };
}

function nextEntry(
	current: AssignmentEntry | undefined,
	value: AssignmentValue,
	members: readonly MemberName[] | undefined,
	decidedBy: string,
	nowMs: number,
): AssignmentEntry {
	return parseAssignmentEntry({
		...value,
		epoch: (current?.epoch ?? 0) + 1,
		decidedAtMs: nowMs,
		decidedBy,
		members,
	});
}

export async function proposeAssignment(
	register: AssignmentRegister,
	proposal: AssignmentProposal,
): Promise<AssignmentProposalOutcome> {
	const prepared = await prepare(register, proposal.expectedEpoch);
	if (!prepared.ok) return prepared.outcome;
	const entry = nextEntry(
		prepared.current,
		proposal.value,
		prepared.current?.members,
		proposal.decidedBy,
		proposal.nowMs,
	);
	await repairLogs(register, prepared.replies, prepared.current?.epoch ?? 0);
	return place(register, entry, "propose", answeredOf(prepared.replies));
}

export async function bootstrapAssignment(
	register: AssignmentRegister,
	active: MemberName,
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
	const members = idsOf(register);
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
			answeredOf(replies),
		);
		if (outcome.status === "decided") break;
	}
	return resolveAssignment(members, await readAssignmentReplies(register));
}

export async function overrideAssignment(
	register: AssignmentRegister,
	override: AssignmentOverride,
): Promise<AssignmentProposalOutcome> {
	const members = idsOf(register);
	const replies = await readAssignmentReplies(register);
	const resolution = resolveAssignment(members, replies);
	if (resolution.status === "no-majority")
		return { status: "unavailable", resolution };
	const top = highestEpoch(replies);
	await repairLogs(register, replies, top);
	const newest = contendersAt(replies, top, members)[0]?.assignment;
	return place(
		register,
		parseAssignmentEntry({
			...override.value,
			epoch: top + 1,
			decidedAtMs: override.nowMs,
			decidedBy: override.decidedBy,
			members: newest?.members,
		}),
		"complete",
	);
}

export async function proposeMembership(
	register: AssignmentRegister,
	change: Readonly<{
		pin?: readonly MemberName[];
		add?: MemberName;
		remove?: MemberName;
		expectedEpoch: number;
		decidedBy: string;
		nowMs: number;
	}>,
): Promise<AssignmentProposalOutcome> {
	const asked = [change.pin, change.add, change.remove].filter(
		(part) => part !== undefined,
	);
	if (asked.length !== 1)
		invalid("a membership change is exactly one of pin, add, remove", "change");
	const prepared = await prepare(register, change.expectedEpoch);
	if (!prepared.ok) return prepared.outcome;
	const { current, resolution } = prepared;
	const stale: AssignmentProposalOutcome = { status: "stale", resolution };
	if (current === undefined) return stale;
	let reason: string;
	let members: MemberName[];
	if (change.pin !== undefined) {
		if (current.members !== undefined) return stale;
		reason = PIN_REASON;
		members = sortedSet(change.pin);
	} else {
		if (current.members === undefined) return stale;
		if (change.add !== undefined) {
			if (current.members.includes(change.add)) return stale;
			reason = `${ADMIT}${change.add}`;
			members = sortedSet([...current.members, change.add]);
		} else {
			const removed = change.remove;
			if (
				removed === undefined ||
				!current.members.includes(removed) ||
				current.members.length === 1 ||
				removed === current.active ||
				removed === current.target
			)
				return stale;
			reason = `${REMOVE}${removed}`;
			members = current.members.filter((name) => name !== removed);
		}
	}
	const entry = nextEntry(
		current,
		{
			active: current.active,
			sealed: current.sealed,
			target: current.target,
			reason,
			lossWindowMs: undefined,
		},
		members,
		change.decidedBy,
		change.nowMs,
	);
	await repairLogs(register, prepared.replies, current.epoch);
	return place(register, entry, "propose", answeredOf(prepared.replies));
}
