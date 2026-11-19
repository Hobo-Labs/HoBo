import { describe, expect, it } from "vitest";

import {
	createDispatcherRegistry,
	createReservationLedger,
	DISPATCH_EVENTS,
	decideAndReserveDispatch,
	parseCreditLedgerView,
} from "../src/dispatcher.js";
import type { JsonValue } from "../src/json.js";
import { isJsonObject } from "../src/json.js";

const DIGEST =
	"sha256:1111111111111111111111111111111111111111111111111111111111111111";

function ledgerView(accounts: JsonValue[] = [], seq = 91) {
	return {
		view: "CreditLedgerView",
		seq,
		digest: DIGEST,
		asOf: "2026-06-27T00:00:00.000Z",
		accounts,
	};
}

function account(overrides: Record<string, JsonValue> = {}) {
	return {
		providerId: "p1",
		dimension: "runner.minutes",
		currency: "USD",
		listUnitCost: 0.02,
		freeHeadroom: 100,
		rateHeadroom: 1000,
		concurrencyHeadroom: 10,
		...overrides,
	};
}

function reserveOn(
	ledger: ReturnType<typeof createReservationLedger>,
	overrides: Record<string, JsonValue> = {},
) {
	return ledger.reserve({
		providerId: "p1",
		dimension: "runner.minutes",
		reservationId: "r-1",
		units: 10,
		expectedSeq: ledger.snapshot().seq,
		...overrides,
	});
}

describe("parseCreditLedgerView", () => {
	it("accepts a well-formed snapshot and clones it", () => {
		const input = ledgerView([account()]);
		const parsed = parseCreditLedgerView(input);
		expect(parsed.seq).toBe(91);

		expect(parsed).not.toBe(input);
		expect(parsed.accounts).not.toBe(input.accounts);
	});

	it("refuses anything that is not a CreditLedgerView object", () => {
		for (const bad of [null, undefined, 7, "view", [], ledgerView()]) {
			if (!isJsonObject(bad)) {
				expect(() => parseCreditLedgerView(bad)).toThrow(TypeError);
			}
		}

		expect(() => parseCreditLedgerView([])).toThrow(
			/must be a CreditLedgerView snapshot/u,
		);
	});

	it("refuses a snapshot whose view tag is wrong", () => {
		expect(() =>
			parseCreditLedgerView({ ...ledgerView(), view: "SomethingElse" }),
		).toThrow(/view must be CreditLedgerView/u);
	});

	it("refuses a non-integer or negative seq", () => {
		for (const seq of [-1, 1.5, Number.NaN, "91", undefined]) {
			expect(() => parseCreditLedgerView({ ...ledgerView(), seq })).toThrow(
				/seq must be a non-negative integer/u,
			);
		}
		expect(parseCreditLedgerView({ ...ledgerView(), seq: 0 }).seq).toBe(0);
	});

	it("refuses a missing or non-array accounts field", () => {
		expect(() =>
			parseCreditLedgerView({ ...ledgerView(), accounts: undefined }),
		).toThrow(/accounts must be an array/u);
		expect(() =>
			parseCreditLedgerView({ ...ledgerView(), accounts: {} }),
		).toThrow(/accounts must be an array/u);
		expect(parseCreditLedgerView(ledgerView([])).accounts).toEqual([]);
	});
});

describe("reserve", () => {
	it("commits at seq + 1 and records the reservation as pending", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		const result = reserveOn(ledger);
		expect(result.ok).toBe(true);
		expect(result.status).toBe("reserved");

		expect(result.committedSeq).toBe(92);
		expect(ledger.snapshot().seq).toBe(92);
		expect(result.reservation?.status).toBe("pending");
	});

	it("refuses a stale expectedSeq without mutating the ledger", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		const stale = reserveOn(ledger, {
			reservationId: "r-2",
			expectedSeq: 91,
		});
		expect(stale.ok).toBe(false);
		expect(stale.status).toBe("cas-conflict");
		expect(stale.actualSeq).toBe(92);
		expect(stale.expectedSeq).toBe(91);

		expect(ledger.snapshot().seq).toBe(92);
		expect(ledger.snapshot().reservations).toHaveLength(1);
	});

	it("refuses a future expectedSeq as well as a stale one", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		expect(reserveOn(ledger, { expectedSeq: 999 }).status).toBe("cas-conflict");
	});

	it("consumes free headroom from the account", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { units: 30 });

		const after = ledger.snapshot().accounts[0];
		expect(after?.freeHeadroom).toBe(70);
	});

	it("tracks reservedUnits cumulatively across reservations", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { units: 10 });
		reserveOn(ledger, {
			reservationId: "r-2",
			units: 5,
			expectedSeq: ledger.snapshot().seq,
		});

		expect(ledger.snapshot().accounts[0]?.reservedUnits).toBe(15);
	});

	it("uses grants as a breakdown of aggregate headroom, never an extra allowance", () => {
		const ledger = createReservationLedger(
			ledgerView([
				account({
					freeHeadroom: 5,
					credits: [
						{ creditId: "c1", freeHeadroom: 10 },
						{ creditId: "c2", freeHeadroom: 10 },
					],
				}),
			]),
		);
		const result = reserveOn(ledger, { units: 12 });
		expect(result.reservation?.consumption?.freeHeadroom).toBe(5);
		expect(result.reservation?.consumption?.credits).toEqual([
			{ creditId: "c1", units: 5 },
		]);

		const after = ledger.snapshot().accounts[0];
		expect(after?.freeHeadroom).toBe(0);
		expect(after?.credits?.[0]?.freeHeadroom).toBe(5);

		expect(after?.credits?.[1]?.freeHeadroom).toBe(10);
	});

	it("stops consuming grants the moment the request is satisfied", () => {
		const ledger = createReservationLedger(
			ledgerView([
				account({
					freeHeadroom: 20,
					credits: [
						{ creditId: "c1", freeHeadroom: 10 },
						{ creditId: "c2", freeHeadroom: 10 },
					],
				}),
			]),
		);
		const result = reserveOn(ledger, { units: 10 });

		expect(result.reservation?.consumption?.credits).toHaveLength(1);
	});

	it("falls back to paid work when unbounded credit facts cannot be trusted", () => {
		const ledger = createReservationLedger(
			ledgerView([
				account({
					freeHeadroom: 0,
					credits: [
						{ creditId: "bad", freeHeadroom: null },
						{ creditId: "good", freeHeadroom: 10 },
					],
				}),
			]),
		);
		const result = reserveOn(ledger, { units: 4 });
		expect(result.reservation?.consumption?.credits).toEqual([]);
		expect(result.reservation?.reservedCost).toBe(0.08);
	});

	it("reserves against an account that does not exist in the ledger", () => {
		const ledger = createReservationLedger(ledgerView([]));
		const result = reserveOn(ledger);
		expect(result.ok).toBe(true);
		expect(result.reservation?.consumption).toEqual({
			freeHeadroom: 0,
			credits: [],
		});
	});

	it("defaults units to 1", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		const result = ledger.reserve({
			providerId: "p1",
			dimension: "runner.minutes",
			reservationId: "r-1",
			expectedSeq: 91,
		});
		expect(result.units).toBe(1);
	});

	it("refuses a non-positive or non-finite unit count", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		for (const units of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => reserveOn(ledger, { units })).toThrow(
				/units must be greater than 0/u,
			);
		}
	});

	it("refuses missing identifiers and a malformed request", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		expect(() => ledger.reserve(null)).toThrow(/request must be an object/u);
		expect(() => ledger.reserve([])).toThrow(/request must be an object/u);
		expect(() => reserveOn(ledger, { providerId: "" })).toThrow(
			/providerId must be a non-empty string/u,
		);
		expect(() => reserveOn(ledger, { dimension: undefined })).toThrow(
			/dimension must be a non-empty string/u,
		);
		expect(() => reserveOn(ledger, { reservationId: "" })).toThrow(
			/reservationId must be a non-empty string/u,
		);
	});

	it("refuses a non-integer expectedSeq before comparing it", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		expect(() => reserveOn(ledger, { expectedSeq: 1.5 })).toThrow(
			/expectedSeq must be a non-negative integer/u,
		);
		expect(() => reserveOn(ledger, { expectedSeq: -1 })).toThrow(TypeError);
	});

	it("normalises expiresAt and allows it to be omitted", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		const withExpiry = reserveOn(ledger, {
			expiresAt: "2026-07-01T00:00:00Z",
		});

		expect(withExpiry.reservation?.expiresAt).toBe("2026-07-01T00:00:00.000Z");
		const noExpiry = reserveOn(ledger, {
			reservationId: "r-2",
			expectedSeq: ledger.snapshot().seq,
		});

		expect(noExpiry.reservation?.expiresAt).toBeNull();
	});

	it("refuses an unparseable expiresAt", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		expect(() => reserveOn(ledger, { expiresAt: "next tuesday" })).toThrow(
			/must be a valid ISO-8601 string/u,
		);
	});

	it("emits a ReservationReserved fact carrying the committed seq", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		const events = ledger.events();
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe(DISPATCH_EVENTS.ReservationReserved);
	});
});

describe("confirm", () => {
	it("moves a pending reservation to confirmed and bumps the seq", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		const result = ledger.confirm({ reservationId: "r-1" });
		expect(result.ok).toBe(true);
		expect(result.status).toBe("confirmed");
		expect(result.committedSeq).toBe(93);
		expect(result.reservation?.confirmedSeq).toBe(93);
	});

	it("does not restore headroom", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { units: 30 });
		ledger.confirm({ reservationId: "r-1" });

		expect(ledger.snapshot().accounts[0]?.freeHeadroom).toBe(70);
	});

	it("refuses an unknown reservation", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		const result = ledger.confirm({ reservationId: "nope" });
		expect(result.ok).toBe(false);
		expect(result.status).toBe("not-confirmable");

		expect(ledger.snapshot().seq).toBe(91);
	});

	it("refuses to confirm twice", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		ledger.confirm({ reservationId: "r-1" });
		expect(ledger.confirm({ reservationId: "r-1" }).status).toBe(
			"not-confirmable",
		);
	});

	it("records an optional providerUsageSeq and omits it when absent", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		const confirmed = ledger.confirm({
			reservationId: "r-1",
			providerUsageSeq: 7,
		});
		expect(confirmed.reservation?.providerUsageSeq).toBe(7);

		const second = createReservationLedger(ledgerView([account()]));
		reserveOn(second);
		expect(
			second.confirm({ reservationId: "r-1" }).reservation?.providerUsageSeq,
		).toBeUndefined();
	});

	it("accepts providerUsageSeq zero and refuses a malformed one", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		expect(
			ledger.confirm({ reservationId: "r-1", providerUsageSeq: 0 }).reservation
				?.providerUsageSeq,
		).toBe(0);

		const other = createReservationLedger(ledgerView([account()]));
		reserveOn(other);
		expect(() =>
			other.confirm({ reservationId: "r-1", providerUsageSeq: -1 }),
		).toThrow(/must be a non-negative integer/u);
	});

	it("refuses a malformed request", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		expect(() => ledger.confirm(null)).toThrow(/request must be an object/u);
		expect(() => ledger.confirm({ reservationId: "" })).toThrow(TypeError);
	});
});

describe("release", () => {
	it("restores exactly the headroom the reservation consumed", () => {
		const ledger = createReservationLedger(
			ledgerView([account({ freeHeadroom: 5 })]),
		);
		reserveOn(ledger, { units: 20 });

		expect(ledger.snapshot().accounts[0]?.freeHeadroom).toBe(0);
		ledger.release({ reservationId: "r-1" });

		expect(ledger.snapshot().accounts[0]?.freeHeadroom).toBe(5);
	});

	it("restores each drawn-on credit grant", () => {
		const ledger = createReservationLedger(
			ledgerView([
				account({
					freeHeadroom: 0,
					credits: [
						{ creditId: "c1", freeHeadroom: 10 },
						{ creditId: "c2", freeHeadroom: 10 },
					],
				}),
			]),
		);
		reserveOn(ledger, { units: 15 });
		ledger.release({ reservationId: "r-1" });

		const credits = ledger.snapshot().accounts[0]?.credits ?? [];
		expect(credits[0]?.freeHeadroom).toBe(10);
		expect(credits[1]?.freeHeadroom).toBe(10);
	});

	it("clamps reservedUnits at zero rather than going negative", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { units: 10 });
		ledger.release({ reservationId: "r-1" });

		expect(ledger.snapshot().accounts[0]?.reservedUnits).toBe(0);
	});

	it("refuses to release twice, so headroom is never restored twice", () => {
		const ledger = createReservationLedger(
			ledgerView([account({ freeHeadroom: 100 })]),
		);
		reserveOn(ledger, { units: 40 });
		ledger.release({ reservationId: "r-1" });
		const second = ledger.release({ reservationId: "r-1" });
		expect(second.ok).toBe(false);
		expect(second.status).toBe("not-releasable");

		expect(ledger.snapshot().accounts[0]?.freeHeadroom).toBe(100);
	});

	it("refuses to release a confirmed reservation", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		ledger.confirm({ reservationId: "r-1" });
		expect(ledger.release({ reservationId: "r-1" }).status).toBe(
			"not-releasable",
		);
	});

	it("refuses to release an unknown reservation", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		expect(ledger.release({ reservationId: "nope" }).status).toBe(
			"not-releasable",
		);
	});

	it("defaults the reason and records an explicit one", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		expect(
			ledger.release({ reservationId: "r-1" }).reservation?.releaseReason,
		).toBe("released");

		const other = createReservationLedger(ledgerView([account()]));
		reserveOn(other);
		expect(
			other.release({ reservationId: "r-1", reason: "job cancelled" })
				.reservation?.releaseReason,
		).toBe("job cancelled");
	});

	it("releases cleanly when the account has since vanished from the ledger", () => {
		const ledger = createReservationLedger(ledgerView([]));
		reserveOn(ledger);
		expect(ledger.release({ reservationId: "r-1" }).ok).toBe(true);
	});

	it("marks the reservation released rather than expired", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		const result = ledger.release({ reservationId: "r-1" });
		expect(result.status).toBe("released");
		expect(ledger.events().at(-1)?.type).toBe(
			DISPATCH_EVENTS.ReservationReleased,
		);
	});
});

describe("expire", () => {
	it("expires only pending reservations whose expiry has passed", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, {
			reservationId: "past",
			expiresAt: "2026-06-27T00:00:01.000Z",
		});
		reserveOn(ledger, {
			reservationId: "future",
			expiresAt: "2027-01-01T00:00:00.000Z",
			expectedSeq: ledger.snapshot().seq,
		});
		const result = ledger.expire({ now: "2026-06-27T00:00:02.000Z" });
		expect(result.released).toBe(1);

		const reservations = ledger.snapshot().reservations ?? [];
		expect(reservations.find((r) => r.reservationId === "past")?.status).toBe(
			"expired",
		);
		expect(reservations.find((r) => r.reservationId === "future")?.status).toBe(
			"pending",
		);
	});

	it("treats an expiry exactly at now as expired", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { expiresAt: "2026-06-27T00:00:01.000Z" });
		expect(ledger.expire({ now: "2026-06-27T00:00:01.000Z" }).released).toBe(1);
	});

	it("never expires a reservation with no expiry", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		expect(ledger.expire({ now: "2099-01-01T00:00:00.000Z" }).released).toBe(0);
	});

	it("keeps a confirmed reservation spent after its deadline", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { expiresAt: "2026-06-27T00:00:01.000Z" });
		ledger.confirm({ reservationId: "r-1" });
		expect(ledger.expire({ now: "2026-06-27T00:00:02.000Z" }).released).toBe(0);
		expect(ledger.snapshot().accounts[0]?.freeHeadroom).toBe(90);
	});

	it("refuses a late confirmation after expiration without spending restored credit", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { expiresAt: "2026-06-27T00:00:01.000Z" });
		ledger.expire({ now: "2026-06-27T00:00:02.000Z" });
		const result = ledger.confirm({
			reservationId: "r-1",
			providerUsageSeq: 777,
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("not-confirmable");
		expect(ledger.snapshot().accounts[0]?.freeHeadroom).toBe(100);
		expect(ledger.events().at(-1)?.type).toBe(
			DISPATCH_EVENTS.ReservationExpired,
		);
	});

	it("restores headroom for each expired reservation", () => {
		const ledger = createReservationLedger(
			ledgerView([account({ freeHeadroom: 100 })]),
		);
		reserveOn(ledger, { units: 25, expiresAt: "2026-06-27T00:00:01.000Z" });
		ledger.expire({ now: "2026-06-27T00:00:01.000Z" });

		expect(ledger.snapshot().accounts[0]?.freeHeadroom).toBe(100);
	});

	it("reports zero released on an empty ledger", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		const result = ledger.expire({ now: "2026-06-27T00:00:00.000Z" });
		expect(result.released).toBe(0);
		expect(result.releases).toEqual([]);
		expect(ledger.snapshot().seq).toBe(91);
	});

	it("expires several reservations in one sweep, each bumping the seq", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, {
			reservationId: "a",
			expiresAt: "2026-06-27T00:00:01Z",
		});
		reserveOn(ledger, {
			reservationId: "b",
			expiresAt: "2026-06-27T00:00:01Z",
			expectedSeq: ledger.snapshot().seq,
		});
		const result = ledger.expire({ now: "2026-06-27T00:00:01.000Z" });
		expect(result.released).toBe(2);
		expect(ledger.snapshot().seq).toBe(96);
	});

	it("emits ReservationExpired rather than ReservationReleased", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { expiresAt: "2026-06-27T00:00:01Z" });
		ledger.expire({ now: "2026-06-27T00:00:01.000Z" });
		expect(ledger.events().at(-1)?.type).toBe(
			DISPATCH_EVENTS.ReservationExpired,
		);
	});

	it("refuses a malformed now", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		expect(() => ledger.expire({ now: "whenever" })).toThrow(
			/must be a valid ISO-8601 string/u,
		);
		expect(() => ledger.expire({})).toThrow(/must be a non-empty string/u);
		expect(() => ledger.expire(null)).toThrow(/request must be an object/u);
	});
});

it("re-ranks a burst of dispatches from the same stale credit snapshot", () => {
	const registry = createDispatcherRegistry([
		{
			id: "free",
			providerId: "free",
			category: "runner",
			registered: true,
			dimension: "runner.minutes",
			listUnitCost: 0.04,
		},
		{
			id: "paid",
			providerId: "paid",
			category: "runner",
			registered: true,
			dimension: "runner.minutes",
			listUnitCost: 0.01,
		},
	]);
	const ledger = createReservationLedger(
		ledgerView([
			account({
				providerId: "free",
				freeHeadroom: 2,
				listUnitCost: 0.04,
				credits: [
					{
						creditId: "free-credit",
						freeHeadroom: 2,
						expiresAt: "2026-07-01T00:00:00.000Z",
					},
				],
			}),
			account({ providerId: "paid", freeHeadroom: 0, listUnitCost: 0.01 }),
		]),
	);
	const staleSnapshot = ledger.snapshot();
	const decisions = Array.from({ length: 5 }, (_, index) =>
		decideAndReserveDispatch({
			registry,
			category: "runner",
			dispatchId: `burst-${index}`,
			units: 1,
			ledgerView: staleSnapshot,
			reservationLedger: ledger,
		}),
	);
	expect(decisions.map((decision) => decision.selectedProvider)).toEqual([
		"free",
		"free",
		"paid",
		"paid",
		"paid",
	]);
	expect(
		ledger.snapshot().accounts.find((entry) => entry.providerId === "free")
			?.freeHeadroom,
	).toBe(0);
	expect(
		ledger
			.snapshot()
			.reservations?.filter((entry) => entry.providerId === "free"),
	).toHaveLength(2);
});

describe("snapshot and events", () => {
	it("hand back clones a caller cannot use to mutate the ledger", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);

		const snapshot = ledger.snapshot();
		snapshot.seq = 0;
		expect(ledger.snapshot().seq).toBe(92);

		const events = ledger.events();
		events.length = 0;
		expect(ledger.events()).toHaveLength(1);
	});

	it("accumulates the full lifecycle in order", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { reservationId: "a" });
		ledger.confirm({ reservationId: "a" });
		reserveOn(ledger, {
			reservationId: "b",
			expectedSeq: ledger.snapshot().seq,
		});
		ledger.release({ reservationId: "b" });
		expect(ledger.events().map((event) => event.type)).toEqual([
			DISPATCH_EVENTS.ReservationReserved,
			DISPATCH_EVENTS.ReservationConfirmed,
			DISPATCH_EVENTS.ReservationReserved,
			DISPATCH_EVENTS.ReservationReleased,
		]);
	});
});
