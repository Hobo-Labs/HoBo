/**
 * The reservation ledger's CAS, headroom accounting and lifecycle invariants
 * (ADR-0071, promoted from the reservation-hardening contract).
 *
 * A reservation is how the dispatcher stops two concurrent dispatches from
 * spending the same free credit twice. Everything here turns on three
 * properties, and each of them fails silently rather than loudly:
 *
 * 1. **Compare-and-swap on `seq`.** A stale `expectedSeq` must be refused, not
 *    applied. If it were applied, two callers who both read the ledger at seq
 *    91 would each reserve against the same headroom and the provider would
 *    bill for the overage.
 * 2. **Headroom consumed on reserve is restored exactly once on release.**
 *    Restoring twice invents free credit that does not exist; restoring zero
 *    times leaks it permanently. The `consumption` record on the reservation
 *    is what makes the restore exact rather than approximate.
 * 3. **Terminal states are terminal.** A confirmed or released reservation
 *    cannot be released again, or its headroom would be restored twice.
 */
import { describe, expect, it } from "vitest";

import {
	createReservationLedger,
	DISPATCH_EVENTS,
	parseCreditLedgerView,
} from "../src/dispatcher.js";
import type { JsonValue } from "../src/json.js";
import { isJsonObject } from "../src/json.js";

const DIGEST =
	"sha256:1111111111111111111111111111111111111111111111111111111111111111";

function ledgerView(accounts: unknown[] = [], seq = 91) {
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
		// A clone, not the caller's object. The ledger mutates its working copy
		// on every reserve, and sharing the input would let those mutations leak
		// back into whatever the caller still holds.
		expect(parsed).not.toBe(input);
		expect(parsed.accounts).not.toBe(input.accounts);
	});

	it("refuses anything that is not a CreditLedgerView object", () => {
		for (const bad of [null, undefined, 7, "view", [], ledgerView()]) {
			if (!isJsonObject(bad)) {
				expect(() => parseCreditLedgerView(bad)).toThrow(TypeError);
			}
		}
		// An array is the case a bare `typeof === "object"` check would admit.
		expect(() => parseCreditLedgerView([])).toThrow(
			/must be a CreditLedgerView snapshot/u,
		);
	});

	it("refuses a snapshot whose view tag is wrong", () => {
		// The tag is what distinguishes a credit ledger from any other snapshot
		// shape with a `seq` and an `accounts` array. Accepting an untagged
		// object would let an unrelated projection be reserved against.
		expect(() =>
			parseCreditLedgerView({ ...ledgerView(), view: "SomethingElse" }),
		).toThrow(/view must be CreditLedgerView/u);
	});

	it("refuses a non-integer or negative seq", () => {
		// `seq` is the CAS token. A fractional one would never compare equal to a
		// committed seq, and a negative one would make every CAS succeed against
		// a ledger that had never been written.
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
		// Exactly one, so a caller can CAS the next write against it. A jump
		// would make every subsequent expectedSeq wrong.
		expect(result.committedSeq).toBe(92);
		expect(ledger.snapshot().seq).toBe(92);
		expect(result.reservation?.status).toBe("pending");
	});

	it("refuses a stale expectedSeq without mutating the ledger", () => {
		// The core CAS guarantee. Two readers at seq 91 both try to reserve; the
		// second must be told it lost rather than being allowed to double-spend
		// the same headroom.
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
		// Nothing moved: no seq bump, no second reservation, no headroom taken.
		expect(ledger.snapshot().seq).toBe(92);
		expect(ledger.snapshot().reservations).toHaveLength(1);
	});

	it("refuses a future expectedSeq as well as a stale one", () => {
		// Strict equality, not `>=`. A caller quoting a seq the ledger has not
		// reached has read a different ledger, and letting it through would
		// commit against state that does not exist here.
		const ledger = createReservationLedger(ledgerView([account()]));
		expect(reserveOn(ledger, { expectedSeq: 999 }).status).toBe("cas-conflict");
	});

	it("consumes free headroom from the account", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { units: 30 });
		// SAFETY: the parsed account is the ledger's CreditAccount shape.
		const after = ledger.snapshot().accounts[0] as { freeHeadroom: number };
		expect(after.freeHeadroom).toBe(70);
	});

	it("tracks reservedUnits cumulatively across reservations", () => {
		// `reservedUnits` is what a ranking pass subtracts to see the *available*
		// headroom. If it did not accumulate, the second dispatch would rank
		// against headroom the first one had already claimed.
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { units: 10 });
		reserveOn(ledger, {
			reservationId: "r-2",
			units: 5,
			expectedSeq: ledger.snapshot().seq,
		});
		// SAFETY: the parsed account exposes the reservation accounting field.
		expect(
			(ledger.snapshot().accounts[0] as { reservedUnits: number })
				.reservedUnits,
		).toBe(15);
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
		// SAFETY: the parsed account's credits are CreditGrant records.
		const after = ledger.snapshot().accounts[0] as {
			freeHeadroom: number;
			credits: Array<{ freeHeadroom: number }>;
		};
		expect(after.freeHeadroom).toBe(0);
		expect(after.credits[0]?.freeHeadroom).toBe(5);
		// The second grant was never touched, because the request was satisfied.
		expect(after.credits[1]?.freeHeadroom).toBe(10);
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
		// Exactly one grant recorded, not a zero-unit entry for the second: an
		// empty consumption entry would restore nothing but would suggest the
		// grant had been drawn on.
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
		// Deliberate: the reservation is still recorded so the CAS chain and the
		// event log stay intact. A silent refusal here would leave a dispatch
		// believing it held a reservation nobody could find.
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
		// Zero units is a reservation that claims nothing but still occupies a
		// CAS slot; a negative one would *add* headroom on release.
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
		// Parsed before the CAS, so a malformed token is a caller error rather
		// than a lost race — the two need different responses.
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
		// Normalised to a full ISO string so two spellings of the same instant
		// compare equal when the expiry sweep runs.
		expect(withExpiry.reservation?.expiresAt).toBe("2026-07-01T00:00:00.000Z");
		const noExpiry = reserveOn(ledger, {
			reservationId: "r-2",
			expectedSeq: ledger.snapshot().seq,
		});
		// Null, not undefined: an absent expiry is an explicit "never expires".
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
		// Confirming means the units were actually used. Restoring here would
		// hand the headroom back while the provider also bills for it.
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { units: 30 });
		ledger.confirm({ reservationId: "r-1" });
		// SAFETY: the parsed account is the ledger's CreditAccount shape.
		expect(
			(ledger.snapshot().accounts[0] as { freeHeadroom: number }).freeHeadroom,
		).toBe(70);
	});

	it("refuses an unknown reservation", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		const result = ledger.confirm({ reservationId: "nope" });
		expect(result.ok).toBe(false);
		expect(result.status).toBe("not-confirmable");
		// The `?.status !== "pending"` guard covers both "no such reservation"
		// and "wrong state" with one branch, so neither can bump the seq.
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
		// The provider's own usage sequence, when it reports one, is what lets a
		// later reconciliation line the two ledgers up. It is optional because
		// not every provider reports one.
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
		// `!== undefined`, not truthiness: usage sequence 0 is a real first entry
		// and dropping it would leave the reconciliation unanchored.
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
		// Exactly, from the recorded `consumption` — not by adding the unit count
		// back. The two differ whenever the account had less headroom than the
		// request, and adding units back would invent credit.
		const ledger = createReservationLedger(
			ledgerView([account({ freeHeadroom: 5 })]),
		);
		reserveOn(ledger, { units: 20 });
		// SAFETY: the parsed account is the ledger's CreditAccount shape.
		expect(
			(ledger.snapshot().accounts[0] as { freeHeadroom: number }).freeHeadroom,
		).toBe(0);
		ledger.release({ reservationId: "r-1" });
		// SAFETY: the parsed account is the ledger's CreditAccount shape.
		expect(
			(ledger.snapshot().accounts[0] as { freeHeadroom: number }).freeHeadroom,
		).toBe(5);
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
		// SAFETY: the parsed account's credits are CreditGrant records.
		const credits = (
			ledger.snapshot().accounts[0] as {
				credits: Array<{ freeHeadroom: number }>;
			}
		).credits;
		expect(credits[0]?.freeHeadroom).toBe(10);
		expect(credits[1]?.freeHeadroom).toBe(10);
	});

	it("clamps reservedUnits at zero rather than going negative", () => {
		// `Math.max(0, …)`. A negative reservedUnits would make available
		// headroom read as *more* than the account holds on the next ranking.
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { units: 10 });
		ledger.release({ reservationId: "r-1" });
		// SAFETY: the parsed account is the ledger's CreditAccount shape.
		expect(
			(ledger.snapshot().accounts[0] as { reservedUnits: number })
				.reservedUnits,
		).toBe(0);
	});

	it("refuses to release twice, so headroom is never restored twice", () => {
		// The invariant with the most direct financial consequence: a double
		// restore invents free credit, and the next dispatch spends it against a
		// provider that will bill for it.
		const ledger = createReservationLedger(
			ledgerView([account({ freeHeadroom: 100 })]),
		);
		reserveOn(ledger, { units: 40 });
		ledger.release({ reservationId: "r-1" });
		const second = ledger.release({ reservationId: "r-1" });
		expect(second.ok).toBe(false);
		expect(second.status).toBe("not-releasable");
		// SAFETY: the parsed account is the ledger's CreditAccount shape.
		expect(
			(ledger.snapshot().accounts[0] as { freeHeadroom: number }).freeHeadroom,
		).toBe(100);
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
		// The `if (account)` guard. An account that disappeared between reserve
		// and release must not make the release throw — the reservation still
		// has to reach a terminal state or it would block the id forever.
		const ledger = createReservationLedger(ledgerView([]));
		reserveOn(ledger);
		expect(ledger.release({ reservationId: "r-1" }).ok).toBe(true);
	});

	it("marks the reservation released rather than expired", () => {
		// The two share one implementation and differ only by event type and
		// status. Conflating them would make an operator unable to tell a
		// cancelled job from a reservation that timed out.
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
		// SAFETY: snapshot() returns reservations with the tested lifecycle fields.
		const reservations = ledger.snapshot().reservations as Array<{
			reservationId: string;
			status: string;
		}>;
		expect(reservations.find((r) => r.reservationId === "past")?.status).toBe(
			"expired",
		);
		expect(reservations.find((r) => r.reservationId === "future")?.status).toBe(
			"pending",
		);
	});

	it("treats an expiry exactly at now as expired", () => {
		// `<=`, so the boundary instant expires. The alternative leaves a
		// reservation alive for one sweep interval past its stated deadline.
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { expiresAt: "2026-06-27T00:00:01.000Z" });
		expect(ledger.expire({ now: "2026-06-27T00:00:01.000Z" }).released).toBe(1);
	});

	it("never expires a reservation with no expiry", () => {
		// An absent expiry means "held until explicitly released". Sweeping it
		// would silently free headroom a caller still believes it holds.
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		expect(ledger.expire({ now: "2099-01-01T00:00:00.000Z" }).released).toBe(0);
	});

	it("never expires a confirmed or already-released reservation", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger, { expiresAt: "2026-06-27T00:00:01.000Z" });
		ledger.confirm({ reservationId: "r-1" });
		expect(ledger.expire({ now: "2026-06-27T00:00:00.000Z" }).released).toBe(0);
	});

	it("restores headroom for each expired reservation", () => {
		const ledger = createReservationLedger(
			ledgerView([account({ freeHeadroom: 100 })]),
		);
		reserveOn(ledger, { units: 25, expiresAt: "2026-06-27T00:00:01.000Z" });
		ledger.expire({ now: "2026-06-27T00:00:01.000Z" });
		// SAFETY: the parsed account is the ledger's CreditAccount shape.
		expect(
			(ledger.snapshot().accounts[0] as { freeHeadroom: number }).freeHeadroom,
		).toBe(100);
	});

	it("reports zero released on an empty ledger", () => {
		const ledger = createReservationLedger(ledgerView([account()]));
		const result = ledger.expire({ now: "2026-06-27T00:00:00.000Z" });
		expect(result.released).toBe(0);
		expect(result.releases).toEqual([]);
		expect(ledger.snapshot().seq).toBe(91);
	});

	it("expires several reservations in one sweep, each bumping the seq", () => {
		// One seq per release, not one per sweep: each expiry is its own
		// committed fact, and collapsing them would make the event log's seqs
		// disagree with the ledger's.
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

describe("snapshot and events", () => {
	it("hand back clones a caller cannot use to mutate the ledger", () => {
		// Both return `clone(...)`. A caller who edited the returned snapshot
		// could otherwise raise their own headroom and reserve against credit
		// that does not exist.
		const ledger = createReservationLedger(ledgerView([account()]));
		reserveOn(ledger);
		// SAFETY: snapshot() returns the parsed CreditLedgerView shape.
		const snapshot = ledger.snapshot() as { seq: number };
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
