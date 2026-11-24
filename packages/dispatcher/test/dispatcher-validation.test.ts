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

describe("parseCreditLedgerView wire boundary", () => {
	it("clones a well-formed view and rejects malformed discriminators or sequences", () => {
		const input = ledgerView({ accounts: [account("a")] });
		const parsed = parseCreditLedgerView(input);
		expect(parsed.seq).toBe(91);
		expect(parsed).not.toBe(input);
		expect(parsed.accounts).not.toBe(input.accounts);
		expect(parseCreditLedgerView(ledgerView({ seq: 0 })).seq).toBe(0);
		expect(() =>
			parseCreditLedgerView(ledgerView({ view: "SomethingElse" })),
		).toThrow(/must be CreditLedgerView/u);
		expect(() => parseCreditLedgerView(ledgerView({ seq: -1 }))).toThrow(
			/non-negative integer/u,
		);
	});
});

describe("createDispatcherRegistry", () => {
	it("indexes only registered providers by category", () => {
		const registry = createDispatcherRegistry([
			runner("a"),
			runner("b", { registered: false }),
		]);
		expect(registry.records).toHaveLength(2);
		expect(registry.byCategory.get("runner")).toHaveLength(1);
		expect(registry.schema).toMatch(/\.registry$/u);
	});
});

describe("decideDispatch decision record", () => {
	it("fails cleanly with empty ranking when no registered candidates exist", () => {
		const decision = dispatch({
			registry: createDispatcherRegistry([runner("a", { registered: false })]),
		});
		expect(decision.ok).toBe(false);
		expect(decision.ranking).toEqual([]);
		expect(decision.reason).toMatch(/no registered runner candidates/u);
	});

	it("pins ledger sequence, balance hash, reservation id, and candidate rationales without aliasing input", () => {
		const input = ledgerView({ accounts: [account("a"), account("b")] });
		const decision = dispatch({
			registry: createDispatcherRegistry([runner("a"), runner("b")]),
			ledgerView: input,
		});
		expect(decision.ok).toBe(true);
		expect(decision.objective).toBe("maximize-credits");
		expect(decision.dispatchEvent.data.ledgerInput.seq).toBe(91);
		expect(decision.dispatchEvent.data.ledgerInput.balanceHash).toMatch(
			/^sha256:/u,
		);
		expect(decision.dispatchEvent.data.ledgerInput.reservationId).toBe(
			"reservation-intent-d1",
		);
		expect(decision.dispatchEvent.data.candidates).toHaveLength(2);
		expect(decision.dispatchEvent.data.candidates[0]?.rationale).toBeTruthy();
		expect(decision.replayInput.ledgerView).not.toBe(input);
	});
});

describe("stableHash and canonicalJson", () => {
	it("produces order-independent object digests while preserving array order", () => {
		expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
		expect(stableHash({ o: { a: 1, b: 2 } })).toBe(
			stableHash({ o: { b: 2, a: 1 } }),
		);
		expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
		expect(stableHash({})).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
	});
});

describe("createReservationLedger", () => {
	it("rejects malformed views and reports releasing an absent reservation as false", () => {
		expect(() => createReservationLedger({ view: "wrong" })).toThrow(TypeError);
		const ledger = createReservationLedger(ledgerView());
		const result = ledger.cancelReservation?.({ reservationId: "absent" });
		if (result) expect(result.ok).toBe(false);
	});
});
