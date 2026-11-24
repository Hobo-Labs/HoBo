import fc from "fast-check";
import { expect, it } from "vitest";
import { createReservationLedger } from "../src/dispatcher.js";

const MAX = Number.MAX_SAFE_INTEGER;
const view = (seq: number) => ({
	view: "CreditLedgerView",
	seq,
	asOf: "2026-07-01T00:00:00.000Z",
	accounts: [
		{
			providerId: "p",
			dimension: "runner.minutes",
			listUnitCost: 1,
			freeHeadroom: 0,
			budgetCap: 100,
			spendToDate: 0,
		},
	],
});
const reserve = (
	ledger: ReturnType<typeof createReservationLedger>,
	id: string,
	expectedSeq: number,
) =>
	ledger.reserve({
		providerId: "p",
		dimension: "runner.minutes",
		reservationId: id,
		units: 1,
		expectedSeq,
		expiresAt: "2026-07-02T00:00:00.000Z",
	});
it("permits the final safe revision, then refuses a new reservation without changing state", () => {
	const ledger = createReservationLedger(view(MAX - 1));
	expect(reserve(ledger, "first", MAX - 1).ok).toBe(true);
	expect(ledger.snapshot().seq).toBe(MAX);
	const before = ledger.snapshot(),
		events = ledger.events();
	expect(() => reserve(ledger, "second", MAX)).toThrow(/sequence.*exhaust/i);
	expect(ledger.snapshot()).toEqual(before);
	expect(ledger.events()).toEqual(events);
	expect(reserve(ledger, "first", MAX - 1).ok).toBe(true);
});
it.each([
	"start",
	"release",
	"confirm",
	"expire",
] as const)("refuses %s at sequence exhaustion without changing state", (action) => {
	const ledger = createReservationLedger(view(MAX - 1));
	expect(reserve(ledger, "first", MAX - 1).ok).toBe(true);
	const before = ledger.snapshot(),
		events = ledger.events();
	const run = () =>
		action === "start"
			? ledger.start({ reservationId: "first" })
			: action === "release"
				? ledger.release({ reservationId: "first" })
				: action === "confirm"
					? ledger.confirm({ reservationId: "first" })
					: ledger.expire({ now: "2026-07-03T00:00:00.000Z" });
	expect(run).toThrow(/sequence.*exhaust/i);
	expect(ledger.snapshot()).toEqual(before);
	expect(ledger.events()).toEqual(events);
});
it("does not partially advance time or expire holds when there are too few remaining revisions", () => {
	const ledger = createReservationLedger(view(MAX - 3));
	expect(reserve(ledger, "first", MAX - 3).ok).toBe(true);
	expect(reserve(ledger, "second", MAX - 2).ok).toBe(true);
	const before = ledger.snapshot(),
		events = ledger.events();
	expect(() => ledger.expire({ now: "2026-07-03T00:00:00.000Z" })).toThrow(
		/sequence.*exhaust/i,
	);
	expect(ledger.snapshot()).toEqual(before);
	expect(ledger.events()).toEqual(events);
});
it("expires the whole batch when exactly enough revisions remain", () => {
	const ledger = createReservationLedger(view(MAX - 5));
	expect(reserve(ledger, "first", MAX - 5).ok).toBe(true);
	expect(reserve(ledger, "second", MAX - 4).ok).toBe(true);
	expect(ledger.expire({ now: "2026-07-03T00:00:00.000Z" }).released).toBe(2);
	expect(ledger.snapshot().seq).toBe(MAX);
	expect(ledger.snapshot().reservations?.map((r) => r.status)).toEqual([
		"expired",
		"expired",
	]);
});
it("allows an idempotent start and a no-op expiry after reaching the limit", () => {
	const ledger = createReservationLedger(view(MAX - 2));
	expect(reserve(ledger, "first", MAX - 2).ok).toBe(true);
	expect(ledger.start({ reservationId: "first" }).ok).toBe(true);
	const before = ledger.snapshot();
	const events = ledger.events();
	expect(ledger.start({ reservationId: "first" })).toMatchObject({
		ok: true,
		replayed: true,
	});
	expect(ledger.expire({ now: "2026-07-01T00:00:00.000Z" }).released).toBe(0);
	expect(ledger.snapshot()).toEqual(before);
	expect(ledger.events()).toEqual(events);
});
it("rejects an unsafe sequence in an imported ledger snapshot", () => {
	expect(() => createReservationLedger(view(MAX + 1))).toThrow(/seq/i);
});
it.each([
	"expectedSeq",
	"committedSeq",
	"startedSeq",
	"confirmedSeq",
	"releasedSeq",
	"providerUsageSeq",
] as const)("rejects an unsafe reservation %s from a snapshot", (field) => {
	const ledger = createReservationLedger(view(0));
	expect(reserve(ledger, "first", 0).ok).toBe(true);
	const snapshot = ledger.snapshot();
	const reservation = snapshot.reservations?.[0];
	if (!reservation) throw new Error("missing reservation");
	reservation[field] = MAX + 1;
	expect(() => createReservationLedger(snapshot)).toThrow(/safe integer/i);
});
it("never accepts more new reservations than remaining safe revisions", () => {
	fc.assert(
		fc.property(fc.integer({ min: 0, max: 5 }), (remaining) => {
			const ledger = createReservationLedger(view(MAX - remaining));
			for (let i = 0; i < remaining; i++)
				expect(reserve(ledger, `r${i}`, MAX - remaining + i).ok).toBe(true);
			const before = ledger.snapshot();
			expect(() => reserve(ledger, "extra", MAX)).toThrow(/sequence.*exhaust/i);
			expect(ledger.snapshot()).toEqual(before);
		}),
		{ seed: 614473, numRuns: 50 },
	);
});
