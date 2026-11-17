import { describe, expect, it } from "vitest";

// A finite protocol model, independent of any provider implementation. One
// tenant has two competing workers, two groups, a two-attempt source message,
// one DLQ and at most two message incarnations. The clock never goes backwards;
// a transaction and its receipt are atomic, and the host fences prior owners.
type Lease = { sequence: number; token: number; expires: number };
type Group = {
	status: "pending" | "acked" | "dead";
	attempts: number;
	leases: Lease[];
};
type State = {
	time: number;
	sequence: number;
	retained: boolean;
	groups: [Group, Group];
	firstLease?: Lease;
	dlqWrites: [number, number];
	deadCommitted: [boolean, boolean];
	opCommitted: boolean;
	receipt: boolean;
	reply: "none" | "unknown" | "committed" | "expired" | "rejected";
	last: "other" | "retry";
	staleMutation: boolean;
	crashed: boolean;
};
type Mutation =
	| "duplicate-lease"
	| "stale-ack"
	| "split-dead-letter"
	| "forget-receipt"
	| "ignore-expiry"
	| "unsafe-compaction"
	| "reuse-lease-without-sequence";
type Action =
	| "claim-a"
	| "claim-b"
	| "ack-current-a"
	| "ack-old-a"
	| "ack-b"
	| "nack-a"
	| "tick"
	| "crash"
	| "retry"
	| "compact"
	| "republish";

const ACTIONS: readonly Action[] = [
	"claim-a",
	"claim-b",
	"ack-current-a",
	"ack-old-a",
	"ack-b",
	"nack-a",
	"tick",
	"crash",
	"retry",
	"compact",
	"republish",
];
const initial = (): State => ({
	time: 0,
	sequence: 1,
	retained: true,
	groups: [
		{ status: "pending", attempts: 0, leases: [] },
		{ status: "pending", attempts: 0, leases: [] },
	],
	dlqWrites: [0, 0],
	deadCommitted: [false, false],
	opCommitted: false,
	receipt: false,
	reply: "none",
	last: "other",
	staleMutation: false,
	crashed: false,
});
const live = (state: State, group: Group) =>
	group.leases.filter((lease) => lease.expires > state.time);

function step(input: State, action: Action, mutation?: Mutation): State {
	const state = structuredClone(input);
	state.last = "other";
	const a = state.groups[0];
	const b = state.groups[1];
	if (action === "tick" && state.time < 3) {
		state.time++;
		if (state.time >= 2) state.receipt = false;
	} else if (action === "crash") {
		// Durable state survives; the response may be lost during a restart.
		state.crashed = true;
		if (state.opCommitted) state.reply = "unknown";
	} else if (action === "claim-a" || action === "claim-b") {
		const group = action === "claim-a" ? a : b;
		const active = live(state, group);
		if (
			state.retained &&
			group.status === "pending" &&
			group.attempts < 2 &&
			(active.length === 0 || mutation === "duplicate-lease")
		) {
			group.attempts++;
			const lease = {
				sequence: state.sequence,
				token:
					mutation === "reuse-lease-without-sequence"
						? group.attempts
						: state.sequence * 10 + group.attempts,
				expires: state.time + 1,
			};
			group.leases = [...active, lease];
			if (action === "claim-a" && state.firstLease === undefined)
				state.firstLease = lease;
		}
	} else if (
		action === "ack-current-a" ||
		action === "ack-old-a" ||
		action === "ack-b"
	) {
		const group = action === "ack-b" ? b : a;
		const lease =
			action === "ack-old-a" ? state.firstLease : live(state, group)[0];
		if (lease !== undefined && group.status === "pending") {
			const valid = live(state, group).some(
				(current) =>
					current.sequence === lease.sequence && current.token === lease.token,
			);
			const forged =
				mutation === "stale-ack" ||
				(mutation === "reuse-lease-without-sequence" &&
					live(state, group).some((current) => current.token === lease.token));
			if (valid || forged) {
				if (!valid) state.staleMutation = true;
				group.status = "acked";
				group.leases = [];
				if (group === a && state.sequence === 1) {
					state.opCommitted = true;
					state.receipt = mutation !== "forget-receipt";
					state.reply = "unknown";
				}
			}
		}
	} else if (action === "nack-a") {
		const lease = live(state, a)[0];
		if (lease !== undefined && a.status === "pending") {
			a.leases = [];
			if (a.attempts === 2) {
				a.status = "dead";
				const index = state.sequence - 1;
				if (index === 0 || index === 1) {
					state.deadCommitted[index] = true;
					if (mutation !== "split-dead-letter") state.dlqWrites[index]++;
				}
				if (state.sequence === 1) {
					state.opCommitted = true;
					state.receipt = mutation !== "forget-receipt";
					state.reply = "unknown";
				}
			}
		}
	} else if (action === "retry") {
		state.last = "retry";
		if (state.time >= 2 && mutation !== "ignore-expiry")
			state.reply = "expired";
		else if (state.receipt) state.reply = "committed";
		else if (state.opCommitted) state.reply = "rejected";
	} else if (action === "compact") {
		if (
			state.retained &&
			((a.status !== "pending" && b.status !== "pending") ||
				mutation === "unsafe-compaction")
		)
			state.retained = false;
	} else if (
		action === "republish" &&
		!state.retained &&
		state.sequence === 1
	) {
		state.sequence = 2;
		state.retained = true;
		state.groups = [
			{ status: "pending", attempts: 0, leases: [] },
			{ status: "pending", attempts: 0, leases: [] },
		];
	}
	return state;
}

function violation(state: State): string | undefined {
	if (state.groups.some((group) => live(state, group).length > 1))
		return "overlapping group leases";
	if (state.staleMutation) return "stale lease changed a delivery";
	if (
		state.deadCommitted.some(
			(done, index) => done !== (state.dlqWrites[index] === 1),
		)
	)
		return "dead-letter transfer was not atomic";
	if (
		!state.retained &&
		state.groups.some((group) => group.status === "pending")
	)
		return "compaction discarded an unsettled delivery";
	if (state.time < 2 && state.opCommitted && !state.receipt)
		return "committed operation lost its live receipt";
	if (state.last === "retry" && state.opCommitted && state.reply === "rejected")
		return "committed operation was reported rejected";
	if (state.last === "retry" && state.time >= 2 && state.reply !== "expired")
		return "expired operation produced a definite result";
	return undefined;
}

function explore(
	mutation?: Mutation,
): { trace: Action[]; reason: string } | undefined {
	const queue: Array<{ state: State; trace: Action[] }> = [
		{ state: initial(), trace: [] },
	];
	const seen = new Set<string>();
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const item = queue[cursor];
		if (item === undefined) break;
		const key = JSON.stringify(item.state);
		if (seen.has(key)) continue;
		seen.add(key);
		const reason = violation(item.state);
		if (reason !== undefined) return { trace: item.trace, reason };
		if (item.trace.length >= 10) continue;
		for (const action of ACTIONS)
			queue.push({
				state: step(item.state, action, mutation),
				trace: [...item.trace, action],
			});
	}
	return undefined;
}

describe("bounded durable messaging state model", () => {
	it("preserves leases, receipts, DLQ atomicity and compaction across bounded interleavings", () => {
		expect(explore()).toBeUndefined();
	});

	it.each([
		["duplicate-lease", "overlapping group leases"],
		["stale-ack", "stale lease changed a delivery"],
		["split-dead-letter", "dead-letter transfer was not atomic"],
		["forget-receipt", "committed operation lost its live receipt"],
		["ignore-expiry", "expired operation produced a definite result"],
		["unsafe-compaction", "compaction discarded an unsettled delivery"],
		["reuse-lease-without-sequence", "stale lease changed a delivery"],
	] as const)("finds a counterexample without %s", (mutation, expected) => {
		const counterexample = explore(mutation);
		expect(counterexample?.reason).toBe(expected);
		expect(counterexample?.trace.length).toBeGreaterThan(0);
	});
});
