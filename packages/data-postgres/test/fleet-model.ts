/**
 * An in-memory fleet for interleaving tests.
 *
 * Every replica operation is two scheduler steps: one before it takes effect
 * and one before its answer is delivered. A seeded scheduler releases one
 * waiting step at a time, so a run explores one interleaving of concurrent
 * proposers, and the same seed explores the same one again. A replica that
 * goes down between the two steps has applied the write and lost the answer,
 * which is the case a real network produces.
 */
import {
	type AssignmentAcceptOutcome,
	type AssignmentReplica,
	assignmentKey,
	fleetMajority,
	type PostgresFleetAssignment,
} from "../src/index.js";

export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}

export class Scheduler {
	readonly random: () => number;
	private readonly waiting: (() => void)[] = [];
	steps = 0;

	constructor(seed: number) {
		this.random = seededRandom(seed);
	}

	pick(bound: number): number {
		return Math.floor(this.random() * bound);
	}

	pause(): Promise<void> {
		return new Promise((resolve) => {
			this.waiting.push(resolve);
		});
	}

	/** Release waiting steps in seeded order until every task has settled. */
	async drive(
		tasks: readonly Promise<void>[],
		afterStep: () => void,
	): Promise<void> {
		let settled = false;
		const all = Promise.all(tasks).then(() => {
			settled = true;
		});
		while (!settled) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (this.waiting.length === 0) continue;
			const [release] = this.waiting.splice(this.pick(this.waiting.length), 1);
			release?.();
			this.steps += 1;
			await new Promise<void>((resolve) => setImmediate(resolve));
			afterStep();
		}
		await all;
	}
}

export class MemoryReplica implements AssignmentReplica {
	readonly rows: PostgresFleetAssignment[] = [];
	up = true;
	busy = false;

	constructor(
		readonly id: string,
		private readonly pause: () => Promise<void> = () => Promise.resolve(),
	) {}

	private requireUp(): void {
		if (!this.up) throw new Error("connection refused");
	}

	async read(limit?: number): Promise<readonly PostgresFleetAssignment[]> {
		await this.pause();
		this.requireUp();
		const snapshot = [...this.rows];
		await this.pause();
		this.requireUp();
		return limit === undefined ? snapshot : snapshot.slice(-limit);
	}

	/** The single-statement rule of the SQL replica, applied atomically. */
	apply(assignment: PostgresFleetAssignment): AssignmentAcceptOutcome {
		if (this.busy) return "busy";
		const top = this.rows.at(-1)?.epoch ?? 0;
		if (top === assignment.epoch - 1) {
			this.rows.push(assignment);
			return "accepted";
		}
		const held = this.rows.find((row) => row.epoch === assignment.epoch);
		if (held === undefined) return "gap";
		return assignmentKey(held) === assignmentKey(assignment)
			? "duplicate"
			: "conflict";
	}

	async accept(
		assignment: PostgresFleetAssignment,
	): Promise<AssignmentAcceptOutcome> {
		await this.pause();
		this.requireUp();
		const outcome = this.apply(assignment);
		await this.pause();
		this.requireUp();
		return outcome;
	}
}

/** What is decided, seen from outside: every replica, up or down. */
export function decidedEntries(
	replicas: readonly MemoryReplica[],
): Map<number, PostgresFleetAssignment> {
	const required = fleetMajority(replicas.length);
	const counts = new Map<
		string,
		{ assignment: PostgresFleetAssignment; count: number }
	>();
	for (const replica of replicas)
		for (const row of replica.rows) {
			const key = assignmentKey(row);
			const entry = counts.get(key) ?? { assignment: row, count: 0 };
			entry.count += 1;
			counts.set(key, entry);
		}
	const decided = new Map<number, PostgresFleetAssignment>();
	for (const { assignment, count } of counts.values())
		if (count >= required) {
			if (decided.has(assignment.epoch))
				throw new Error(`two entries decided for epoch ${assignment.epoch}`);
			decided.set(assignment.epoch, assignment);
		}
	return decided;
}

export function highestDecided(replicas: readonly MemoryReplica[]): number {
	return Math.max(0, ...decidedEntries(replicas).keys());
}
