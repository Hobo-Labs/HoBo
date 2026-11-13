/**
 * The assignment register: which member of a one-active fleet is active.
 *
 * Moved from `packages/backend-fleet/src/assignment.ts` (62dbc5d4c) with the
 * names of design §7.3, plus membership epochs (§6.10).
 *
 * Every member keeps a small append-only log. A log entry names the active
 * member (the writer) for one **epoch**. An epoch is **decided** when a
 * majority of its **deciding set** hold the same entry for it, and the
 * **current assignment** is the highest decided epoch. Three local rules are
 * all the safety there is:
 *
 * 1. A member holds at most one entry per epoch.
 * 2. A member takes an entry for epoch `e` only when its highest entry is
 *    `e - 1`, checked and written atomically on that member.
 * 3. An entry that names a member as the writer is written to that member
 *    first, and to no other member if it does not take it.
 *
 * From 1 and 2, two different entries can never both reach a majority for one
 * epoch, and a proposal made on a stale view lands only on members that were
 * behind, which are a minority. From 3, a member's own log always contains
 * every decided entry that makes it the writer, so a check made on one member
 * alone is enough to refuse overwriting it.
 *
 * **The deciding set.** An entry without `members` (every entry written before
 * a fleet turns membership epochs on) is decided by the configured members, as
 * before. Once a fleet has decided a member set (the `pin-members` entry), the
 * set that decides epoch `e` is the `members` of decided epoch `e - 1`, which a
 * reader derives from entry `e` alone (`decidingSet`). A membership entry
 * changes exactly one name, so two consecutive deciding sets differ by at most
 * one name and any two of their majorities intersect: the argument above still
 * holds across a membership change.
 *
 * A reader needs answers from a majority. With fewer, or when the highest
 * epoch it can see is not decided, the answer is not a guess at the previous
 * writer: it is `no-majority` or `undecided`, and a caller stops.
 *
 * Nothing here knows an engine. A replica is anything that can `read` its log
 * and `accept` one entry under rules 1 and 2: a SQL table
 * (`sqlAssignmentReplica` in `@hobo/data-postgres`) or one key of a cache
 * (`ephemeralAssignmentReplica`, `replica.ts`).
 */
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

/** The first epoch. An empty log takes this epoch and no other. */
export const FIRST_ASSIGNMENT_EPOCH = 1;
export const ASSIGNMENT_ACCEPT_OUTCOMES = [
	"accepted",
	"duplicate",
	"conflict",
	"gap",
	"busy",
] as const;

/** The reason a pin entry carries (§6.10 item 2). */
const PIN_REASON = "pin-members";
const ADMIT = "admit:";
const REMOVE = "remove:";
const REASON = /^[a-z0-9][a-z0-9:._ -]{0,199}$/u;
const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/u;

function invalid(message: string, field: string): never {
	throw new FleetParseError(field, message);
}

/** The classifier a register uses when its host gives none. */
const unclassifiedFailure: FailureClassifier = () => Health.UNKNOWN;

/** Sorted, without repeats. */
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

/** `admit:<name>` or `remove:<name>`, or undefined for any other reason. */
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

/**
 * Parse an assignment entry. After this, a sealed entry always has a target
 * other than its writer, an unsealed entry never has one, every number is a
 * non-negative safe integer, and a member set is sorted, non-empty and
 * consistent with a membership reason.
 */
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

/** Identity of an entry. Two entries are the same decision when keys match. */
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
	// An entry without members keeps today's key, so stored logs compare as before.
	if (entry.members !== undefined) key.push(entry.members);
	return JSON.stringify(key);
}

/** How many members make a majority of `count`. */
export function fleetMajority(count: number): number {
	if (!Number.isSafeInteger(count) || count < 1)
		invalid("a fleet needs at least one member", "members");
	return Math.floor(count / 2) + 1;
}

/**
 * The set that decides `entry`: its `members`, without the name it admits or
 * with the name it removes. Undefined for an entry without members, which the
 * configured members decide.
 */
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

/** Who decides `entry`, given who is configured. */
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

/** Holders of `contender` that count towards deciding it. */
function decidingHolders(
	contender: AssignmentContender,
	configured: readonly MemberName[],
): number {
	const deciders = decidersOf(contender.assignment, configured);
	return contender.holders.filter((holder) => deciders.includes(holder)).length;
}

/**
 * Decide what a set of replies proves. Pure: no clock, no I/O.
 *
 * `members` is who was asked; a reply from anyone else is ignored. The
 * majority is counted over the deciding set of the newest entry seen, or over
 * `members` for an entry without one; a member of the deciding set that was
 * not asked counts as silent. `current` is returned only for the highest epoch
 * seen, and only when a majority of its deciding set hold the same entry for
 * it. An entry held by fewer is never treated as the answer, and neither is the
 * decided epoch below it: something newer may already be decided out of sight.
 */
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
	options: Readonly<{ classify?: FailureClassifier }> = {},
): AssignmentRegister {
	const ids = replicas.map((replica) => parseMemberName(replica.id));
	if (ids.length === 0 || new Set(ids).size !== ids.length)
		invalid("a fleet needs at least one member and no repeated id", "members");
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
 * waiting for a member that is slow or gone: a newest entry held by a majority
 * of its deciding set is decided whatever the rest would say, and no decided
 * epoch above it can exist without one of those members holding it.
 */
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

/**
 * Write one entry: to the member it names as writer first, then to the rest
 * in configured order.
 *
 * A proposer stops at the first member that holds a different entry for the
 * epoch, because somebody else's proposal got there first; stopping leaves the
 * remaining members free, so a contested epoch can still be settled. Completion
 * does not stop: it offers the entry it chose to every member that can take it.
 */
async function place(
	register: AssignmentRegister,
	entry: AssignmentEntry,
	mode: "propose" | "complete",
): Promise<AssignmentProposalOutcome> {
	const deciders = decidersOf(entry, idsOf(register));
	const required = fleetMajority(deciders.length);
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
	}
	for (const replica of register.replicas) {
		if (replica === writer) continue;
		const outcome = await offer(replica, entry);
		if (outcome === "accepted" || outcome === "duplicate")
			holders.push(replica.id);
		else if (outcome === "conflict" && mode === "propose") break;
	}
	const counted = holders.filter((holder) => deciders.includes(holder)).length;
	return {
		status: counted >= required ? "decided" : "undecided",
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

/** Read, and check the caller's expected epoch against the current one. */
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

/** The entry after `current`, carrying `members` and stamped by the register. */
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

/**
 * Propose the next assignment, as a compare-and-set on the current epoch.
 *
 * The proposer never decides on older information: if the newest epoch it can
 * see is not decided it returns `unavailable` and writes nothing. Only
 * `decided` means the entry is the current assignment. Any other outcome means
 * "read again"; an `undecided` entry may still be completed by someone else.
 * The entry carries the current entry's member set, if it has one.
 */
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
	return place(register, entry, "propose");
}

/**
 * The first assignment of a fleet with empty logs.
 *
 * The entry is the same bytes no matter who writes it, so any number of
 * instances starting at once agree instead of splitting the first epoch.
 */
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
		const outcome = await place(register, contender.assignment, "complete");
		if (outcome.status === "decided") break;
	}
	return resolveAssignment(members, await readAssignmentReplies(register));
}

/**
 * Operator override. Writes a new epoch above everything visible, whatever the
 * current epoch is or whether it is decided.
 *
 * This is the only way to break a split epoch and the only way to promote a
 * standby beyond the recovery point objective. It skips the compare-and-set on
 * purpose, so it belongs to a person, never to a scheduled job. It still needs
 * a majority to answer and still writes to the named writer first. It carries
 * the member set of the most widely held newest entry.
 */
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

/**
 * Change the member set by one decided epoch (§6.10 item 2). Exactly one of
 * `pin`, `add`, `remove`.
 *
 * - `pin` writes the sorted configured set after a decided entry that has none.
 * - `add` admits one name to the decided entry's set; `remove` removes one.
 *   Both refuse (`stale`) when that entry has no set, when the change is a
 *   no-op, or when it would remove the active member, a sealed fleet's
 *   target or the last member.
 *
 * The entry copies the active, sealed and target values of its predecessor
 * and is decided by the predecessor's set (or, for the pin, the configured
 * one). The same compare-and-set on `expectedEpoch` as `proposeAssignment`.
 */
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
	return place(register, entry, "propose");
}
