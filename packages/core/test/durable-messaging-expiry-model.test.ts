import { describe, expect, it } from "vitest";

type State = {
	time: number;
	dlqAvailable: boolean;
	settled: boolean;
	dlqWrites: number;
	nextLeased: boolean;
	compacted: boolean;
	auditTail: number;
	auditFloor: number;
	allocated: number[];
	reused: boolean;
};
type Action =
	| "tick"
	| "fail-dlq"
	| "restore-dlq"
	| "sweep"
	| "compact"
	| "append"
	| "retain"
	| "restart";
type Mutation =
	| "split-dlq"
	| "partial-next-lease"
	| "premature-compaction"
	| "reuse-audit-sequence";
const actions: readonly Action[] = [
	"tick",
	"fail-dlq",
	"restore-dlq",
	"sweep",
	"compact",
	"append",
	"retain",
	"restart",
];

function step(input: State, action: Action, mutation?: Mutation): State {
	const state = structuredClone(input);
	if (action === "tick" && state.time < 2) state.time++;
	else if (action === "fail-dlq") state.dlqAvailable = false;
	else if (action === "restore-dlq") state.dlqAvailable = true;
	else if (action === "sweep" && state.time >= 1 && !state.settled) {
		if (state.dlqAvailable) {
			state.settled = true;
			if (mutation !== "split-dlq") state.dlqWrites++;
			state.nextLeased = true;
		} else if (mutation === "partial-next-lease") state.nextLeased = true;
	} else if (
		action === "compact" &&
		(state.settled || mutation === "premature-compaction")
	)
		state.compacted = true;
	else if (action === "append" && state.auditTail < 3) {
		const next =
			mutation === "reuse-audit-sequence" && state.auditFloor > 1
				? state.auditFloor - 1
				: state.auditTail + 1;
		state.reused ||= state.allocated.includes(next);
		state.auditTail = next;
		state.allocated.push(next);
	} else if (action === "retain" && state.auditTail > 0)
		state.auditFloor = state.auditTail + 1;
	return state;
}

function violation(state: State): string | undefined {
	if (state.settled !== (state.dlqWrites === 1))
		return "DLQ transfer is not atomic";
	if (state.nextLeased && !state.settled)
		return "failed DLQ transfer granted a partial lease";
	if (state.compacted && !state.settled)
		return "compaction discarded a pending expiry";
	if (state.reused) return "audit sequence was reused";
	return undefined;
}

function explore(
	mutation?: Mutation,
): { trace: Action[]; reason: string } | undefined {
	const initial: State = {
		time: 0,
		dlqAvailable: true,
		settled: false,
		dlqWrites: 0,
		nextLeased: false,
		compacted: false,
		auditTail: 0,
		auditFloor: 1,
		allocated: [],
		reused: false,
	};
	const queue: Array<{ state: State; trace: Action[] }> = [
		{ state: initial, trace: [] },
	];
	const seen = new Set<string>();
	for (let index = 0; index < queue.length; index++) {
		const item = queue[index];
		if (item === undefined) break;
		const key = JSON.stringify(item.state);
		if (seen.has(key)) continue;
		seen.add(key);
		const reason = violation(item.state);
		if (reason !== undefined) return { trace: item.trace, reason };
		if (item.trace.length >= 8) continue;
		for (const action of actions)
			queue.push({
				state: step(item.state, action, mutation),
				trace: [...item.trace, action],
			});
	}
	return undefined;
}

describe("bounded expiry-driven DLQ and audit model", () => {
	it("preserves pending obligations, atomic transfer and audit identity across restart", () => {
		expect(explore()).toBeUndefined();
	});
	it.each([
		["split-dlq", "DLQ transfer is not atomic"],
		["partial-next-lease", "failed DLQ transfer granted a partial lease"],
		["premature-compaction", "compaction discarded a pending expiry"],
		["reuse-audit-sequence", "audit sequence was reused"],
	] as const)("finds a counterexample when %s", (mutation, reason) => {
		const result = explore(mutation);
		expect(result?.reason).toBe(reason);
		expect(result?.trace.length).toBeGreaterThan(0);
	});
});
