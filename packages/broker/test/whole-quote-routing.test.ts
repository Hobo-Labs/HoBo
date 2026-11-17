import { create } from "@bufbuild/protobuf";
import {
	QuoteVectorSchema,
	quoteHashOf,
	RATING_ALGORITHM_VERSION,
} from "@hobo/pricing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { createBroker, type HoboBrokerDeps } from "../src/broker.js";
import type { BrokerCatalog, BrokerCatalogDefinition } from "../src/types.js";

const definition: BrokerCatalogDefinition = {
	id: "provider:service",
	providerId: "provider",
	port: "service",
	features: [],
	regions: ["region"],
	cost: { sku: "paid", unit: "hour", marginalPrice: "1" },
	satisfies: () => ({ kind: "full" }),
};
const catalog: BrokerCatalog = {
	catalogHash: "sha256:catalog",
	definitions: () => [definition],
};
const policies = {
	schemaVersion: "hobo.broker/v1",
	brokerId: "broker:test",
	placementPolicies: [
		{ id: "all", scopeKind: "bindle", objective: "min-cost" },
	],
	billing: {
		quota: "q",
		quotaUsed: 0,
		quotaLimit: 10,
		budgetUsd: 10,
		spendCapUsd: 10,
	},
	delivery: {
		engine: "argo",
		syncMode: "auto",
		prune: false,
		gitopsRepo: "https://example.test/repo",
		destinationNamespace: "default",
	},
};
const request = {
	schemaVersion: "hobo.broker/v1",
	requestId: "req-1",
	scope: { bindleId: "bindle" },
	requirements: [{ resourceId: "api", port: "service", features: [] }],
	spendEstimateUsd: 0,
};
const common = {
	policies,
	catalog,
	stationId: "station:test",
	railHash: `sha256:${"a".repeat(64)}`,
};
function quote(amount: string) {
	const value = create(QuoteVectorSchema, {
		schema: "hobo.pricing.quote/v1",
		ratingAlgorithmVersion: RATING_ALGORITHM_VERSION,
		incremental: { billed: { decimal: amount, currency: "USD" } },
		eligibility: { eligible: true },
	});
	value.quoteHash = quoteHashOf(value);
	return value;
}

function candidate(
	providerId: string,
	id: string,
	price: string,
	unit = "hour",
): BrokerCatalogDefinition {
	return {
		...definition,
		providerId,
		id,
		cost: { sku: id, unit, marginalPrice: price },
	};
}
describe("whole-request quote routing", () => {
	it("chooses the cheapest attested whole-request quote rather than the cheapest marginal price", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		const billed: number[] = [];
		const broker = createBroker({
			...common,
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => definitions,
			},
			pricingAuthority: {
				quote: (context) =>
					quote(context.placements[0].providerId === "a" ? "9" : "2"),
				attest: (_context, offered) => ({
					liabilityBoundUsd: offered.incremental?.billed?.decimal ?? "0",
				}),
			},
			billingPlane: {
				authorize: (input) => {
					billed.push(input.spendEstimateUsd);
					return { ok: true, reasons: [], reservationCreated: true };
				},
			},
		});
		const result = await broker.resolve(request);
		expect(result.receipt?.placements[0]?.providerId).toBe("z");
		expect(billed).toEqual([2]);
	});

	it("finds a statically affordable alternative when the first candidate exceeds the cap", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		const broker = createBroker({
			...common,
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => definitions,
			},
			pricingAuthority: {
				quote: (context) =>
					quote(context.placements[0].providerId === "a" ? "11" : "2"),
				attest: (_context, offered) => ({
					liabilityBoundUsd: offered.incremental?.billed?.decimal ?? "0",
				}),
			},
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.placements[0]?.providerId).toBe("z");
	});

	it("compares complete USD quotes even when marginal units differ", async () => {
		const definitions = [
			candidate("a", "a", "0.01", "hour"),
			candidate("z", "z", "0.02", "request"),
		];
		const broker = createBroker({
			...common,
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => definitions,
			},
			pricingAuthority: {
				quote: (context) =>
					quote(context.placements[0].providerId === "a" ? "9" : "2"),
				attest: (_context, offered) => ({
					liabilityBoundUsd: offered.incremental?.billed?.decimal ?? "0",
				}),
			},
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.placements[0]?.providerId).toBe("z");
	});

	it("fails closed when a candidate quote is unavailable", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const broker = createBroker({
			...common,
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => definitions,
			},
			pricingAuthority: {
				quote: (context) =>
					context.placements[0].providerId === "a" ? quote("1") : undefined,
				attest: () => ({ liabilityBoundUsd: "1" }),
			},
			billingPlane: { authorize: billing },
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe(
			"quote-authority-unavailable",
		);
		expect(billing).not.toHaveBeenCalled();
	});

	it("refuses an exhaustive search that exceeds its safety bound", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		const pricing = vi.fn(() => quote("1"));
		const broker = createBroker({
			...common,
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => definitions,
			},
			pricingAuthority: {
				quote: pricing,
				attest: () => ({ liabilityBoundUsd: "1" }),
			},
		});
		const many = {
			...request,
			requirements: Array.from({ length: 9 }, (_, index) => ({
				resourceId: `r${index}`,
				port: "service",
				features: [],
			})),
		};
		const result = await broker.resolve(many);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe("quote-search-limit");
		expect(pricing).not.toHaveBeenCalled();
	});

	it("quotes complete combinations instead of ranking each resource separately", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		const broker = createBroker({
			...common,
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => definitions,
			},
			pricingAuthority: {
				quote: (context) =>
					quote(
						context.placements.every((entry) => entry.providerId === "z")
							? "1"
							: "9",
					),
				attest: (_context, offered) => ({
					liabilityBoundUsd: offered.incremental?.billed?.decimal ?? "0",
				}),
			},
		});
		const result = await broker.resolve({
			...request,
			requirements: [
				{ resourceId: "one", port: "service" },
				{ resourceId: "two", port: "service" },
			],
		});
		expect(result.receipt?.placements.map((entry) => entry.providerId)).toEqual(
			["z", "z"],
		);
	});

	it("quotes eligible regions rather than assuming the first region is cheapest", async () => {
		const regional = {
			...candidate("a", "a", "1"),
			regions: ["region", "cheap-region"],
		};
		const broker = createBroker({
			...common,
			catalog: { catalogHash: "sha256:catalog", definitions: () => [regional] },
			pricingAuthority: {
				quote: (context) =>
					quote(context.placements[0].region === "region" ? "9" : "2"),
				attest: (_context, offered) => ({
					liabilityBoundUsd: offered.incremental?.billed?.decimal ?? "0",
				}),
			},
		});
		const result = await broker.resolve(request);
		expect(result.receipt?.placements[0]?.region).toBe("cheap-region");
	});

	it("fails closed on an ineligible or incomplete competing quote", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const broker = createBroker({
			...common,
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => definitions,
			},
			pricingAuthority: {
				quote: (context) => {
					const offered = quote("1");
					if (context.placements[0].providerId === "z") {
						if (!offered.eligibility) throw new Error("missing eligibility");
						offered.eligibility.eligible = false;
						offered.quoteHash = quoteHashOf(offered);
					}
					return offered;
				},
				attest: () => ({ liabilityBoundUsd: "1" }),
			},
			billingPlane: { authorize: billing },
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(billing).not.toHaveBeenCalled();
	});

	it("chooses the lowest statically affordable attested total in generated candidate sets", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						price: fc.integer({ min: 0, max: 15 }),
						extra: fc.integer({ min: 0, max: 6 }),
					}),
					{ minLength: 1, maxLength: 6 },
				),
				async (rows) => {
					const definitions = rows.map((_, index) =>
						candidate(
							`p-${index}`,
							`d-${index}`,
							`0.${String(index).padStart(2, "0")}`,
						),
					);
					const billing = vi.fn((input) => ({
						ok: true,
						reasons: [],
						reservationCreated: true,
						amount: input.spendEstimateUsd,
					}));
					const pricing = vi.fn((context) => {
						const index = Number(context.placements[0].providerId.slice(2));
						return quote(String(rows[index].price));
					});
					const broker = createBroker({
						...common,
						catalog: {
							catalogHash: "sha256:catalog",
							definitions: () => definitions,
						},
						pricingAuthority: {
							quote: pricing,
							attest: (context) => {
								const index = Number(context.placements[0].providerId.slice(2));
								return {
									liabilityBoundUsd: String(
										rows[index].price + rows[index].extra,
									),
								};
							},
						},
						billingPlane: { authorize: billing },
					});
					const result = await broker.resolve(request);
					const eligible = rows
						.map((row, index) => ({ ...row, index }))
						.filter((row) => row.price + row.extra <= 10)
						.sort((a, b) => a.price - b.price || a.index - b.index);
					if (!eligible.length) {
						expect(result.outcome).toBe("rejected");
						expect(billing).not.toHaveBeenCalled();
					} else {
						expect(result.outcome).toBe("resolved");
						expect(result.receipt?.placements[0]?.providerId).toBe(
							`p-${eligible[0].index}`,
						);
						expect(billing.mock.calls[0]?.[0].spendEstimateUsd).toBe(
							eligible[0].price + eligible[0].extra,
						);
					}
					expect(pricing).toHaveBeenCalledTimes(rows.length);
				},
			),
			{ seed: 614520, numRuns: 180 },
		);
	});

	it("tries another quoted plan when existing holds make the cheapest unaffordable", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		const broker = createBroker({
			...common,
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => definitions,
			},
			pricingAuthority: {
				quote: (context) =>
					quote(
						context.request.requestId === "prior"
							? "0"
							: context.placements[0].providerId === "a"
								? "1"
								: "2",
					),
				attest: (context) => ({
					liabilityBoundUsd:
						context.request.requestId === "prior"
							? "8"
							: context.placements[0].providerId === "a"
								? "3"
								: "2",
				}),
			},
		});
		expect(
			(await broker.resolve({ ...request, requestId: "prior" })).outcome,
		).toBe("resolved");
		const result = await broker.resolve({ ...request, requestId: "next" });
		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.placements[0]?.providerId).toBe("z");
		expect(result.receipt?.authorizedUsd).toBe(2);
		const declined = result.events.find(
			(event) => event.type === "broker.CandidateUnaffordable",
		);
		expect(declined?.data).toMatchObject({
			authorizedUsd: 3,
			quoteHash: expect.stringMatching(/^sha256:/u),
			bindingDigest: expect.stringMatching(/^sha256:/u),
		});
	});

	it("never retries a candidate after ambiguous or non-budget billing denial", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		for (const denial of [
			{
				ok: false,
				reasons: [
					{
						plane: "billing" as const,
						code: "budget-exceeded",
						message: "denied",
					},
				],
			},
			{
				ok: false,
				reasons: [
					{
						plane: "billing" as const,
						code: "budget-exceeded",
						message: "denied",
					},
				],
				noReservationCreated: true as const,
				reservationCreated: true,
			},
			{
				ok: false,
				reasons: [
					{
						plane: "billing" as const,
						code: "metering-evidence-incomplete",
						message: "unknown",
					},
				],
				noReservationCreated: true as const,
			},
		]) {
			const billing = vi.fn(() => denial);
			const broker = createBroker({
				...common,
				catalog: {
					catalogHash: "sha256:catalog",
					definitions: () => definitions,
				},
				pricingAuthority: {
					quote: (context) =>
						quote(context.placements[0].providerId === "a" ? "1" : "2"),
					attest: (_context, offered) => ({
						liabilityBoundUsd: offered.incremental?.billed?.decimal ?? "0",
					}),
				},
				billingPlane: { authorize: billing },
			});
			expect((await broker.resolve(request)).outcome).toBe("rejected");
			expect(billing).toHaveBeenCalledTimes(1);
		}
	});

	it("refuses a changed catalog before retrying a denied candidate", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		const changingCatalog = {
			catalogHash: "sha256:catalog",
			definitions: () => definitions,
		};
		const billing = vi.fn(() => {
			changingCatalog.catalogHash = "sha256:changed";
			return {
				ok: false,
				reasons: [
					{
						plane: "billing" as const,
						code: "budget-exceeded",
						message: "denied",
					},
				],
				noReservationCreated: true as const,
			};
		});
		const broker = createBroker({
			...common,
			catalog: changingCatalog,
			pricingAuthority: {
				quote: (context) =>
					quote(context.placements[0].providerId === "a" ? "1" : "2"),
				attest: (_context, offered) => ({
					liabilityBoundUsd: offered.incremental?.billed?.decimal ?? "0",
				}),
			},
			billingPlane: { authorize: billing },
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe("catalog-snapshot-stale");
		expect(billing).toHaveBeenCalledTimes(1);
	});

	it("returns a cataloged billing refusal when a billing plane gives no reasons", async () => {
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "1" }),
			},
			billingPlane: { authorize: () => ({ ok: false, reasons: [] }) },
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe("billing-denied");
	});

	it("refuses a catalog change during candidate enumeration before requesting quotes", async () => {
		const changingCatalog = {
			catalogHash: "sha256:catalog",
			definitions: () => [changing],
		};
		const changing = {
			...candidate("a", "a", "1"),
			satisfies: () => {
				changingCatalog.catalogHash = "sha256:changed";
				return { kind: "full" as const };
			},
		};
		const pricing = vi.fn(() => quote("1"));
		const broker = createBroker({
			...common,
			catalog: changingCatalog,
			pricingAuthority: {
				quote: pricing,
				attest: () => ({ liabilityBoundUsd: "1" }),
			},
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe("catalog-snapshot-stale");
		expect(pricing).not.toHaveBeenCalled();
	});

	it("evaluates every plan when the search reaches the limit exactly", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		const pricing = vi.fn(() => quote("1"));
		const broker = createBroker({
			...common,
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => definitions,
			},
			pricingAuthority: {
				quote: pricing,
				attest: () => ({ liabilityBoundUsd: "1" }),
			},
		});
		const many = {
			...request,
			requirements: Array.from({ length: 7 }, (_, index) => ({
				resourceId: `r${index}`,
				port: "service",
				features: [],
			})),
		};
		const result = await broker.resolve(many);
		expect(result.outcome).toBe("resolved");
		expect(pricing).toHaveBeenCalledTimes(128);
	});

	it("refuses duplicate resource identities before quoting any plan", async () => {
		const pricing = vi.fn(() => quote("1"));
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: pricing,
				attest: () => ({ liabilityBoundUsd: "1" }),
			},
		});
		const duplicate = {
			...request,
			requirements: [
				{ resourceId: "same", port: "service" },
				{ resourceId: "same", port: "service" },
			],
		};
		await expect(broker.resolve(duplicate)).rejects.toThrow(
			/duplicate-resource-id/u,
		);
		expect(pricing).not.toHaveBeenCalled();
	});

	it("finds the lowest quoted plan that fits generated existing holds", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 10 }),
				fc.array(
					fc.record({
						price: fc.integer({ min: 0, max: 10 }),
						extra: fc.integer({ min: 0, max: 6 }),
					}),
					{ minLength: 1, maxLength: 5 },
				),
				async (held, rows) => {
					const definitions = rows.map((_, index) =>
						candidate(
							`p-${index}`,
							`d-${index}`,
							`0.${String(index).padStart(2, "0")}`,
						),
					);
					const rowFor = (providerId: string) => {
						const row = rows[Number(providerId.slice(2))];
						if (!row) throw new Error("missing candidate");
						return row;
					};
					const broker = createBroker({
						...common,
						catalog: {
							catalogHash: "sha256:catalog",
							definitions: () => definitions,
						},
						pricingAuthority: {
							quote: (context) =>
								quote(
									context.request.requestId === "prior"
										? "0"
										: String(rowFor(context.placements[0].providerId).price),
								),
							attest: (context) => {
								const row = rowFor(context.placements[0].providerId);
								return {
									liabilityBoundUsd: String(
										context.request.requestId === "prior"
											? held
											: row.price + row.extra,
									),
								};
							},
						},
					});
					expect(
						(await broker.resolve({ ...request, requestId: "prior" })).outcome,
					).toBe("resolved");
					const result = await broker.resolve({
						...request,
						requestId: "next",
					});
					const eligible = rows
						.map((row, index) => ({ ...row, index }))
						.filter((row) => row.price + row.extra <= 10 - held)
						.sort((a, b) => a.price - b.price || a.index - b.index);
					if (!eligible.length) expect(result.outcome).toBe("rejected");
					else {
						expect(result.outcome).toBe("resolved");
						expect(result.receipt?.placements[0]?.providerId).toBe(
							`p-${eligible[0].index}`,
						);
						expect(result.receipt?.authorizedUsd).toBe(
							eligible[0].price + eligible[0].extra,
						);
					}
				},
			),
			{ seed: 614521, numRuns: 120 },
		);
	});

	it("does not bypass a policy approval requirement by trying another quote", async () => {
		const definitions = [
			candidate("a", "a", "0.01"),
			candidate("z", "z", "0.02"),
		];
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const gate = vi.fn(() => ({
			effect: "require-approval" as const,
			reasons: [],
			events: [],
		}));
		const broker = createBroker({
			...common,
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => definitions,
			},
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "1" }),
			},
			gatePlane: { evaluate: gate },
			billingPlane: { authorize: billing },
		});
		expect((await broker.resolve(request)).outcome).toBe("rejected");
		expect(gate).toHaveBeenCalledTimes(1);
		expect(billing).not.toHaveBeenCalled();
	});

	it("refuses a pricing authority replacement while the policy gate waits", async () => {
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const replacement = {
			quote: () => quote("1"),
			attest: () => ({ liabilityBoundUsd: "1" }),
		};
		const deps: HoboBrokerDeps = {
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "1" }),
			},
			gatePlane: {
				evaluate: async () => {
					deps.pricingAuthority = replacement;
					return { effect: "allow", reasons: [], events: [] };
				},
			},
			billingPlane: { authorize: billing },
		};
		const result = await createBroker(deps).resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe("quote-authority-stale");
		expect(billing).not.toHaveBeenCalled();
	});

	it.each([
		"quote",
		"search attestation",
		"pre-hold attestation",
		"post-hold attestation",
	])("refuses pricing authority replacement during %s", async (stage) => {
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const release = vi.fn();
		let attestations = 0;
		const replacement = {
			quote: () => quote("1"),
			attest: () => ({ liabilityBoundUsd: "1" }),
		};
		const deps: HoboBrokerDeps = {
			...common,
			pricingAuthority: {
				quote: () => {
					if (stage === "quote") deps.pricingAuthority = replacement;
					return quote("1");
				},
				attest: () => {
					attestations++;
					if (
						(stage === "search attestation" && attestations === 1) ||
						(stage === "pre-hold attestation" && attestations === 2) ||
						(stage === "post-hold attestation" && attestations === 3)
					)
						deps.pricingAuthority = replacement;
					return { liabilityBoundUsd: "1" };
				},
			},
			billingPlane: { authorize: billing, release },
		};
		const result = await createBroker(deps).resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe("quote-authority-stale");
		if (stage === "post-hold attestation") {
			expect(release).toHaveBeenCalledWith(request.requestId, true);
		} else {
			expect(billing).not.toHaveBeenCalled();
		}
	});

	it("releases a new unused hold if pricing authority changes during billing", async () => {
		const release = vi.fn();
		const replacement = {
			quote: () => quote("1"),
			attest: () => ({ liabilityBoundUsd: "1" }),
		};
		const deps: HoboBrokerDeps = {
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "1" }),
			},
			billingPlane: {
				authorize: () => {
					deps.pricingAuthority = replacement;
					return { ok: true, reasons: [], reservationCreated: true };
				},
				release,
			},
		};
		const result = await createBroker(deps).resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe("quote-authority-stale");
		expect(release).toHaveBeenCalledWith(request.requestId, true);
	});
});
