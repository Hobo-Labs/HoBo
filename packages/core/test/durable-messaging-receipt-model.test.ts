import { describe, expect, it } from "vitest";

// One operation ID has two possible fingerprints and two delayed callers.
// Eligibility checks and final writes are serialized, with an explicit
// in-flight transaction that can finish after expiry. Its receipt and effect
// commit atomically. Time is monotonic and crashes preserve the journal.
// This finite model does not prove a provider implements those assumptions.
type Fingerprint = "a" | "b";
type Receipt = { fingerprint: Fingerprint; outcome: "committed" | "rejected" };
type State = {
	time: number;
	allowed: boolean;
	available: boolean;
	pending: Fingerprint[];
	inFlight?: Receipt & { startedExpired: boolean };
	receipt?: Receipt;
	effects: Fingerprint[];
	rejected: Fingerprint[];
	expiredStartCommitted: boolean;
};
type Mutation = "forget-rejection" | "ignore-fingerprint" | "ignore-expiry";
type Action =
	| "send-a"
	| "send-b"
	| "run"
	| "commit"
	| "collect"
	| "deny"
	| "allow"
	| "offline"
	| "online"
	| "tick"
	| "crash";
const actions: readonly Action[] = [
	"send-a",
	"send-b",
	"run",
	"commit",
	"collect",
	"deny",
	"allow",
	"offline",
	"online",
	"tick",
	"crash",
];

function step(input: State, action: Action, mutation?: Mutation): State {
	const state = structuredClone(input);
	if (action === "send-a" || action === "send-b") {
		if (state.pending.length < 2)
			state.pending.push(action === "send-a" ? "a" : "b");
	} else if (action === "deny") state.allowed = false;
	else if (action === "allow") state.allowed = true;
	else if (action === "offline") state.available = false;
	else if (action === "online") state.available = true;
	else if (action === "tick" && state.time < 2) {
		state.time++;
	} else if (action === "collect" && state.time >= 2) delete state.receipt;
	else if (action === "run" && state.inFlight === undefined) {
		const fingerprint = state.pending.shift();
		if (fingerprint === undefined || !state.available) return state; // unknown
		if (state.time >= 2 && mutation !== "ignore-expiry") return state; // expired
		if (state.receipt !== undefined) {
			if (
				state.receipt.fingerprint === fingerprint ||
				mutation !== "ignore-fingerprint"
			)
				return state;
		}
		state.inFlight = {
			fingerprint,
			outcome: state.allowed ? "committed" : "rejected",
			startedExpired: state.time >= 2,
		};
	} else if (action === "commit" && state.inFlight !== undefined) {
		const { fingerprint, outcome, startedExpired } = state.inFlight;
		delete state.inFlight;
		state.expiredStartCommitted ||= startedExpired;
		if (outcome === "rejected") state.rejected.push(fingerprint);
		else state.effects.push(fingerprint);
		if (outcome !== "rejected" || mutation !== "forget-rejection")
			state.receipt = { fingerprint, outcome };
	}
	// A crash loses no durable receipt and does not revive fenced owners.
	return state;
}

function violation(state: State): string | undefined {
	if (state.expiredStartCommitted)
		return "expired attempt entered a transaction";
	if (state.effects.some((fingerprint) => state.rejected.includes(fingerprint)))
		return "rejected operation later committed";
	if (state.effects.length > 1) return "one operation ID committed twice";
	return undefined;
}

function explore(
	mutation?: Mutation,
): { trace: Action[]; reason: string } | undefined {
	const initial: State = {
		time: 0,
		allowed: true,
		available: true,
		pending: [],
		effects: [],
		rejected: [],
		expiredStartCommitted: false,
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

describe("bounded durable messaging receipt interleavings", () => {
	it("fences delayed duplicates, conflicting fingerprints, expiry and crashes", () => {
		expect(explore()).toBeUndefined();
	});
	it("permits a checked transaction to commit after expiry and then collect its receipt", () => {
		let state: State = {
			time: 0,
			allowed: true,
			available: true,
			pending: [],
			effects: [],
			rejected: [],
			expiredStartCommitted: false,
		};
		for (const action of ["send-a", "run", "tick", "tick", "commit"] as const)
			state = step(state, action);
		expect(state.effects).toEqual(["a"]);
		expect(state.receipt?.outcome).toBe("committed");
		expect(state.expiredStartCommitted).toBe(false);
		state = step(state, "collect");
		expect(state.receipt).toBeUndefined();
		expect(state.effects).toEqual(["a"]);
	});
	it.each([
		["forget-rejection", "rejected operation later committed"],
		["ignore-fingerprint", "one operation ID committed twice"],
		["ignore-expiry", "expired attempt entered a transaction"],
	] as const)("finds a counterexample when %s", (mutation, reason) => {
		const result = explore(mutation);
		expect(result?.reason).toBe(reason);
		expect(result?.trace.length).toBeGreaterThan(0);
	});
});
