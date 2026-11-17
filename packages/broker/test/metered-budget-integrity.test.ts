import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createMeteredBillingPlane,
	foldMeteredUsage,
} from "../src/metering.js";
import { createBillingPlane } from "../src/planes.js";

const policy = {
	quota: "deploy",
	quotaUsed: 0,
	quotaLimit: 100,
	budgetUsd: 0.8,
	spendCapUsd: 1,
};
const fact = (
	costUsd: number,
	extra: { finalized?: boolean; reservationId?: string } = {},
) => ({
	type: "meter.UsageRecorded",
	data: { costUsd, ...extra },
});

describe("metered budget integrity", () => {
	it("counts serialized decimal meter facts exactly at the budget boundary", () => {
		const events = [fact(0.1), fact(0.7)];
		expect(foldMeteredUsage(events).spentUsd).toBe(0.8);
		const result = createMeteredBillingPlane(events).authorize({
			requestId: "new",
			spendEstimateUsd: 1e-16,
			billing: policy,
		});
		expect(result.ok).toBe(false);
		expect(result.reasons.map((reason) => reason.code)).toContain(
			"budget-exceeded",
		);
	});

	it("rounds public folded totals up and fails closed on overflow", () => {
		expect(foldMeteredUsage([fact(0.1), fact(0.2)]).spentUsd).toBe(0.3);
		const huge = [fact(Number.MAX_VALUE), fact(Number.MAX_VALUE)];
		expect(foldMeteredUsage(huge).spentUsd).toBe(Number.POSITIVE_INFINITY);
		expect(
			createMeteredBillingPlane(huge).authorize({
				requestId: "a",
				spendEstimateUsd: 0,
				billing: { ...policy, budgetUnlimited: true },
			}).reasons[0]?.code,
		).toBe("metering-evidence-incomplete");
	});

	it("counts outstanding decimal holds exactly", () => {
		const plane = createMeteredBillingPlane([]);
		expect(
			plane.authorize({
				requestId: "a",
				spendEstimateUsd: 0.1,
				billing: policy,
			}).ok,
		).toBe(true);
		expect(
			plane.authorize({
				requestId: "b",
				spendEstimateUsd: 0.7,
				billing: policy,
			}).ok,
		).toBe(true);
		expect(
			plane.authorize({
				requestId: "c",
				spendEstimateUsd: 1e-16,
				billing: policy,
			}).ok,
		).toBe(false);
	});

	it("rejects invalid bounded policies in both billing planes", () => {
		for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			for (const field of ["budgetUsd", "spendCapUsd"] as const) {
				const billing = { ...policy, [field]: invalid };
				for (const plane of [
					createBillingPlane(),
					createMeteredBillingPlane([]),
				]) {
					const result = plane.authorize({
						requestId: "a",
						spendEstimateUsd: 0,
						billing,
					});
					expect(result.ok).toBe(false);
					expect(result.reasons[0]?.code).toBe("billing-policy-invalid");
				}
			}
		}
	});

	it("ignores a numeric bound only when its unlimited flag is explicit", () => {
		const billing = {
			...policy,
			budgetUsd: Number.NaN,
			spendCapUsd: Number.NaN,
			budgetUnlimited: true,
			spendCapUnlimited: true,
		};
		for (const plane of [createBillingPlane(), createMeteredBillingPlane([])]) {
			expect(
				plane.authorize({ requestId: "a", spendEstimateUsd: 10, billing }).ok,
			).toBe(true);
		}
	});

	it("never reauthorizes an identity already finalized in the observed stream", () => {
		const events = [fact(0.2, { finalized: true, reservationId: "a" })];
		const plane = createMeteredBillingPlane(events);
		const result = plane.authorize({
			requestId: "a",
			spendEstimateUsd: 0.2,
			billing: policy,
		});
		expect(result.ok).toBe(false);
		expect(result.reasons[0]?.code).toBe("reservation-already-finalized");
	});

	it("rejects replaced meter evidence even if count and total do not regress", () => {
		let events = [fact(0.1), fact(0.2)];
		const plane = createMeteredBillingPlane(() => events);
		expect(
			plane.authorize({ requestId: "a", spendEstimateUsd: 0, billing: policy })
				.ok,
		).toBe(true);
		events = [fact(0.2), fact(0.2)];
		const result = plane.authorize({
			requestId: "b",
			spendEstimateUsd: 0,
			billing: policy,
		});
		expect(result.ok).toBe(false);
		expect(result.reasons[0]?.code).toBe("metering-evidence-incomplete");
	});

	it("keeps a hold until final evidence and prevents finalized identity reuse", () => {
		const events: ReturnType<typeof fact>[] = [];
		const plane = createMeteredBillingPlane(events);
		const admit = (requestId: string, spendEstimateUsd: number) =>
			plane.authorize({ requestId, spendEstimateUsd, billing: policy });
		expect(admit("a", 0.7).ok).toBe(true);
		expect(admit("a", 0.7).ok).toBe(true);
		expect(admit("a", 0.6).reasons[0]?.code).toBe(
			"reservation-replay-mismatch",
		);
		expect(admit("b", 0.2).ok).toBe(false);
		events.push(fact(0.2, { finalized: true, reservationId: "a" }));
		expect(admit("a", 0.2).reasons[0]?.code).toBe(
			"reservation-already-finalized",
		);
		expect(admit("b", 0.6).ok).toBe(true);
		expect(admit("c", 0.01).ok).toBe(false);
	});

	it("keeps an unsettled hold when the meter reading is incomplete", () => {
		const events: ReturnType<typeof fact>[] = [];
		const plane = createMeteredBillingPlane(events);
		expect(
			plane.authorize({
				requestId: "a",
				spendEstimateUsd: 0.7,
				billing: policy,
			}).ok,
		).toBe(true);
		events.push(fact(Number.NaN, { finalized: true, reservationId: "a" }));
		expect(
			plane.authorize({ requestId: "b", spendEstimateUsd: 0, billing: policy })
				.reasons[0]?.code,
		).toBe("metering-evidence-incomplete");
		events.pop();
		expect(
			plane.authorize({
				requestId: "b",
				spendEstimateUsd: 0.2,
				billing: policy,
			}).ok,
		).toBe(false);
	});

	it("requires explicit unused confirmation before a hold is released", () => {
		const plane = createMeteredBillingPlane([]);
		expect(
			plane.authorize({
				requestId: "a",
				spendEstimateUsd: 0.7,
				billing: policy,
			}).ok,
		).toBe(true);
		// SAFETY: Exercise the runtime boundary with a deliberately invalid caller.
		expect(() => plane.release?.("a", false as true)).toThrow();
		expect(
			plane.authorize({
				requestId: "b",
				spendEstimateUsd: 0.2,
				billing: policy,
			}).ok,
		).toBe(false);
		plane.release?.("a", true);
		expect(
			plane.authorize({
				requestId: "b",
				spendEstimateUsd: 0.2,
				billing: policy,
			}).ok,
		).toBe(true);
	});

	it("matches an integer-cent reference across generated event and hold histories", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 8 }),
				fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 8 }),
				fc.integer({ min: 0, max: 500 }),
				fc.integer({ min: 0, max: 100 }),
				(charges, requests, budget, cap) => {
					const plane = createMeteredBillingPlane(
						charges.map((cents) => fact(cents / 100)),
					);
					const billing = {
						...policy,
						budgetUsd: budget / 100,
						spendCapUsd: cap / 100,
					};
					let exposure = charges.reduce((sum, cents) => sum + cents, 0);
					for (const [index, cents] of requests.entries()) {
						const expected = cents <= cap && exposure + cents <= budget;
						const actual = plane.authorize({
							requestId: String(index),
							spendEstimateUsd: cents / 100,
							billing,
						});
						expect(actual.ok).toBe(expected);
						if (expected) exposure += cents;
					}
				},
			),
			{ seed: 614502, numRuns: 1000 },
		);
	});
});
