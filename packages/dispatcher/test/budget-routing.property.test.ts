import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createDispatcherRegistry,
	createReservationLedger,
	decideAndReserveDispatch,
	decideDispatch,
	replayDispatchDecision,
} from "../src/dispatcher.js";

const NOW = "2026-07-01T00:00:00.000Z";
const EXPIRY = "2026-07-02T00:00:00.000Z";
const LATER = "2026-07-03T00:00:00.000Z";
const DIMENSION = "runner.minutes";
const CHECK = { seed: 614435, numRuns: 300 };

const candidateArb = fc.record({
	price: fc.integer({ min: 0, max: 8 }),
	free: fc.integer({ min: 0, max: 6 }),
	rate: fc.integer({ min: 0, max: 8 }),
	concurrency: fc.integer({ min: 0, max: 3 }),
	spent: fc.integer({ min: 0, max: 10 }),
	held: fc.integer({ min: 0, max: 10 }),
	headroom: fc.integer({ min: 0, max: 20 }),
});

function oneProvider(price: number, cap: number, spent: number) {
	return {
		registry: createDispatcherRegistry([
			{ providerId: "p", category: "runner", listUnitCost: price },
		]),
		ledgerView: {
			view: "CreditLedgerView" as const,
			seq: 0,
			asOf: NOW,
			accounts: [
				{
					providerId: "p",
					dimension: DIMENSION,
					currency: "USD",
					listUnitCost: price,
					freeHeadroom: 0,
					budgetCap: cap,
					spendToDate: spent,
				},
			],
		},
	};
}

describe("budget-aware dispatch properties", () => {
	it("selects a minimum-cost eligible provider and replays independently of registry order", () => {
		fc.assert(
			fc.property(
				fc.array(candidateArb, { minLength: 1, maxLength: 5 }),
				fc.integer({ min: 1, max: 6 }),
				(candidates, units) => {
					const providers = candidates.map((c, index) => ({
						providerId: `p${index}`,
						category: "runner" as const,
						listUnitCost: c.price,
					}));
					const accounts = candidates.map((c, index) => ({
						providerId: `p${index}`,
						dimension: DIMENSION,
						listUnitCost: c.price,
						freeHeadroom: c.free,
						rateHeadroom: c.rate,
						concurrencyHeadroom: c.concurrency,
						budgetCap: c.spent + c.held + c.headroom,
						spendToDate: c.spent,
						reservedCost: c.held,
					}));
					const eligible = candidates
						.map((c, index) => ({
							id: `p${index}`,
							cost: Math.max(0, units - c.free) * c.price,
							allowed:
								c.concurrency > 0 &&
								units <= c.rate &&
								Math.max(0, units - c.free) * c.price <= c.headroom,
						}))
						.filter((c) => c.allowed);
					const request = {
						category: "runner",
						dispatchId: "property",
						units,
						ledgerView: {
							view: "CreditLedgerView",
							seq: 7,
							asOf: NOW,
							accounts,
						},
					};
					const result = decideDispatch({
						...request,
						registry: createDispatcherRegistry(providers),
					});
					if (eligible.length === 0) {
						expect(result.ok).toBe(false);
						expect(result.dispatchEvent).toBeUndefined();
						return;
					}
					expect(result.ok).toBe(true);
					if (!result.ok) return;
					const winner = eligible.find((c) => c.id === result.selectedProvider);
					expect(winner).toBeDefined();
					expect(winner?.cost).toBe(Math.min(...eligible.map((c) => c.cost)));
					expect(result.dispatchEvent.data.ledgerInput.seq).toBe(7);
					const reversed = decideDispatch({
						...request,
						registry: createDispatcherRegistry([...providers].reverse()),
					});
					expect(reversed.dispatchEvent).toEqual(result.dispatchEvent);
					expect(
						replayDispatchDecision(result.replayInput).dispatchEvent,
					).toEqual(result.dispatchEvent);
				},
			),
			CHECK,
		);
	});

	it("admits exact-cent spending that fits the remaining hard budget", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 2_000 }),
				fc.integer({ min: 1, max: 1_999 }),
				(capCents, rawSpent) => {
					const spentCents = 1 + (rawSpent % (capCents - 1));
					const price = (capCents - spentCents) / 100;
					const input = oneProvider(price, capCents / 100, spentCents / 100);
					const result = decideDispatch({
						...input,
						category: "runner",
						dispatchId: "exact-budget",
						units: 1,
					});
					expect(result.ok, `cap=${capCents}¢, spent=${spentCents}¢`).toBe(
						true,
					);
				},
			),
			CHECK,
		);
	});

	it("admits a charge that fits when exact decimals match but number rounding differed", () => {
		const price = 1.1;
		const units = 0.1111111111111111;
		const spent = 0.12345678901234566;
		const cap = 0.24567901123456787;
		const input = oneProvider(price, cap, spent);
		const result = decideDispatch({
			...input,
			category: "runner",
			dispatchId: "decimal-boundary",
			units,
		});
		expect(result.ok).toBe(true);
		const ledger = createReservationLedger(input.ledgerView);
		expect(
			ledger.reserve({
				providerId: "p",
				dimension: DIMENSION,
				reservationId: "decimal-boundary",
				units,
				expectedSeq: 0,
			}).ok,
		).toBe(true);
	});

	it("does not authorize a positive paid charge against a zero budget", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 4 }), (multiple) => {
				const price = multiple * 1e-13;
				const input = oneProvider(price, 0, 0);
				const result = decideDispatch({
					...input,
					category: "runner",
					dispatchId: "positive-charge",
					units: 1,
				});
				const ledger = createReservationLedger(input.ledgerView);
				const reserved = ledger.reserve({
					providerId: "p",
					dimension: DIMENSION,
					reservationId: "positive-charge",
					units: 1,
					expectedSeq: 0,
				});
				expect(result.ok, `positive unit price=${price}`).toBe(false);
				expect(reserved.ok, `positive unit price=${price}`).toBe(false);
			}),
			CHECK,
		);
	});

	it("matches integer decimal arithmetic for very small paid charges", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 0, max: 300 }),
				fc.integer({ min: 1, max: 5 }),
				(cap, rawSpent, price, units) => {
					const spent = rawSpent % (cap + 1);
					const amount = (value: number) => Number(`${value}e-15`);
					const input = oneProvider(amount(price), amount(cap), amount(spent));
					const fits = spent + price * units <= cap;
					const decision = decideDispatch({
						...input,
						category: "runner",
						dispatchId: "small-exact",
						units,
					});
					const ledger = createReservationLedger(input.ledgerView);
					const reservation = ledger.reserve({
						providerId: "p",
						dimension: DIMENSION,
						reservationId: "small-exact",
						units,
						expectedSeq: 0,
					});
					expect(decision.ok).toBe(fits);
					expect(reservation.ok).toBe(fits);
					if (fits)
						expect(ledger.snapshot().accounts[0].reservedCost).toBe(
							amount(price * units),
						);
				},
			),
			CHECK,
		);
	});

	it("retains sub-precision charges until release or final settlement", () => {
		const price = 1e-13;
		const input = oneProvider(price, 2e-13, 0);
		const ledger = createReservationLedger(input.ledgerView);
		const reserve = (reservationId: string) =>
			ledger.reserve({
				providerId: "p",
				dimension: DIMENSION,
				reservationId,
				units: 1,
				expectedSeq: ledger.snapshot().seq,
			});
		expect(reserve("first").ok).toBe(true);
		expect(reserve("second").ok).toBe(true);
		expect(ledger.snapshot().accounts[0].reservedCost).toBe(2e-13);
		expect(reserve("over-budget").ok).toBe(false);
		expect(ledger.release({ reservationId: "first" }).ok).toBe(true);
		expect(ledger.snapshot().accounts[0].reservedCost).toBe(price);
		expect(
			ledger.confirm({ reservationId: "second", actualCost: price }).ok,
		).toBe(true);
		expect(ledger.snapshot().accounts[0]).toMatchObject({
			reservedCost: 0,
			spendToDate: price,
		});
	});

	it("does not round a slightly unaffordable price down to the cap", () => {
		const input = oneProvider(0.2000000000001, 0.2, 0);
		expect(
			decideDispatch({
				...input,
				category: "runner",
				dispatchId: "over-cap",
				units: 1,
			}).ok,
		).toBe(false);
		const ledger = createReservationLedger(input.ledgerView);
		expect(
			ledger.reserve({
				providerId: "p",
				dimension: DIMENSION,
				reservationId: "over-cap",
				units: 1,
				expectedSeq: 0,
			}).ok,
		).toBe(false);
	});

	it("admits an exactly affordable fractional-unit charge", () => {
		const input = oneProvider(0.2, 0.02, 0);
		expect(
			decideDispatch({
				...input,
				category: "runner",
				dispatchId: "fractional",
				units: 0.1,
			}).ok,
		).toBe(true);
		const ledger = createReservationLedger(input.ledgerView);
		expect(
			ledger.reserve({
				providerId: "p",
				dimension: DIMENSION,
				reservationId: "fractional",
				units: 0.1,
				expectedSeq: 0,
			}).ok,
		).toBe(true);
		expect(ledger.snapshot().accounts[0].reservedCost).toBe(0.02);
	});

	it("reports the decimal budget boundary correctly after partial settlement", () => {
		const input = oneProvider(0.1, 0.3, 0);
		const ledger = createReservationLedger(input.ledgerView);
		expect(
			ledger.reserve({
				providerId: "p",
				dimension: DIMENSION,
				reservationId: "first",
				units: 1,
				expectedSeq: 0,
				unitCost: 0.1,
			}).ok,
		).toBe(true);
		expect(
			ledger.reserve({
				providerId: "p",
				dimension: DIMENSION,
				reservationId: "second",
				units: 1,
				expectedSeq: 1,
				unitCost: 0.2,
			}).ok,
		).toBe(true);
		const settled = ledger.confirm({ reservationId: "first", actualCost: 0.1 });
		expect(settled.ok).toBe(true);
		if (!settled.ok) throw new Error("fixture settlement failed");
		expect(settled.budgetExceeded).toBe(false);
		expect(settled.ledgerView.accounts[0]).toMatchObject({
			spendToDate: 0.1,
			reservedCost: 0.2,
		});
	});

	it("applies the supplied reservation unit price instead of a lower account list price", () => {
		const ledger = createReservationLedger(
			oneProvider(0.1, 0.15, 0).ledgerView,
		);
		const result = ledger.reserve({
			providerId: "p",
			dimension: DIMENSION,
			reservationId: "quoted-price",
			units: 1,
			expectedSeq: 0,
			unitCost: 0.2,
		});
		expect(result.ok).toBe(false);
		expect(ledger.snapshot().accounts[0].reservedCost ?? 0).toBe(0);
	});

	it("reserves the same account price used to select a provider", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000 }),
				fc.integer({ min: 0, max: 1_000 }),
				(accountCents, registryCents) => {
					const accountPrice = accountCents / 100;
					const { ledgerView } = oneProvider(accountPrice, accountPrice, 0);
					const registry = createDispatcherRegistry([
						{
							providerId: "p",
							category: "runner",
							listUnitCost: registryCents / 100,
						},
					]);
					const reservationLedger = createReservationLedger(ledgerView);
					const result = decideAndReserveDispatch({
						registry,
						reservationLedger,
						category: "runner",
						dispatchId: "account-price",
						units: 1,
					});
					expect(result.ok).toBe(true);
					expect(result.reservation?.reservation?.reservedCost).toBe(
						accountPrice,
					);
				},
			),
			CHECK,
		);
	});

	it("ranks distinct sub-precision total costs before other tie breakers", () => {
		const registry = createDispatcherRegistry([
			{
				providerId: "a",
				category: "runner",
				listUnitCost: 0.001,
				switchingCost: 1e-13,
			},
			{
				providerId: "b",
				category: "runner",
				listUnitCost: 0.002,
				switchingCost: 0,
			},
		]);
		const ledgerView = {
			view: "CreditLedgerView",
			seq: 0,
			accounts: [
				{
					providerId: "a",
					dimension: DIMENSION,
					listUnitCost: 0.001,
					freeHeadroom: 1,
					budgetCap: 1,
				},
				{
					providerId: "b",
					dimension: DIMENSION,
					listUnitCost: 0.002,
					freeHeadroom: 1,
					budgetCap: 1,
				},
			],
		};
		const result = decideDispatch({
			registry,
			ledgerView,
			category: "runner",
			dispatchId: "small-ranking",
			units: 1,
			incumbentProviderId: "other",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("fixture decision failed");
		expect(result.selectedProvider).toBe("b");
	});

	it("consumes and restores a fractional free allowance below quantity rounding precision", () => {
		const input = oneProvider(1, 0, 0);
		input.ledgerView.accounts[0].freeHeadroom = 1e-10;
		const ledger = createReservationLedger(input.ledgerView);
		const reserve = (reservationId: string) =>
			ledger.reserve({
				providerId: "p",
				dimension: DIMENSION,
				reservationId,
				units: 1e-10,
				expectedSeq: ledger.snapshot().seq,
			});
		expect(reserve("first").ok).toBe(true);
		expect(ledger.snapshot().accounts[0].freeHeadroom).toBe(0);
		expect(reserve("second").ok).toBe(false);
		expect(ledger.release({ reservationId: "first" }).ok).toBe(true);
		expect(ledger.snapshot().accounts[0].freeHeadroom).toBe(1e-10);
		expect(reserve("third").ok).toBe(true);
	});

	it("does not create free allowance while reserving a tiny fractional quantity", () => {
		const input = oneProvider(1, 0, 0);
		input.ledgerView.accounts[0].freeHeadroom = 5.1e-10;
		const ledger = createReservationLedger(input.ledgerView);
		expect(
			ledger.reserve({
				providerId: "p",
				dimension: DIMENSION,
				reservationId: "tiny",
				units: 1e-10,
				expectedSeq: 0,
			}).ok,
		).toBe(true);
		expect(ledger.snapshot().accounts[0].freeHeadroom).toBe(4.1e-10);
	});

	it("conserves fractional grants and rate headroom through release", () => {
		const input = oneProvider(1, 0, 0);
		Object.assign(input.ledgerView.accounts[0], {
			freeHeadroom: 4e-10,
			rateHeadroom: 4e-10,
			credits: [
				{ creditId: "a", freeHeadroom: 2e-10 },
				{ creditId: "b", freeHeadroom: 2e-10 },
			],
		});
		const ledger = createReservationLedger(input.ledgerView);
		const result = ledger.reserve({
			providerId: "p",
			dimension: DIMENSION,
			reservationId: "fractional-grants",
			units: 3e-10,
			expectedSeq: 0,
		});
		expect(result.ok).toBe(true);
		expect(ledger.snapshot().accounts[0]).toMatchObject({
			freeHeadroom: 1e-10,
			rateHeadroom: 1e-10,
			reservedUnits: 3e-10,
			credits: [
				{ creditId: "a", freeHeadroom: 0 },
				{ creditId: "b", freeHeadroom: 1e-10 },
			],
		});
		expect(ledger.release({ reservationId: "fractional-grants" }).ok).toBe(
			true,
		);
		expect(ledger.snapshot().accounts[0]).toMatchObject({
			freeHeadroom: 4e-10,
			rateHeadroom: 4e-10,
			reservedUnits: 0,
			credits: [
				{ creditId: "a", freeHeadroom: 2e-10 },
				{ creditId: "b", freeHeadroom: 2e-10 },
			],
		});
	});
});

const actionArb = fc.record({
	kind: fc.constantFrom(
		"reserve",
		"stale",
		"start",
		"release",
		"confirm",
		"unfinalized",
		"expire",
	),
	id: fc.constantFrom("a", "b", "c", "d"),
	units: fc.integer({ min: 1, max: 4 }),
	actual: fc.integer({ min: 0, max: 10 }),
});

describe("budget reservation histories", () => {
	it("conserves holds, free credits, and runner slots across generated retries and lifecycle steps", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 60 }),
				fc.integer({ min: 0, max: 8 }),
				fc.integer({ min: 1, max: 5 }),
				fc.array(actionArb, { minLength: 1, maxLength: 35 }),
				(cap, initialFree, price, actions) => {
					const input = oneProvider(price, cap, 0);
					input.ledgerView.accounts[0].freeHeadroom = initialFree;
					Object.assign(input.ledgerView.accounts[0], {
						rateHeadroom: 30,
						concurrencyHeadroom: 3,
					});
					const ledger = createReservationLedger(input.ledgerView);
					for (const action of actions) {
						const before = ledger.snapshot();
						const existing = before.reservations?.find(
							(r) => r.reservationId === action.id,
						);
						if (action.kind === "reserve" || action.kind === "stale") {
							const result = ledger.reserve({
								providerId: "p",
								dimension: DIMENSION,
								reservationId: action.id,
								units: action.units,
								expectedSeq:
									action.kind === "stale" && before.seq > 0
										? before.seq - 1
										: before.seq,
								expiresAt: EXPIRY,
							});
							if (action.kind === "stale" && before.seq > 0 && !existing)
								expect(result.ok).toBe(false);
						} else if (action.kind === "start") {
							ledger.start({ reservationId: action.id });
						} else if (action.kind === "release") {
							const result = ledger.release({ reservationId: action.id });
							if (existing?.status === "running") expect(result.ok).toBe(false);
						} else if (action.kind === "confirm") {
							const amount = Math.min(
								action.actual,
								existing?.reservedCost ?? 0,
							);
							ledger.confirm({
								reservationId: action.id,
								actualCost: amount,
								usageFinalized: true,
								usageEvidenceRef: "evidence:final",
							});
						} else if (action.kind === "unfinalized") {
							const result = ledger.confirm({
								reservationId: action.id,
								actualCost: 0,
							});
							if (existing?.status === "running") {
								expect(result.status).toBe("usage-not-final");
								expect(ledger.snapshot()).toEqual(before);
							}
						} else {
							ledger.expire({ now: LATER });
						}

						const after = ledger.snapshot();
						const account = after.accounts[0];
						const reservations = after.reservations ?? [];
						const active = reservations.filter((r) =>
							["pending", "running"].includes(r.status),
						);
						const consumed = reservations.filter((r) =>
							["pending", "running", "confirmed"].includes(r.status),
						);
						expect(after.seq).toBeGreaterThanOrEqual(before.seq);
						expect(account.reservedCost ?? 0).toBe(
							active.reduce((sum, r) => sum + (r.reservedCost ?? 0), 0),
						);
						expect(account.reservedUnits ?? 0).toBe(
							active.reduce((sum, r) => sum + r.units, 0),
						);
						expect(
							(account.spendToDate ?? 0) + (account.reservedCost ?? 0),
						).toBeLessThanOrEqual(cap);
						expect(account.concurrencyHeadroom).toBe(3 - active.length);
						expect(account.freeHeadroom).toBe(
							initialFree -
								consumed.reduce(
									(sum, r) => sum + (r.consumption?.freeHeadroom ?? 0),
									0,
								),
						);
					}
				},
			),
			CHECK,
		);
	});
});
