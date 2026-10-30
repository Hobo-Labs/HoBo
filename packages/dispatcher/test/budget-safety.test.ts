import { describe, expect, it } from "vitest";
import {
	type CreditAccount,
	createDispatcherRegistry,
	createReservationLedger,
	decideAndReserveDispatch,
	decideDispatch,
	decidePlacement,
} from "../src/dispatcher.js";

const NOW = "2026-07-01T00:00:00.000Z";
const providers = createDispatcherRegistry([
	{ providerId: "cloud", category: "traffic-backend", listUnitCost: 1 },
]);
function account(overrides: Partial<CreditAccount> = {}): CreditAccount {
	return {
		providerId: "cloud",
		dimension: "traffic.requests",
		listUnitCost: 1,
		budgetCap: 10,
		spendToDate: 0,
		freeHeadroom: 0,
		...overrides,
	};
}
function snapshot(accounts: CreditAccount[] = [account()]) {
	return { view: "CreditLedgerView", seq: 0, asOf: NOW, accounts };
}
function dispatch(ledgerView = snapshot(), overrides = {}) {
	return decideDispatch({
		registry: providers,
		category: "traffic-backend",
		dispatchId: "route",
		units: 1,
		ledgerView,
		...overrides,
	});
}
function reserve(
	ledger: ReturnType<typeof createReservationLedger>,
	reservationId: string,
	overrides = {},
) {
	return ledger.reserve({
		providerId: "cloud",
		dimension: "traffic.requests",
		reservationId,
		units: 1,
		expectedSeq: ledger.snapshot().seq,
		...overrides,
	});
}

describe("hard budget admission", () => {
	it("fails dispatch and placement when every candidate exceeds the hard cap", () => {
		const ledgerView = snapshot([account({ budgetCap: 0.5 })]);
		expect(dispatch(ledgerView).ok).toBe(false);
		expect(dispatch(ledgerView).dispatchEvent).toBeUndefined();
		const placement = decidePlacement({
			resourceId: "api",
			resourceType: "api",
			units: 1,
			ledgerView,
			candidates: [
				{
					definitionId: "cloud",
					providerId: "cloud",
					resourceType: "api",
					dimension: "traffic.requests",
					listUnitCost: 1,
				},
			],
		});
		expect(placement.ok).toBe(false);
		expect(placement.matchEvent).toBeUndefined();
	});
	it("does not erase a hard cap when monetary or credit facts are invalid", () => {
		for (const invalid of [
			account({ budgetCap: -1 }),
			account({ spendToDate: Number.NaN }),
			account({ reservedCost: -1 }),
			account({ freeHeadroom: -1 }),
		]) {
			expect(dispatch(snapshot([invalid])).ok).toBe(false);
		}
	});
	it("keeps explicit concurrency and rate limits hard even for paid work", () => {
		expect(dispatch(snapshot([account({ concurrencyHeadroom: 0 })])).ok).toBe(
			false,
		);
		expect(dispatch(snapshot([account({ rateHeadroom: 0.5 })])).ok).toBe(false);
	});
});

describe("reservation financial and occupancy invariants", () => {
	it("serializes paid exposure and capacity, settles actual spend and frees concurrency", () => {
		const ledger = createReservationLedger(
			snapshot([
				account({ budgetCap: 1, concurrencyHeadroom: 1, rateHeadroom: 2 }),
			]),
		);
		expect(reserve(ledger, "one").ok).toBe(true);
		expect(reserve(ledger, "two").ok).toBe(false);
		expect(ledger.snapshot().accounts[0]).toMatchObject({
			reservedCost: 1,
			concurrencyHeadroom: 0,
			rateHeadroom: 1,
		});
		expect(ledger.confirm({ reservationId: "one", actualCost: 0.5 }).ok).toBe(
			true,
		);
		expect(ledger.snapshot().accounts[0]).toMatchObject({
			spendToDate: 0.5,
			reservedCost: 0,
			concurrencyHeadroom: 1,
			rateHeadroom: 1,
		});
		expect(reserve(ledger, "three").ok).toBe(false);
	});
	it("retries the same reservation once and rejects ID reuse with different work", () => {
		const ledger = createReservationLedger(
			snapshot([account({ freeHeadroom: 5 })]),
		);
		const first = reserve(ledger, "same", { units: 2 });
		const replay = reserve(ledger, "same", { units: 2, expectedSeq: 0 });
		expect(replay).toMatchObject({
			ok: true,
			replayed: true,
			committedSeq: first.committedSeq,
		});
		expect(ledger.snapshot().seq).toBe(1);
		expect(ledger.snapshot().accounts[0].freeHeadroom).toBe(3);
		expect(reserve(ledger, "same", { units: 3 }).status).toBe(
			"reservation-id-conflict",
		);
		ledger.release({ reservationId: "same" });
		expect(reserve(ledger, "same", { units: 2 }).ok).toBe(false);
		expect(ledger.snapshot().accounts[0].freeHeadroom).toBe(5);
	});
	it("replays the original dispatch choice after its own reservation depleted the free balance", () => {
		const ledger = createReservationLedger(
			snapshot([account({ freeHeadroom: 1 })]),
		);
		const request = {
			registry: providers,
			category: "traffic-backend",
			dispatchId: "retry",
			reservationLedger: ledger,
		};
		const first = decideAndReserveDispatch(request);
		const replay = decideAndReserveDispatch(request);
		expect(replay.dispatchEvent).toEqual(first.dispatchEvent);
		expect(replay.reservation.replayed).toBe(true);
		expect(ledger.snapshot().seq).toBe(1);
	});
	it("reserves all-in exposure and records overruns truthfully on settlement", () => {
		const ledger = createReservationLedger(
			snapshot([account({ budgetCap: 5 })]),
		);
		expect(reserve(ledger, "too-large", { estimatedCost: 6 }).ok).toBe(false);
		expect(reserve(ledger, "allowed", { estimatedCost: 4 }).ok).toBe(true);
		expect(ledger.snapshot().accounts[0].reservedCost).toBe(4);
		const settled = ledger.confirm({ reservationId: "allowed", actualCost: 7 });
		expect(settled.budgetExceeded).toBe(true);
		expect(ledger.snapshot().accounts[0].spendToDate).toBe(7);
		expect(reserve(ledger, "blocked").ok).toBe(false);
	});
	it("cannot drop an all-in estimate on the dispatch-and-reserve convenience path", () => {
		const ledger = createReservationLedger(snapshot());
		const decision = decideAndReserveDispatch({
			registry: providers,
			category: "traffic-backend",
			dispatchId: "all-in",
			estimatedCost: 11,
			reservationLedger: ledger,
		});
		expect(decision.ok).toBe(false);
		expect(ledger.snapshot().seq).toBe(0);
	});
	it("restores cancellation exposure and occupancy exactly once", () => {
		const ledger = createReservationLedger(
			snapshot([account({ concurrencyHeadroom: 1, rateHeadroom: 1 })]),
		);
		reserve(ledger, "cancel");
		ledger.release({ reservationId: "cancel" });
		ledger.release({ reservationId: "cancel" });
		expect(ledger.snapshot().accounts[0]).toMatchObject({
			reservedCost: 0,
			concurrencyHeadroom: 1,
			rateHeadroom: 1,
		});
	});
	it("retains monetary holds and replay identity when restored from a snapshot", () => {
		const ledger = createReservationLedger(
			snapshot([account({ budgetCap: 1 })]),
		);
		reserve(ledger, "persisted");
		const restored = createReservationLedger(ledger.snapshot());
		expect(reserve(restored, "later").ok).toBe(false);
		expect(reserve(restored, "persisted").replayed).toBe(true);
		expect(() =>
			createReservationLedger({
				...ledger.snapshot(),
				accounts: [account({ reservedCost: 0 })],
			}),
		).toThrow(/outstanding reservation exposure/);
	});
	it("refuses already-expired starts and never treats a missing hard-budget price as free", () => {
		const ledger = createReservationLedger(snapshot());
		expect(reserve(ledger, "expired", { expiresAt: NOW }).ok).toBe(false);
		const unpriced = createReservationLedger(
			snapshot([account({ listUnitCost: undefined })]),
		);
		expect(reserve(unpriced, "unpriced").ok).toBe(false);
	});
	it("retains running exposure across timeouts until actual usage is settled", () => {
		const ledger = createReservationLedger(
			snapshot([account({ budgetCap: 1 })]),
		);
		const held = reserve(ledger, "running", {
			expiresAt: "2026-07-02T00:00:00Z",
		});
		expect(
			ledger.start({
				reservationId: "running",
				committedSeq: held.committedSeq + 1,
			}).ok,
		).toBe(false);
		expect(
			ledger.start({
				reservationId: "running",
				committedSeq: held.committedSeq,
			}).ok,
		).toBe(true);
		expect(ledger.start({ reservationId: "running" }).replayed).toBe(true);
		expect(ledger.expire({ now: "2026-07-03T00:00:00Z" }).released).toBe(0);
		expect(ledger.release({ reservationId: "running" }).ok).toBe(false);
		expect(
			ledger.confirm({ reservationId: "running", actualCost: 0 }).status,
		).toBe("usage-not-final");
		expect(reserve(ledger, "other").ok).toBe(false);
		expect(
			ledger.confirm({
				reservationId: "running",
				actualCost: 1,
				usageFinalized: true,
				usageEvidenceRef: "provider-usage:final-1",
			}).ok,
		).toBe(true);
		expect(ledger.snapshot().accounts[0]).toMatchObject({
			reservedCost: 0,
			spendToDate: 1,
		});
	});
});

describe("credit identity, expiry and dwell", () => {
	it("counts aggregate headroom and grant breakdown once and consumes expiring grants first", () => {
		const ledger = createReservationLedger(
			snapshot([
				account({
					freeHeadroom: 5,
					credits: [
						{
							creditId: "later",
							freeHeadroom: 3,
							expiresAt: "2026-09-01T00:00:00Z",
						},
						{
							creditId: "sooner",
							freeHeadroom: 2,
							expiresAt: "2026-08-01T00:00:00Z",
						},
					],
				}),
			]),
		);
		const first = reserve(ledger, "free", { units: 3 });
		expect(first.reservation.consumption.credits).toEqual([
			{ creditId: "sooner", units: 2 },
			{ creditId: "later", units: 1 },
		]);
		expect(ledger.snapshot().accounts[0].freeHeadroom).toBe(2);
		expect(dispatch(ledger.snapshot(), { units: 3 }).ranking[0].paidUnits).toBe(
			1,
		);
	});
	it("excludes expired grants and never revives them on reservation release", () => {
		const ledger = createReservationLedger(
			snapshot([
				account({
					freeHeadroom: 2,
					credits: [
						{
							creditId: "ending",
							freeHeadroom: 2,
							expiresAt: "2026-07-04T00:00:00Z",
							windowEnd: "2026-07-02T00:00:00Z",
						},
					],
				}),
			]),
		);
		reserve(ledger, "hold");
		ledger.expire({ now: "2026-07-03T00:00:00Z" });
		ledger.release({ reservationId: "hold" });
		expect(dispatch(ledger.snapshot()).ranking[0].freeUnits).toBe(0);
	});
	it("requires sufficient sustained observations for the same challenger", () => {
		const registry = createDispatcherRegistry([
			{ providerId: "incumbent", category: "traffic-backend", listUnitCost: 2 },
			{ providerId: "cloud", category: "traffic-backend", listUnitCost: 1 },
		]);
		const hysteresis = {
			incumbentProviderId: "incumbent",
			minimumSavings: 0.5,
			dwellWindow: "PT60S",
			observedAt: NOW,
		};
		const request = { registry, incumbentProviderId: "incumbent", hysteresis };
		expect(dispatch(snapshot(), request).selectedProvider).toBe("incumbent");
		expect(
			dispatch(snapshot(), {
				...request,
				hysteresis: {
					...hysteresis,
					challengerProviderId: "cloud",
					savingsSince: "2026-06-30T23:59:30Z",
				},
			}).selectedProvider,
		).toBe("incumbent");
		expect(
			dispatch(snapshot(), {
				...request,
				hysteresis: {
					...hysteresis,
					challengerProviderId: "cloud",
					savingsSince: "2026-06-30T23:59:00Z",
				},
			}).selectedProvider,
		).toBe("cloud");
		expect(
			dispatch(snapshot(), {
				...request,
				hysteresis: { ...hysteresis, dwellWindow: "PT0S" },
			}).selectedProvider,
		).toBe("cloud");
	});
});
