import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	QuoteVectorSchema,
	quoteHashOf,
	RATING_ALGORITHM_VERSION,
} from "@hobo/pricing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { ResolutionReceiptSchema } from "../src/_generated/broker_pb.js";
import { createBroker } from "../src/broker.js";
import { createBrokerHttpHandler } from "../src/http.js";
import {
	generateResolutionSigningKey,
	verifyResolution,
} from "../src/signing.js";
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

describe("broker quote-backed admission", () => {
	it("refuses caller estimates when no host pricing authority is configured", async () => {
		const gate = vi.fn(() => ({
			effect: "allow" as const,
			reasons: [],
			events: [],
		}));
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const broker = createBroker({
			...common,
			gatePlane: { evaluate: gate },
			billingPlane: { authorize: billing },
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons.map((r) => r.code)).toContain(
			"quote-authority-required",
		);
		expect(gate).not.toHaveBeenCalled();
		expect(billing).not.toHaveBeenCalled();
	});

	it("gates and reserves the attested liability for the selected immutable work", async () => {
		const gate = vi.fn(() => ({
			effect: "allow" as const,
			reasons: [],
			events: [],
		}));
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const pricing = {
			quote: vi.fn(async (context) => {
				expect(context.placements[0].definitionId).toBe(definition.id);
				expect(context.request.requestId).toBe(request.requestId);
				expect(context.bindingDigest).toMatch(/^sha256:/u);
				return quote("1");
			}),
			attest: vi.fn((context, candidate) =>
				candidate.quoteHash === quoteHashOf(candidate) &&
				context.placements[0].definitionId === definition.id
					? { liabilityBoundUsd: "5" }
					: undefined,
			),
		};
		const broker = createBroker({
			...common,
			pricingAuthority: pricing,
			gatePlane: { evaluate: gate },
			billingPlane: { authorize: billing },
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("resolved");
		expect(gate.mock.calls[0]?.[0].request.context.costEstimateUsd).toBe(5);
		expect(billing.mock.calls[0]?.[0].spendEstimateUsd).toBe(5);
		expect(billing.mock.calls[0]?.[0].requestDigest).toContain(
			pricing.quote.mock.calls[0]?.[0].bindingDigest,
		);
	});

	it("includes pricing authorization in signed receipts", async () => {
		const key = generateResolutionSigningKey();
		const offered = quote("1");
		const broker = createBroker({
			...common,
			signingKey: key,
			pricingAuthority: {
				quote: () => offered,
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
		});
		const result = await broker.resolve(request);
		if (!result.receipt || !result.signature)
			throw new Error("expected a signed receipt");
		expect(result.receipt.quoteHash).toBe(offered.quoteHash);
		expect(result.receipt.pricingBindingDigest).toMatch(/^sha256:/u);
		expect(result.receipt.authorizedUsd).toBe(5);
		expect(verifyResolution(result.receipt, result.signature)).toBe(true);
		expect(
			verifyResolution(
				{ ...result.receipt, authorizedUsd: 0 },
				result.signature,
			),
		).toBe(false);
		expect(
			verifyResolution(
				{ ...result.receipt, quoteHash: "sha256:forged" },
				result.signature,
			),
		).toBe(false);
	});

	it("refuses an unattested or over-budget quote before making a hold", async () => {
		for (const attestation of [undefined, { liabilityBoundUsd: "11" }]) {
			const billing = vi.fn(() => ({
				ok: true,
				reasons: [],
				reservationCreated: true,
			}));
			const broker = createBroker({
				...common,
				pricingAuthority: {
					quote: () => quote("1"),
					attest: () => attestation,
				},
				billingPlane: { authorize: billing },
			});
			expect((await broker.resolve(request)).outcome).toBe("rejected");
			expect(billing).not.toHaveBeenCalled();
		}
	});

	it("rechecks quote attestation after the policy gate waits", async () => {
		let checks = 0;
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => (++checks === 1 ? { liabilityBoundUsd: "5" } : undefined),
			},
			gatePlane: {
				evaluate: async () => ({ effect: "allow", reasons: [], events: [] }),
			},
			billingPlane: { authorize: billing },
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons.map((entry) => entry.code)).toContain(
			"quote-provenance-invalid",
		);
		expect(checks).toBe(2);
		expect(billing).not.toHaveBeenCalled();
	});

	it("refuses a catalog change while the policy gate waits", async () => {
		const changedCatalog = { ...catalog };
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const broker = createBroker({
			...common,
			catalog: changedCatalog,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			gatePlane: {
				evaluate: async () => {
					changedCatalog.catalogHash = "sha256:changed";
					return { effect: "allow", reasons: [], events: [] };
				},
			},
			billingPlane: { authorize: billing },
		});
		expect(
			(await broker.resolve(request)).rejection?.reasons.map(
				(entry) => entry.code,
			),
		).toContain("catalog-snapshot-stale");
		expect(billing).not.toHaveBeenCalled();
	});

	it("pins a copy of the quote even if the authority mutates its original", async () => {
		const offered = quote("1");
		const originalHash = offered.quoteHash;
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => offered,
				attest: () => {
					if (!offered.incremental?.billed) throw new Error("fixture");
					offered.incremental.billed.decimal = "0";
					offered.quoteHash = quoteHashOf(offered);
					return { liabilityBoundUsd: "5" };
				},
			},
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("resolved");
		expect(
			result.events.find((event) => event.type === "broker.Resolved")?.data
				.quoteHash,
		).toBe(originalHash);
	});

	it("refuses an authority that mutates the selected work", async () => {
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: (context) => {
					context.placements[0].providerId = "other";
					return quote("0");
				},
				attest: () => ({ liabilityBoundUsd: "0" }),
			},
			billingPlane: { authorize: billing },
		});
		expect((await broker.resolve(request)).outcome).toBe("rejected");
		expect(billing).not.toHaveBeenCalled();
	});

	it("refuses success without proof that a new hold was created", async () => {
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			billingPlane: { authorize: () => ({ ok: true, reasons: [] }) },
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons.map((entry) => entry.code)).toContain(
			"reservation-evidence-required",
		);
	});

	it("refuses environment revocation while the gate waits", async () => {
		const environment = {
			environmentId: "env",
			approved: true,
			approvedProviders: ["provider"],
		};
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const broker = createBroker({
			...common,
			environment,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			gatePlane: {
				evaluate: async () => {
					environment.approved = false;
					return { effect: "allow", reasons: [], events: [] };
				},
			},
			billingPlane: { authorize: billing },
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons.map((entry) => entry.code)).toContain(
			"environment-stale",
		);
		expect(billing).not.toHaveBeenCalled();
	});

	it("releases only a new unused hold if the catalog changes during admission", async () => {
		const changedCatalog = { ...catalog };
		const release = vi.fn();
		const broker = createBroker({
			...common,
			catalog: changedCatalog,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			billingPlane: {
				authorize: () => {
					changedCatalog.catalogHash = "sha256:changed";
					return { ok: true, reasons: [], reservationCreated: true };
				},
				release,
			},
		});
		expect((await broker.resolve(request)).outcome).toBe("rejected");
		expect(release).toHaveBeenCalledWith(request.requestId, true);
	});

	it("rejects guest requests rather than silently dropping their consent evidence", async () => {
		const billing = vi.fn(() => ({
			ok: true,
			reasons: [],
			reservationCreated: true,
		}));
		const broker = createBroker({
			...common,
			billingPlane: { authorize: billing },
		});
		await expect(
			broker.resolve({ ...request, guest: { recipeId: "recipe" } }),
		).rejects.toThrow(/guest-resolution-unavailable/u);
		expect(billing).not.toHaveBeenCalled();
	});

	it("rechecks catalog and environment after the final attestation", async () => {
		for (const field of ["catalog", "environment"]) {
			const changedCatalog = { ...catalog };
			const environment = {
				environmentId: "env",
				approved: true,
				approvedProviders: ["provider"],
			};
			const billing = vi.fn(() => ({
				ok: true,
				reasons: [],
				reservationCreated: true,
			}));
			let checks = 0;
			const broker = createBroker({
				...common,
				catalog: changedCatalog,
				environment,
				pricingAuthority: {
					quote: () => quote("1"),
					attest: () => {
						if (++checks === 2) {
							if (field === "catalog")
								changedCatalog.catalogHash = "sha256:changed";
							else environment.approved = false;
						}
						return { liabilityBoundUsd: "5" };
					},
				},
				billingPlane: { authorize: billing },
			});
			expect((await broker.resolve(request)).outcome).toBe("rejected");
			expect(billing).not.toHaveBeenCalled();
		}
	});

	it("preserves all pricing fields over protobuf and HTTP delivery", async () => {
		const wire = create(ResolutionReceiptSchema, {
			quoteHash: "sha256:quote",
			pricingBindingDigest: "sha256:binding",
			authorizedUsd: 0,
		});
		const decoded = fromBinary(
			ResolutionReceiptSchema,
			toBinary(ResolutionReceiptSchema, wire),
		);
		expect(decoded.authorizedUsd).toBe(0);
		expect(decoded.quoteHash).toBe("sha256:quote");
		expect(decoded.pricingBindingDigest).toBe("sha256:binding");
		const delivered = vi.fn((receipt) => ({
			engine: "in-proc",
			reconcilerMode: "conductor" as const,
			target: "local",
			document: {},
			receipt,
		}));
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("0"),
				attest: () => ({ liabilityBoundUsd: "0" }),
			},
			deliveryPlane: { submit: delivered },
		});
		const result = await broker.resolve(request);
		if (!result.receipt) throw new Error("expected a receipt");
		const handler = createBrokerHttpHandler(broker);
		expect(
			(
				await handler({
					method: "POST",
					path: "/broker/deliver",
					body: result.receipt,
				})
			).status,
		).toBe(200);
		expect(delivered.mock.calls[0]?.[0]).toEqual(result.receipt);
		const partial = { ...result.receipt };
		delete partial.authorizedUsd;
		expect(
			(
				await handler({
					method: "POST",
					path: "/broker/deliver",
					body: partial,
				})
			).status,
		).toBe(400);
	});

	it("enforces quote, environment and hold guards across generated admissions", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 12 }),
				fc.integer({ min: 0, max: 12 }),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				async (quoted, bound, attested, revoked, holdConfirmed) => {
					const environment = {
						environmentId: "env",
						approved: true,
						approvedProviders: ["provider"],
					};
					const billed: number[] = [];
					const broker = createBroker({
						...common,
						environment,
						pricingAuthority: {
							quote: () => quote(String(quoted)),
							attest: () =>
								attested ? { liabilityBoundUsd: String(bound) } : undefined,
						},
						gatePlane: {
							evaluate: async () => {
								if (revoked) environment.approved = false;
								return { effect: "allow", reasons: [], events: [] };
							},
						},
						billingPlane: {
							authorize: (input) => {
								billed.push(input.spendEstimateUsd);
								return holdConfirmed
									? { ok: true, reasons: [], reservationCreated: true }
									: { ok: true, reasons: [] };
							},
						},
					});
					const result = await broker.resolve(request);
					const expected =
						attested &&
						bound >= quoted &&
						bound <= 10 &&
						!revoked &&
						holdConfirmed;
					expect(result.outcome === "resolved").toBe(expected);
					if (billed.length) expect(billed).toEqual([bound]);
					if (expected) expect(result.receipt?.authorizedUsd).toBe(bound);
				},
			),
			{ seed: 614516, numRuns: 350 },
		);
	});

	it("retains no new hold when a quote expires while billing creates it", async () => {
		let fresh = true;
		const release = vi.fn();
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => (fresh ? { liabilityBoundUsd: "5" } : undefined),
			},
			billingPlane: {
				authorize: () => {
					fresh = false;
					return { ok: true, reasons: [], reservationCreated: true };
				},
				release,
			},
		});
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(release).toHaveBeenCalledWith(request.requestId, true);
	});
});
