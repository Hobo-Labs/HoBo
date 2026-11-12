import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	type PairVerdict,
	type PlanResolution,
	type QueueEntry,
	type QueuePlan,
	QueuePlanSchema,
	type QueuePolicy,
	type QueueSnapshot,
	QueueSnapshotSchema,
} from "./_generated/agent_pb.js";

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

declare const observed: unique symbol;
/** A queue observation whose entries are unique, well-formed and in provider order. */
export type ObservedQueue = QueueSnapshot & { readonly [observed]: true };

/**
 * Build a snapshot from a provider's answer. Entries are sorted by provider
 * position and renumbered from zero; a dependency on a pull request that is
 * not in the snapshot has already merged or left, and is dropped.
 */
export function observeQueue(
	init: Parameters<typeof create<typeof QueueSnapshotSchema>>[1],
): ObservedQueue {
	const snapshot = create(QueueSnapshotSchema, init);
	const numbers = new Set(snapshot.entries.map((entry) => entry.number));
	if (
		!REPOSITORY.test(snapshot.repository) ||
		!SHA.test(snapshot.baseSha) ||
		!snapshot.baseRef ||
		!Number.isFinite(Date.parse(snapshot.observedAt)) ||
		numbers.size !== snapshot.entries.length ||
		snapshot.entries.some(
			(entry) =>
				entry.number < 1 ||
				!SHA.test(entry.headSha) ||
				!entry.headRef ||
				!Number.isFinite(Date.parse(entry.enqueuedAt)),
		)
	)
		throw new Error("invalid queue snapshot");
	snapshot.entries.sort(
		(a, b) => a.position - b.position || a.number - b.number,
	);
	snapshot.entries.forEach((entry, position) => {
		entry.position = position;
		entry.dependsOn = entry.dependsOn.filter(
			(parent) => parent !== entry.number && numbers.has(parent),
		);
	});
	// SAFETY: every invariant named by the brand was checked or established above.
	return Object.freeze(snapshot) as ObservedQueue;
}

/** How two entries relate, and the paths they conflict on when that is known. */
export type PairRelation = Readonly<{
	verdict: "clean" | "conflict" | "unknown";
	paths: readonly string[];
}>;

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * How two entries relate. A verdict from a trial merge wins. Without one,
 * entries that touch no common path are taken as clean, and anything else is
 * unknown, which the planner treats as a conflict rather than batch on a guess.
 */
export function createVerdicts(verdicts: readonly PairVerdict[]) {
	const known = new Map(
		verdicts.map((verdict) => [
			pairKey(verdict.first, verdict.second),
			verdict,
		]),
	);
	return function verdictOf(a: QueueEntry, b: QueueEntry): PairRelation {
		const found = known.get(pairKey(a.number, b.number));
		if (found?.verdict === "clean" || found?.verdict === "conflict")
			return { verdict: found.verdict, paths: found.paths };
		const theirs = new Set(b.changedPaths);
		const disjoint =
			a.changedPaths.length > 0 &&
			b.changedPaths.length > 0 &&
			!a.changedPaths.some((path) => theirs.has(path));
		return { verdict: disjoint ? "clean" : "unknown", paths: [] };
	};
}

/** Pairs worth a trial merge: both sides changed at least one common path. */
export function overlappingPairs(
	entries: readonly QueueEntry[],
): readonly (readonly [QueueEntry, QueueEntry])[] {
	const pairs: [QueueEntry, QueueEntry][] = [];
	entries.forEach((a, index) => {
		const paths = new Set(a.changedPaths);
		for (const b of entries.slice(index + 1))
			if (
				a.changedPaths.length === 0 ||
				b.changedPaths.length === 0 ||
				b.changedPaths.some((path) => paths.has(path))
			)
				pairs.push([a, b]);
	});
	return pairs;
}

/**
 * Plan the merge order.
 *
 * Fixed: an entry whose checks have started stays where it is, a stacked
 * entry follows its parents, and an entry that has waited `maxWaitMinutes`
 * is taken before any younger one. Within those limits a priority label
 * comes first, then the entry that conflicts with the fewest other movable
 * entries, then the oldest. An entry that conflicts with many others
 * therefore goes last and is resolved once against everything ahead of it,
 * not once per neighbour.
 *
 * The result is a pure function of its inputs: the same snapshot, verdicts
 * and policy always give the same plan and the same digest.
 */
export function planQueue(input: {
	snapshot: ObservedQueue;
	verdicts: readonly PairVerdict[];
	/** Entries that do not merge onto the base branch, with the conflicted paths. */
	baseConflicts: ReadonlyMap<number, readonly string[]>;
	policy: QueuePolicy;
	/**
	 * Entries the merge queue ejected at their current commit. Each is
	 * batched alone, so a failure that may be its own cannot fail others.
	 */
	isolated?: ReadonlySet<number>;
}): QueuePlan {
	const { snapshot, policy } = input;
	const entries = snapshot.entries.slice(0, policy.maxDepth);
	const verdictOf = createVerdicts(input.verdicts);
	const isolated = input.isolated ?? new Set<number>();
	const conflicts = (a: QueueEntry, b: QueueEntry) =>
		verdictOf(a, b).verdict !== "clean";
	const nowMs = Date.parse(snapshot.observedAt);
	const lane = (entry: QueueEntry) => {
		const index = policy.priorityLabels.findIndex((label) =>
			entry.labels.includes(label),
		);
		return index < 0 ? policy.priorityLabels.length : index;
	};
	const aged = (entry: QueueEntry) =>
		nowMs - Date.parse(entry.enqueuedAt) >= policy.maxWaitMinutes * 60_000;
	const fifo = (a: QueueEntry, b: QueueEntry) =>
		Date.parse(a.enqueuedAt) - Date.parse(b.enqueuedAt) || a.number - b.number;

	const order = entries.filter((entry) => entry.started);
	let waiting = entries.filter((entry) => !entry.started);
	// Counted over everything still movable, once: a neighbour already placed
	// ahead is still a conflict this entry has to be resolved against.
	const degrees = new Map(
		waiting.map((entry) => [
			entry,
			waiting.filter((other) => other !== entry && conflicts(entry, other))
				.length,
		]),
	);
	const degree = (entry: QueueEntry) => degrees.get(entry) ?? 0;
	while (waiting.length > 0) {
		const placed = new Set(order.map((entry) => entry.number));
		const within = new Set(entries.map((entry) => entry.number));
		const ready = waiting.filter((entry) =>
			entry.dependsOn.every(
				(parent) => placed.has(parent) || !within.has(parent),
			),
		);
		// A dependency cycle is bad data, not a reason to drop work: fall back to FIFO.
		const candidates = ready.length > 0 ? ready : waiting;
		const chosen = [...candidates].sort(
			(a, b) =>
				Number(aged(b)) - Number(aged(a)) ||
				lane(a) - lane(b) ||
				(aged(a) ? 0 : degree(a) - degree(b)) ||
				fifo(a, b),
		)[0];
		if (!chosen) break;
		order.push(chosen);
		waiting = waiting.filter((entry) => entry !== chosen);
	}

	const batches: QueueEntry[][] = [];
	for (const entry of order) {
		const batch = batches.at(-1);
		if (
			batch &&
			batch.length < policy.maxBatchSize &&
			!input.baseConflicts.has(entry.number) &&
			!isolated.has(entry.number) &&
			batch.every((member) => !isolated.has(member.number)) &&
			batch.every(
				(member) =>
					!input.baseConflicts.has(member.number) && !conflicts(member, entry),
			)
		)
			batch.push(entry);
		else batches.push([entry]);
	}

	const resolutions: Pick<PlanResolution, "number" | "against" | "paths">[] =
		[];
	order.forEach((entry, index) => {
		const base = input.baseConflicts.get(entry.number);
		if (base)
			resolutions.push({ number: entry.number, against: [], paths: [...base] });
		const ahead = order
			.slice(0, index)
			.map((other) => ({ other, ...verdictOf(other, entry) }))
			.filter((pair) => pair.verdict === "conflict");
		if (ahead.length > 0)
			resolutions.push({
				number: entry.number,
				against: ahead.map((pair) => pair.other.number),
				paths: [...new Set(ahead.flatMap((pair) => pair.paths))].sort(),
			});
	});

	const unstarted = entries.filter((entry) => !entry.started);
	const planned = order.filter((entry) => !entry.started);
	const plan = {
		repository: snapshot.repository,
		baseSha: snapshot.baseSha,
		order: order.map((entry) => entry.number),
		batches: batches.map((batch) => ({
			numbers: batch.map((entry) => entry.number),
		})),
		resolutions,
		moved: planned
			.filter((entry, index) => unstarted[index] !== entry)
			.map((entry) => entry.number),
	};
	const digest = createHash("sha256")
		.update(
			JSON.stringify([
				plan,
				entries.map((entry) => [entry.number, entry.headSha]),
			]),
		)
		.digest("hex");
	return create(QueuePlanSchema, { ...plan, digest });
}
