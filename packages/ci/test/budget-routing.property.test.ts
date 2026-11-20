import { create } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	AccountSchema,
	LeaseSchema,
	OfferSchema,
} from "../src/_generated/ci_pb.js";
import { route, shouldCountLocalUsage } from "../src/routing.js";

const NOW = "2026-10-26T12:00:00.000Z";
const CHECK = { seed: 614436, numRuns: 400 };

describe("CI routing budget properties", () => {
	it("counts active holds and unobserved settlement before admitting a paid runner", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 500 }),
				fc.integer({ min: 0, max: 100 }),
				fc.integer({ min: 0, max: 100 }),
				fc.integer({ min: 0, max: 100 }),
				fc.constantFrom(
					"reserved",
					"running",
					"uncertain",
					"completed",
					"released",
				),
				(cap, spent, exposure, price, state) => {
					const offer = create(OfferSchema, {
						id: "offer",
						provider: "blacksmith",
						providerAccountId: "provider-account",
						enabled: true,
						bridgeAcknowledged: true,
						freeMinutes: 0,
						priceMicrosPerMinute: price,
						budgetMicros: 1_000_000,
						concurrency: 2,
						observedAt: "2026-10-26T00:00:00.000Z",
						validUntil: "2026-11-01T00:00:00.000Z",
					});
					const account = create(AccountSchema, {
						id: "account",
						budgetMicros: cap,
						spentMicros: spent,
						maxRuntimeMinutes: 1,
						startupMinutes: 0,
						offers: [offer],
					});
					const lease = create(LeaseSchema, {
						accountId: "account",
						provider: "other-provider",
						providerAccountId: "other-account",
						state,
						reservedPaidMicros: exposure,
						paidMicros: exposure,
						usageCompletedAt: NOW,
						settledAt: NOW,
					});
					const counted = state === "released" ? 0 : exposure;
					const decision = route(account, [lease], NOW);
					expect(decision !== undefined).toBe(spent + counted + price <= cap);
					if (decision) expect(decision.paidMicros).toBe(price);
				},
			),
			CHECK,
		);
	});

	it("counts completions at or after a usage observation, including equal timestamps", () => {
		fc.assert(
			fc.property(fc.integer({ min: -10_000, max: 10_000 }), (offset) => {
				const completed = new Date(Date.parse(NOW) + offset).toISOString();
				const lease = create(LeaseSchema, { usageCompletedAt: completed });
				expect(shouldCountLocalUsage(lease, NOW)).toBe(offset >= 0);
			}),
			CHECK,
		);
	});
});

it("uses the highest exposure for every offer sharing a provider account", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 1000 }),
			fc.integer({ min: 1, max: 100 }),
			fc.integer({ min: 1, max: 100 }),
			fc.boolean(),
			fc.boolean(),
			(lower, extra, cost, allow, sharedPolicy) => {
				const higher = lower + extra;
				const ceiling = higher + cost - (allow ? 0 : 1);
				const offer = (id: string, spentMicros: number) =>
					create(OfferSchema, {
						id,
						provider: "blacksmith",
						providerAccountId: "provider-account",
						enabled: true,
						bridgeAcknowledged: true,
						priceMicrosPerMinute: cost,
						budgetMicros: sharedPolicy ? 1_000_000 : ceiling,
						spentMicros,
						concurrency: 2,
						observedAt: "2026-10-26T00:00:00.000Z",
						validUntil: "2026-11-01T00:00:00.000Z",
					});
				const a = create(AccountSchema, {
					id: "account",
					budgetMicros: 1_000_000,
					maxRuntimeMinutes: 1,
					startupMinutes: 0,
					offers: [offer("lower", lower), offer("higher", higher)],
				});
				if (sharedPolicy)
					a.budgetPolicy = {
						schemaVersion: "hobo.budget-policy/v1",
						tenantId: "tenant",
						budgetId: "ci",
						periodId: "manual-1",
						revision: "r1",
						workloads: ["ci"],
						currency: "USD",
						limitMicros: 1_000_000,
						objective: "min-cost",
						enforcement: "conservative",
						periodKind: "manual",
						constraints: [
							{
								key: "provider.cost",
								workload: "ci",
								unit: "USD.micros",
								maximum: ceiling,
								target: "provider-account",
							},
						],
					};
				expect(route(a, [], NOW) !== undefined).toBe(allow);
				a.offers.reverse();
				expect(route(a, [], NOW) !== undefined).toBe(allow);
			},
		),
		{ seed: 614451, numRuns: 400 },
	);
});

it("counts completed usage when the observation time is unknown", () => {
	const lease = create(LeaseSchema, { usageCompletedAt: NOW });
	for (const observedAt of ["", "unknown", "not-a-date"]) {
		expect(shouldCountLocalUsage(lease, observedAt)).toBe(true);
	}
});

it("refuses duplicate account reports that can overstate free allocation", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 1, max: 100 }),
			fc.integer({ min: 1, max: 100 }),
			(credit, price) => {
				const offer = (id: string, freeMinutes: number) =>
					create(OfferSchema, {
						id,
						provider: "blacksmith",
						providerAccountId: "provider-account",
						enabled: true,
						bridgeAcknowledged: true,
						freeMinutes,
						priceMicrosPerMinute: price,
						concurrency: 2,
						observedAt: "2026-10-26T00:00:00.000Z",
						validUntil: "2026-11-01T00:00:00.000Z",
					});
				const account = create(AccountSchema, {
					id: "account",
					maxRuntimeMinutes: 1,
					offers: [offer("reported-free", credit), offer("no-free", 0)],
				});
				expect(route(account, [], NOW)).toBeUndefined();
				account.offers.reverse();
				expect(route(account, [], NOW)).toBeUndefined();
				account.budgetMicros = price;
				account.offers.push(
					create(OfferSchema, {
						id: "other-provider",
						provider: "github",
						providerAccountId: "other-account",
						enabled: true,
						bridgeAcknowledged: true,
						priceMicrosPerMinute: price,
						budgetMicros: price,
						concurrency: 2,
						observedAt: "2026-10-26T00:00:00.000Z",
						validUntil: "2026-11-01T00:00:00.000Z",
					}),
				);
				expect(route(account, [], NOW)?.offer.id).toBe("other-provider");
			},
		),
		{ seed: 614452, numRuns: 100 },
	);
});

it("counts repeated references as duplicate account reports", () => {
	const shared = create(OfferSchema, {
		id: "same",
		provider: "blacksmith",
		providerAccountId: "provider-account",
		enabled: true,
		bridgeAcknowledged: true,
		freeMinutes: 1,
		priceMicrosPerMinute: 1,
		concurrency: 2,
		observedAt: "2026-10-26T00:00:00.000Z",
		validUntil: "2026-11-01T00:00:00.000Z",
	});
	const account = create(AccountSchema, {
		id: "account",
		maxRuntimeMinutes: 1,
	});
	account.offers.push(shared, shared);
	expect(route(account, [], NOW)).toBeUndefined();
});
