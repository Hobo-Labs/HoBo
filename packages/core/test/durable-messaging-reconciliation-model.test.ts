import { describe, expect, it } from "vitest";

// One pre-expiry transaction may finish after the operation expires. The host
// can fence/drain it before using absence as evidence. This model assumes a
// trusted fence really prevents later commits; it does not implement one.
type State = {
	time: 0 | 1;
	transaction: "idle" | "checked" | "aborted" | "committed";
	receiptPresent: boolean;
	absenceObserved: boolean;
	conflictObserved: boolean;
	replacement: boolean;
};
type Action =
	| "begin"
	| "expire"
	| "observe"
	| "conflict"
	| "drain"
	| "replace"
	| "commit"
	| "collect";
const actions: readonly Action[] = [
	"begin",
	"expire",
	"observe",
	"conflict",
	"drain",
	"replace",
	"commit",
	"collect",
];

function step(
	input: State,
	action: Action,
	mutation: "none" | "absence" | "conflict",
): State {
	const state = { ...input };
	if (action === "begin" && state.time === 0 && state.transaction === "idle")
		state.transaction = "checked";
	else if (action === "expire") state.time = 1;
	else if (
		action === "observe" &&
		state.time === 1 &&
		!state.receiptPresent &&
		state.transaction !== "committed"
	)
		state.absenceObserved = true;
	else if (action === "conflict" && state.transaction === "checked")
		state.conflictObserved = true;
	else if (
		action === "drain" &&
		state.time === 1 &&
		state.transaction === "checked"
	)
		state.transaction = "aborted";
	else if (
		action === "replace" &&
		state.time === 1 &&
		((state.absenceObserved &&
			(state.transaction === "idle" ||
				state.transaction === "aborted" ||
				mutation === "absence")) ||
			(mutation === "conflict" && state.conflictObserved))
	)
		state.replacement = true;
	else if (action === "commit" && state.transaction === "checked") {
		state.transaction = "committed";
		state.receiptPresent = true;
	} else if (action === "collect" && state.time === 1)
		state.receiptPresent = false;
	return state;
}

function explore(
	mutation: "none" | "absence" | "conflict",
): Action[] | undefined {
	const initial: State = {
		time: 0,
		transaction: "idle",
		receiptPresent: false,
		absenceObserved: false,
		conflictObserved: false,
		replacement: false,
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
		if (item.state.replacement && item.state.transaction === "committed")
			return item.trace;
		if (item.trace.length >= 7) continue;
		for (const action of actions)
			queue.push({
				state: step(item.state, action, mutation),
				trace: [...item.trace, action],
			});
	}
	return undefined;
}

describe("bounded reconciliation after operation expiry", () => {
	it("requires an active pre-expiry attempt to be fenced and drained before replacement", () => {
		expect(explore("none")).toBeUndefined();
	});
	it("finds the delayed commit if empty point-in-time state is accepted as final", () => {
		const trace = explore("absence");
		expect(trace).toBeDefined();
		expect(trace).toContain("observe");
		expect(trace).toContain("commit");
		expect(trace?.indexOf("commit")).toBeGreaterThan(
			trace?.indexOf("observe") ?? -1,
		);
	});
	it("finds the delayed commit if a conflicting fingerprint is mistaken for an original rejection", () => {
		const trace = explore("conflict");
		expect(trace).toContain("conflict");
		expect(trace).toContain("commit");
		expect(trace).toContain("replace");
	});
});
