import { clone, create } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	createBudgetAdmissionAuthority,
	HostingQuoteSchema,
	validateBudgetSnapshot,
	validateHostingQuote,
} from "../src/budget-authority.js";
import {
	compareFinancialTime,
	validFinancialTime,
} from "../src/financial-time.js";

const observed = "2026-10-30T12:00:00Z";
const validUntil = "2026-10-31T00:00:00Z";
const instant = (nanos: number) =>
	`2026-10-30T12:00:00.${String(nanos).padStart(9, "0")}Z`;

function snapshot() {
	return create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant",
			budgetId: "budget",
			periodId: "p1",
			policyRevision: "v1",
		},
		limitMicros: 100,
		observedAt: observed,
		validUntil,
		entitlements: [
			{
				bucketId: "b",
				unit: "request",
				periodId: "p1",
				remainingUnits: 10,
				observedAt: observed,
				validUntil,
			},
		],
	});
}

function quote() {
	return create(HostingQuoteSchema, {
		quoteId: "q",
		yardId: "y",
		providerId: "p",
		ownerTenantId: "tenant",
		requestDigest: "r",
		currency: "USD",
		totalMicros: 1,
		liabilityBoundMicros: 1,
		components: [{ name: "work", costMicros: 1 }],
		observedAt: observed,
		validUntil,
	});
}

describe("hosting financial evidence time", () => {
	it("rejects a quote or budget observation later within the same millisecond", () => {
		const now = instant(100);
		const later = instant(900);
		expect(() =>
			validateHostingQuote({ ...quote(), observedAt: later }, now),
		).toThrow();
		expect(() =>
			validateBudgetSnapshot({ ...snapshot(), observedAt: later }, now),
		).toThrow();
	});

	it("accepts an expiry later within the same millisecond and rejects an earlier expiry", () => {
		const now = instant(500);
		const candidate = {
			...quote(),
			observedAt: instant(100),
			validUntil: instant(900),
		};
		expect(() => validateHostingQuote(candidate, now)).not.toThrow();
		expect(() =>
			validateHostingQuote({ ...candidate, validUntil: instant(100) }, now),
		).toThrow();
	});

	it("compares offset timestamps as the same instant with exact fractions", () => {
		const candidate = {
			...quote(),
			observedAt: "2026-10-30T13:00:00.0000001+01:00",
		};
		expect(() => validateHostingQuote(candidate, instant(100))).not.toThrow();
		expect(() => validateHostingQuote(candidate, instant(99))).toThrow();
		expect(
			compareFinancialTime(
				"2026-10-31T00:30:00+01:00",
				"2026-10-30T23:30:00.000Z",
			),
		).toBe(0);
	});

	it.each([
		"2026-02-30T00:00:00Z",
		"2026-10-30T24:00:00Z",
		"2026-10-30T12:00:00+24:00",
		"2026-10-30T12:00:00",
	])("rejects invalid or ambiguous financial timestamp %s", (value) => {
		expect(validFinancialTime(value)).toBe(false);
	});

	it("rejects impossible calendar dates instead of normalizing them", () => {
		const now = "2026-03-03T00:00:00Z";
		const impossible = "2026-02-30T00:00:00Z";
		const end = "2026-03-04T00:00:00Z";
		expect(() =>
			validateHostingQuote(
				{ ...quote(), observedAt: impossible, validUntil: end },
				now,
			),
		).toThrow();
		expect(() =>
			validateBudgetSnapshot(
				{
					...snapshot(),
					observedAt: impossible,
					validUntil: end,
					entitlements: [],
				},
				now,
			),
		).toThrow();
	});

	it.each([
		"2026-10-30T12:00:00.000Z",
		"2026-10-30T13:00:00+01:00",
	])("does not treat equivalent timestamp %s as a newer spend observation", (equivalent) => {
		const initial = snapshot();
		const authority = createBudgetAdmissionAuthority({ snapshot: initial });
		const next = clone(BudgetLedgerSnapshotSchema, initial);
		next.observedAt = equivalent;
		next.spentMicros = 1;
		expect(() =>
			authority.configure(next, initial.seq, "2026-10-30T13:00:00Z"),
		).toThrow();
	});

	it("does not treat equivalent timestamp spellings as a newer entitlement observation", () => {
		const initial = snapshot();
		const authority = createBudgetAdmissionAuthority({ snapshot: initial });
		const next = clone(BudgetLedgerSnapshotSchema, initial);
		const bucket = next.entitlements[0];
		if (!bucket) throw new Error("fixture missing entitlement");
		bucket.observedAt = "2026-10-30T12:00:00.000Z";
		bucket.remainingUnits = 11;
		expect(() =>
			authority.configure(next, initial.seq, "2026-10-30T13:00:00Z"),
		).toThrow(/entitlement observation/u);
	});

	it("accepts a genuinely newer sub-millisecond financial observation", () => {
		const initial = snapshot();
		initial.observedAt = instant(100);
		const initialBucket = initial.entitlements[0];
		if (!initialBucket) throw new Error("fixture missing entitlement");
		initialBucket.observedAt = instant(100);
		const authority = createBudgetAdmissionAuthority({ snapshot: initial });
		const next = clone(BudgetLedgerSnapshotSchema, initial);
		next.observedAt = instant(900);
		next.spentMicros = 1;
		const nextBucket = next.entitlements[0];
		if (!nextBucket) throw new Error("fixture missing entitlement");
		nextBucket.observedAt = instant(900);
		nextBucket.remainingUnits = 11;
		expect(() =>
			authority.configure(next, initial.seq, instant(1000)),
		).not.toThrow();
	});

	it("compares generated sub-millisecond observations by their exact instant", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 999_999 }),
				fc.integer({ min: 0, max: 999_999 }),
				(sample, now) => {
					const candidate = { ...quote(), observedAt: instant(sample) };
					if (sample <= now)
						expect(() =>
							validateHostingQuote(candidate, instant(now)),
						).not.toThrow();
					else
						expect(() =>
							validateHostingQuote(candidate, instant(now)),
						).toThrow();
				},
			),
			{ seed: 614506, numRuns: 500 },
		);
	});

	it("orders generated fractional seconds across UTC offsets", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 999_999_999 }),
				fc.integer({ min: 0, max: 999_999_999 }),
				fc.integer({ min: -10, max: 10 }),
				fc.integer({ min: -10, max: 10 }),
				(left, right, leftOffset, rightOffset) => {
					const at = (nanos: number, offset: number) =>
						`2026-10-30T${String(12 + offset).padStart(2, "0")}:00:00.${String(nanos).padStart(9, "0")}${offset < 0 ? "-" : "+"}${String(Math.abs(offset)).padStart(2, "0")}:00`;
					expect(
						compareFinancialTime(at(left, leftOffset), at(right, rightOffset)),
					).toBe(Math.sign(left - right));
				},
			),
			{ seed: 614507, numRuns: 1000 },
		);
	});
});
