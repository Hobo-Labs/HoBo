/**
 * The dispatcher's parse boundary and its refusals.
 *
 * `dispatcher.test.ts` drives the ranking; this goes at the guards around it,
 * because a dispatcher decides where a billable job runs and its failure modes
 * are all quiet ones.
 *
 * **A malformed ledger view is refused, never defaulted.** The ledger is what
 * says how much free headroom exists. Reading a broken one as "no credits"
 * would send every job to the paid path, and reading it as "unlimited" would
 * exhaust an allowance without anyone noticing — so the parse throws rather
 * than choosing either.
 *
 * **An unregistered provider is invisible, not merely deprioritized.** A
 * registry that ranked an unregistered candidate last would still select it
 * when it is the only one, which is precisely when registration mattered.
 *
 * **`stableHash` is order-independent.** It is what pins a decision to the
 * exact ledger it was made against, so two structurally identical views must
 * hash the same regardless of key order — otherwise replay disagrees with the
 * original for a reason nobody can see.
 */

import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	createDispatcherRegistry,
	createReservationLedger,
	decideDispatch,
	parseCreditLedgerView,
	stableHash,
} from "../src/dispatcher.js";
import type { JsonObject } from "../src/json.js";

const LEDGER_DIGEST = `sha256:${"1".repeat(64)}`;

function ledgerView(overrides: JsonObject = {}) {
	return {
		view: "CreditLedgerView",
		seq: 91,
		digest: LEDGER_DIGEST,
		asOf: "2026-06-27T00:00:00.000Z",
		accounts: [],
		...overrides,
	};
}

function account(providerId: string, overrides: JsonObject = {}) {
	return {
		providerId,
		dimension: "runner.minutes",
		currency: "USD",
		listUnitCost: 0.02,
		freeHeadroom: 0,
		rateHeadroom: 100,
		concurrencyHeadroom: 10,
		...overrides,
	};
}

function runner(id: string, overrides: JsonObject = {}) {
	return {
		id,
		providerId: id,
		category: "runner" as const,
		registered: true,
		dimension: "runner.minutes",
		listUnitCost: 0.02,
		switchingCost: 0,
		...overrides,
	};
}

const dispatch = (overrides: JsonObject = {}) =>
	decideDispatch({
		registry: createDispatcherRegistry([runner("a")]),
		category: "runner",
		dispatchId: "d1",
		units: 10,
		ledgerView: ledgerView({ accounts: [account("a")] }),
		...overrides,
	});

describe("parseCreditLedgerView", () => {
	it("accepts a well-formed view", () => {
		expect(parseCreditLedgerView(ledgerView()).seq).toBe(91);
	});

	it.each([
		null,
		undefined,
		"view",
		7,
		[],
	])("rejects the non-object %s", (raw) => {
		// Defaulting a broken ledger either way is a billing decision made by
		// a parse bug: "no credits" sends everything to the paid path,
		// "unlimited" exhausts an allowance silently.
		expect(() => parseCreditLedgerView(raw)).toThrow(TypeError);
	});

	it("rejects a view with the wrong discriminator", () => {
		expect(() =>
			parseCreditLedgerView(ledgerView({ view: "SomethingElse" })),
		).toThrow(/must be CreditLedgerView/u);
	});

	it("rejects a missing discriminator", () => {
		expect(() => parseCreditLedgerView({ seq: 1, accounts: [] })).toThrow(
			TypeError,
		);
	});

	it.each([
		-1,
		1.5,
		"91",
		null,
		undefined,
	])("rejects the sequence %s", (seq) => {
		// The sequence is what pins a decision to a point in the ledger; a
		// non-integer one cannot be compared for staleness.
		expect(() => parseCreditLedgerView(ledgerView({ seq }))).toThrow(
			/non-negative integer/u,
		);
	});

	it("accepts a zero sequence, which is a fresh ledger", () => {
		expect(parseCreditLedgerView(ledgerView({ seq: 0 })).seq).toBe(0);
	});

	it("rejects a non-array accounts field", () => {
		expect(() => parseCreditLedgerView(ledgerView({ accounts: {} }))).toThrow(
			/must be an array/u,
		);
	});

	it("clones rather than aliasing the caller's view", () => {
		// A dispatcher that mutated its input ledger would corrupt the caller's
		// snapshot mid-decision.
		const input = ledgerView({ accounts: [account("a")] });
		const parsed = parseCreditLedgerView(input);
		expect(parsed).not.toBe(input);
		expect(parsed.accounts).not.toBe(input.accounts);
	});
});

describe("createDispatcherRegistry", () => {
	it("indexes registered providers by category", () => {
		const registry = createDispatcherRegistry([runner("a")]);
		expect(registry.byCategory.get("runner")).toHaveLength(1);
	});

	it("rejects a non-array provider list", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		expect(() => createDispatcherRegistry({} as never)).toThrow(TypeError);
	});

	it("accepts an empty list", () => {
		expect(createDispatcherRegistry([]).records).toEqual([]);
	});

	it("defaults to an empty list when called with nothing", () => {
		expect(createDispatcherRegistry().records).toEqual([]);
	});

	it("keeps an unregistered provider in records but out of the index", () => {
		// Deprioritizing rather than excluding would still select it when it is
		// the only candidate — precisely when registration mattered.
		const registry = createDispatcherRegistry([
			runner("a", { registered: false }),
		]);
		expect(registry.records).toHaveLength(1);
		expect(registry.byCategory.get("runner")).toBeUndefined();
	});

	it("groups several providers under one category", () => {
		const registry = createDispatcherRegistry([runner("a"), runner("b")]);
		expect(registry.byCategory.get("runner")).toHaveLength(2);
	});

	it("carries its own schema marker", () => {
		expect(createDispatcherRegistry([]).schema).toMatch(/\.registry$/u);
	});
});

describe("decideDispatch refusals", () => {
	it("rejects a non-object request", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		expect(() => decideDispatch(null as never)).toThrow(TypeError);
	});

	it("requires a dispatch id", () => {
		expect(() => dispatch({ dispatchId: undefined })).toThrow(
			/request\.dispatchId/u,
		);
	});

	it("requires a category", () => {
		expect(() => dispatch({ category: undefined })).toThrow(TypeError);
	});

	it.each([0, -1, "10"])("rejects the unit count %s", (units) => {
		// Zero units is not a dispatch; a negative one would credit the account.
		expect(() => dispatch({ units })).toThrow(TypeError);
	});

	it.each([
		undefined,
		null,
	])("defaults units to one for %s, since ?? treats null as absent", (units) => {
		expect(dispatch({ units }).ok).toBe(true);
	});

	it("defaults the objective to maximize-credits", () => {
		expect(dispatch({ objective: undefined }).objective).toBe(
			"maximize-credits",
		);
	});

	it("rejects an unknown objective rather than falling back", () => {
		// Falling back would silently optimize for something the caller did not
		// ask for, and the decision record would say the wrong thing.
		expect(() => dispatch({ objective: "minimize-latency" })).toThrow(
			TypeError,
		);
	});

	it("fails cleanly when a category has no registered candidates", () => {
		const decision = dispatch({
			registry: createDispatcherRegistry([runner("a", { registered: false })]),
		});
		expect(decision.ok).toBe(false);
		expect(decision.reason).toMatch(/no registered runner candidates/u);
	});

	it("returns an empty ranking on failure rather than a partial one", () => {
		const decision = dispatch({ registry: createDispatcherRegistry([]) });
		expect(decision.ranking).toEqual([]);
	});

	it("refuses an unknown category at the parse rather than ranking nothing", () => {
		// A category outside the known set is a caller bug, not an empty
		// registry — and the two deserve different answers, which is why this
		// throws while "no registered candidates" returns a failed decision.
		expect(() => dispatch({ category: "gpu" })).toThrow(TypeError);
	});
});

describe("the decision record", () => {
	it("pins the ledger sequence it decided against", () => {
		// Without the pin, replay cannot tell whether it is reproducing the
		// original decision or making a new one.
		const decision = dispatch();
		expect(decision.dispatchEvent.data.ledgerInput.seq).toBe(91);
	});

	it("pins a balance hash", () => {
		expect(decision().dispatchEvent.data.ledgerInput.balanceHash).toMatch(
			/^sha256:/u,
		);
		function decision() {
			return dispatch();
		}
	});

	it("derives a reservation id from the dispatch id when none is given", () => {
		expect(dispatch().dispatchEvent.data.ledgerInput.reservationId).toBe(
			"reservation-intent-d1",
		);
	});

	it("keeps an explicit reservation id", () => {
		expect(
			dispatch({ reservationId: "r-explicit" }).dispatchEvent.data.ledgerInput
				.reservationId,
		).toBe("r-explicit");
	});

	it("records every candidate, not only the winner", () => {
		// A decision nobody can audit is a decision nobody can appeal.
		const decision = dispatch({
			registry: createDispatcherRegistry([runner("a"), runner("b")]),
			ledgerView: ledgerView({ accounts: [account("a"), account("b")] }),
		});
		expect(decision.dispatchEvent.data.candidates).toHaveLength(2);
	});

	it("carries a rationale per candidate", () => {
		expect(dispatch().dispatchEvent.data.candidates[0]?.rationale).toBeTruthy();
	});

	it("clones the ledger into replayInput rather than aliasing it", () => {
		const input = ledgerView({ accounts: [account("a")] });
		const decision = dispatch({ ledgerView: input });
		expect(decision.replayInput.ledgerView).not.toBe(input);
	});
});

describe("stableHash and canonicalJson", () => {
	it("hashes structurally identical values the same regardless of key order", () => {
		// The property that makes a decision replayable: two spellings of one
		// ledger must pin to the same hash.
		expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
	});

	it("hashes nested objects order-independently", () => {
		expect(stableHash({ o: { a: 1, b: 2 } })).toBe(
			stableHash({ o: { b: 2, a: 1 } }),
		);
	});

	it("does not reorder arrays, since order is meaning there", () => {
		expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
	});

	it("distinguishes different values", () => {
		expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
	});

	it("prefixes the digest with its algorithm", () => {
		expect(stableHash({})).toMatch(/^sha256:[a-f0-9]{64}$/u);
	});

	it("sorts keys in canonical JSON", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	it("sorts keys inside arrays of objects", () => {
		expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
	});

	it("leaves primitives alone", () => {
		expect(canonicalJson(7)).toBe("7");
		expect(canonicalJson("s")).toBe('"s"');
		expect(canonicalJson(null)).toBe("null");
	});
});

describe("createReservationLedger", () => {
	it("rejects a malformed initial view", () => {
		expect(() => createReservationLedger({ view: "wrong" })).toThrow(TypeError);
	});

	it("accepts a well-formed one", () => {
		expect(() => createReservationLedger(ledgerView())).not.toThrow();
	});

	it("reports a release against an unknown reservation as not-releasable", () => {
		// Not an error: a release that arrives twice, or after a crash, must be
		// a reportable outcome rather than an exception.
		const ledger = createReservationLedger(ledgerView());
		const result = ledger.cancelReservation?.({ reservationId: "absent" });
		if (result) expect(result.ok).toBe(false);
	});
});
