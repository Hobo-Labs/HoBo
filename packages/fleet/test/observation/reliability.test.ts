/**
 * Reliability, moved from `packages/ci/test/mesh-reliability.test.ts` (design
 * §6.8 "Reliability is measured, not asserted"), and the ledger the authority
 * keeps from signed receipts (§6.9).
 */
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ReceiptStatus,
	WorkReceiptSchema,
} from "../../src/_generated/fleet_pb.js";
import { type MemberId, parseMemberId } from "../../src/ids.js";
import { createReliabilityLedger } from "../../src/observation/index.js";
import {
	decayReliability,
	MIN_RELIABILITY,
	newReliability,
	RELIABILITY_DEFAULTS,
	type ReliabilityRecord,
	recordOutcome,
	reliabilityScore,
	reliabilityWeight,
	retractDelivery,
	scoreOfSamples,
} from "../../src/observation/reliability.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const OPTIONS = RELIABILITY_DEFAULTS;

function outcomes(
	state: ReliabilityRecord,
	outcome: "delivered" | "dropped",
	count: number,
	atMs: number,
): ReliabilityRecord {
	let next = state;
	for (let index = 0; index < count; index += 1)
		next = recordOutcome(next, outcome, atMs, OPTIONS);
	return next;
}

describe("reliability score", () => {
	it("has today's defaults: a 30-minute half-life and four imagined deliveries", () => {
		expect(OPTIONS).toEqual({ halfLifeMs: 30 * MINUTE, priorWeight: 4 });
	});

	it("trusts a member with no history", () => {
		expect(reliabilityScore(newReliability(NOW), NOW, OPTIONS)).toBe(1);
		const busy = outcomes(newReliability(NOW), "delivered", 50, NOW);
		expect(reliabilityScore(busy, NOW, OPTIONS)).toBe(1);
		expect(
			reliabilityScore(newReliability(NOW), NOW, {
				halfLifeMs: MINUTE,
				priorWeight: 0,
			}),
		).toBe(1);
	});

	it("is the share of recent work delivered, never zero; ten drops in a row take it to 0.29", () => {
		const one = outcomes(newReliability(NOW), "dropped", 1, NOW);
		expect(reliabilityScore(one, NOW, OPTIONS)).toBeCloseTo(4 / 5, 10);
		let half = outcomes(newReliability(NOW), "delivered", 10, NOW);
		half = outcomes(half, "dropped", 10, NOW);
		expect(reliabilityScore(half, NOW, OPTIONS)).toBeCloseTo(14 / 24, 10);
		const ten = outcomes(newReliability(NOW), "dropped", 10, NOW);
		expect(reliabilityScore(ten, NOW, OPTIONS)).toBeCloseTo(0.29, 2);
		const many = outcomes(newReliability(NOW), "dropped", 200, NOW);
		expect(reliabilityScore(many, NOW, OPTIONS)).toBeGreaterThan(0);
	});

	it("rises on its own once drops stop, at every step of a ten-hour check", () => {
		const broken = outcomes(newReliability(NOW), "dropped", 10, NOW);
		const at = (minutes: number) =>
			reliabilityScore(broken, NOW + minutes * MINUTE, OPTIONS);
		expect(at(30)).toBeCloseTo(4 / 9, 10);
		expect(at(60)).toBeCloseTo(4 / 6.5, 10);
		expect(at(360)).toBeGreaterThan(0.99);
		let previous = at(0);
		for (let minutes = 5; minutes <= 600; minutes += 5) {
			expect(at(minutes)).toBeGreaterThan(previous);
			previous = at(minutes);
		}
	});

	it("rises faster when work is delivered after the fix", () => {
		const broken = outcomes(newReliability(NOW), "dropped", 10, NOW);
		const waited = reliabilityScore(broken, NOW + 30 * MINUTE, OPTIONS);
		const worked = reliabilityScore(
			outcomes(broken, "delivered", 10, NOW + 30 * MINUTE),
			NOW + 30 * MINUTE,
			OPTIONS,
		);
		expect(worked).toBeCloseTo(14 / 19, 10);
		expect(worked).toBeGreaterThan(waited + 0.25);
	});

	it("does not move when the clock steps backwards or the half-life is unset", () => {
		const state = outcomes(newReliability(NOW), "dropped", 3, NOW);
		expect(decayReliability(state, NOW - MINUTE, OPTIONS)).toBe(state);
		expect(
			decayReliability(state, NOW + MINUTE, { ...OPTIONS, halfLifeMs: 0 }),
		).toBe(state);
	});

	it("takes a delivery back when the work is lost afterwards", () => {
		const picked = outcomes(newReliability(NOW), "delivered", 1, NOW);
		const lost = retractDelivery(picked, NOW, NOW + 10 * MINUTE, OPTIONS);
		expect(lost.delivered).toBeCloseTo(0, 10);
		expect(lost.dropped).toBe(1);
		expect(
			retractDelivery(picked, NOW, NOW + MINUTE, {
				...OPTIONS,
				halfLifeMs: 0,
			}).delivered,
		).toBe(1);
	});

	it("weights a score into [0.05, 1], an unusable one as full trust", () => {
		expect(reliabilityWeight(0)).toBe(MIN_RELIABILITY);
		expect(reliabilityWeight(0.5)).toBe(0.5);
		expect(reliabilityWeight(7)).toBe(1);
		expect(reliabilityWeight(Number.NaN)).toBe(1);
		expect(reliabilityWeight(undefined)).toBe(1);
	});

	it("scores published samples with the same prior", () => {
		expect(scoreOfSamples({ delivered: 0, dropped: 10 })).toBeCloseTo(
			4 / 14,
			10,
		);
		expect(scoreOfSamples({ delivered: 3, dropped: 0 })).toBe(1);
	});
});

describe("createReliabilityLedger", () => {
	const DEVICE: MemberId = parseMemberId(`dev_${"d".repeat(32)}`);
	const OTHER: MemberId = parseMemberId(`dev_${"e".repeat(32)}`);
	const receipt = (
		orderId: string,
		status: ReceiptStatus,
		atMs: number,
		memberId: string = DEVICE,
	) =>
		create(WorkReceiptSchema, {
			orderId,
			memberId,
			status,
			at: new Date(atMs).toISOString(),
		});

	it("counts work as delivered once it started, whatever the work's own result", () => {
		const ledger = createReliabilityLedger();
		ledger.record(receipt("o1", ReceiptStatus.STARTED, NOW));
		ledger.record(receipt("o1", ReceiptStatus.FAILED, NOW));
		ledger.record(receipt("o2", ReceiptStatus.SUCCEEDED, NOW));
		expect(ledger.samples().get(DEVICE)).toMatchObject({
			delivered: 2,
			dropped: 0,
		});
	});

	it("counts abandoned or refused work as dropped, taking back its start", () => {
		const ledger = createReliabilityLedger();
		ledger.record(receipt("o1", ReceiptStatus.STARTED, NOW));
		ledger.record(receipt("o1", ReceiptStatus.ABANDONED, NOW));
		ledger.record(receipt("o2", ReceiptStatus.REFUSED, NOW));
		const samples = ledger.samples().get(DEVICE);
		expect(samples?.delivered).toBeCloseTo(0, 10);
		expect(samples?.dropped).toBe(2);
	});

	it("counts nothing for cancelled work, and each receipt once", () => {
		const ledger = createReliabilityLedger();
		ledger.record(receipt("o1", ReceiptStatus.CANCELLED, NOW));
		ledger.record(receipt("o2", ReceiptStatus.STARTED, NOW));
		ledger.record(receipt("o2", ReceiptStatus.STARTED, NOW));
		ledger.record(receipt("o2", ReceiptStatus.SUCCEEDED, NOW));
		ledger.record(receipt("o2", ReceiptStatus.ABANDONED, NOW));
		expect(ledger.samples().get(DEVICE)).toMatchObject({
			delivered: 1,
			dropped: 0,
		});
	});

	it("ignores a receipt with no usable time or member id", () => {
		const ledger = createReliabilityLedger();
		ledger.record(
			create(WorkReceiptSchema, {
				orderId: "o1",
				memberId: DEVICE,
				status: ReceiptStatus.SUCCEEDED,
				at: "soon",
			}),
		);
		ledger.record(receipt("o2", ReceiptStatus.SUCCEEDED, NOW, "nobody"));
		expect(ledger.samples().size).toBe(0);
	});

	it("decays every member to the newest receipt it has recorded, so a record recovers as the fleet works", () => {
		const ledger = createReliabilityLedger({ halfLifeMs: 30 * MINUTE });
		for (let index = 0; index < 10; index += 1)
			ledger.record(receipt(`d${index}`, ReceiptStatus.REFUSED, NOW));
		expect(
			scoreOfSamples(
				ledger.samples().get(DEVICE) ?? { delivered: 0, dropped: 0 },
			),
		).toBeCloseTo(4 / 14, 10);
		// Another device works on for an hour: the drops count for a quarter.
		ledger.record(
			receipt("x", ReceiptStatus.SUCCEEDED, NOW + 60 * MINUTE, OTHER),
		);
		expect(ledger.samples().get(DEVICE)?.dropped).toBeCloseTo(2.5, 10);
		expect(ledger.samples().get(OTHER)?.delivered).toBe(1);
	});
});
