import { create } from "@bufbuild/protobuf";
import {
	QuoteVectorSchema,
	quoteHashOf,
	RATING_ALGORITHM_VERSION,
} from "@hobo/pricing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { createBroker } from "../src/broker.js";
import { createBrokerHttpHandler } from "../src/http.js";
import { createReconcilerDeliveryPlane } from "../src/planes.js";
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

describe("broker delivery authorization", () => {
	it("refuses forged or foreign receipts before calling delivery", async () => {
		const submit = vi.fn(async () => ({
			engine: "in-proc",
			reconcilerMode: "conductor" as const,
			target: "local",
			document: {},
		}));
		const makeBroker = () =>
			createBroker({
				...common,
				pricingAuthority: {
					quote: () => quote("1"),
					attest: () => ({ liabilityBoundUsd: "5" }),
				},
				deliveryPlane: { submit },
			});
		const broker = makeBroker();
		const receipt = (await broker.resolve(request)).receipt;
		if (!receipt) throw new Error("expected a receipt");
		const forged = {
			...receipt,
			placements: receipt.placements.map((p) => ({
				...p,
				providerId: "attacker",
			})),
		};
		await expect(broker.deliver(forged)).rejects.toThrow(
			/delivery-receipt-untrusted/u,
		);
		await expect(makeBroker().deliver(receipt)).rejects.toThrow(
			/delivery-receipt-untrusted/u,
		);
		expect(submit).not.toHaveBeenCalled();
	});

	it("refuses an expired quote before dispatch without releasing its hold", async () => {
		let fresh = true;
		const submit = vi.fn(async () => ({
			engine: "in-proc",
			reconcilerMode: "conductor" as const,
			target: "local",
			document: {},
		}));
		const release = vi.fn();
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => (fresh ? { liabilityBoundUsd: "5" } : undefined),
			},
			billingPlane: {
				authorize: () => ({ ok: true, reasons: [], reservationCreated: true }),
				release,
			},
			deliveryPlane: { submit },
		});
		const receipt = (await broker.resolve(request)).receipt;
		if (!receipt) throw new Error("expected a receipt");
		fresh = false;
		await expect(broker.deliver(receipt)).rejects.toThrow(
			/delivery-quote-stale/u,
		);
		expect(submit).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
	});

	it("dispatches once across concurrent and repeated delivery attempts", async () => {
		let finish: (() => void) | undefined;
		const wait = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const submit = vi.fn(async () => {
			await wait;
			return {
				engine: "in-proc",
				reconcilerMode: "conductor" as const,
				target: "local",
				document: {},
			};
		});
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			deliveryPlane: { submit },
		});
		const receipt = (await broker.resolve(request)).receipt;
		if (!receipt) throw new Error("expected a receipt");
		const first = broker.deliver(receipt);
		const second = broker.deliver(receipt).then(
			() => undefined,
			(error) => error,
		);
		await Promise.resolve();
		finish?.();
		await first;
		expect(await second).toMatchObject({ code: "delivery-already-claimed" });
		await expect(broker.deliver(receipt)).rejects.toThrow(
			/delivery-already-claimed/u,
		);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("does not reissue an ambiguous delivery failure", async () => {
		const submit = vi.fn(async () => {
			throw new Error("connection closed after submission");
		});
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			deliveryPlane: { submit },
		});
		const receipt = (await broker.resolve(request)).receipt;
		if (!receipt) throw new Error("expected a receipt");
		await expect(broker.deliver(receipt)).rejects.toThrow(/connection closed/u);
		await expect(broker.deliver(receipt)).rejects.toThrow(
			/delivery-already-claimed/u,
		);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("serializes concurrent resolutions for the same request even with a faulty billing plane", async () => {
		let finish: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: async () => {
					await waiting;
					return quote("1");
				},
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			billingPlane: {
				authorize: () => ({ ok: true, reasons: [], reservationCreated: true }),
			},
		});
		const first = broker.resolve(request);
		const second = broker.resolve(request);
		finish?.();
		const results = await Promise.all([first, second]);
		expect(results.map((result) => result.outcome).sort()).toEqual([
			"rejected",
			"resolved",
		]);
	});

	it("passes a snapshot to delivery even if the caller changes its receipt", async () => {
		let finish: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let seen = "";
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			deliveryPlane: {
				submit: async (receipt) => {
					await waiting;
					seen = receipt.placements[0]?.providerId ?? "";
					return {
						engine: "in-proc",
						reconcilerMode: "conductor",
						target: "local",
						document: {},
					};
				},
			},
		});
		const receipt = (await broker.resolve(request)).receipt;
		if (!receipt?.placements[0]) throw new Error("expected a receipt");
		const pending = broker.deliver(receipt);
		receipt.placements[0].providerId = "changed";
		finish?.();
		await pending;
		expect(seen).toBe("provider");
	});

	it("rejects changed environments and forged HTTP receipts before delivery", async () => {
		const environment = {
			environmentId: "env",
			approved: true,
			approvedProviders: ["provider"],
		};
		const submit = vi.fn(async () => ({
			engine: "in-proc",
			reconcilerMode: "conductor" as const,
			target: "local",
			document: {},
		}));
		const broker = createBroker({
			...common,
			environment,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			deliveryPlane: { submit },
		});
		const receipt = (await broker.resolve(request)).receipt;
		if (!receipt) throw new Error("expected a receipt");
		const handler = createBrokerHttpHandler(broker);
		const forged = { ...receipt, authorizedUsd: 0 };
		expect(
			(await handler({ method: "POST", path: "/broker/deliver", body: forged }))
				.status,
		).toBe(400);
		environment.approved = false;
		await expect(broker.deliver(receipt)).rejects.toThrow(
			/delivery-context-stale/u,
		);
		expect(submit).not.toHaveBeenCalled();
	});

	it("submits at most once across generated stale, forged and retry histories", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.constantFrom(
						"expire",
						"refresh",
						"fail",
						"recover",
						"forged",
						"deliver",
					),
					{ minLength: 1, maxLength: 14 },
				),
				async (steps) => {
					let fresh = true;
					let fails = false;
					let calls = 0;
					const release = vi.fn();
					const broker = createBroker({
						...common,
						pricingAuthority: {
							quote: () => quote("1"),
							attest: () => (fresh ? { liabilityBoundUsd: "5" } : undefined),
						},
						billingPlane: {
							authorize: () => ({
								ok: true,
								reasons: [],
								reservationCreated: true,
							}),
							release,
						},
						deliveryPlane: {
							submit: async () => {
								calls++;
								if (fails) throw new Error("uncertain");
								return {
									engine: "in-proc",
									reconcilerMode: "conductor",
									target: "local",
									document: {},
								};
							},
						},
					});
					const receipt = (await broker.resolve(request)).receipt;
					if (!receipt) throw new Error("expected a receipt");
					let claimed = false;
					for (const step of steps) {
						if (step === "expire") fresh = false;
						else if (step === "refresh") fresh = true;
						else if (step === "fail") fails = true;
						else if (step === "recover") fails = false;
						else {
							const input =
								step === "forged" ? { ...receipt, authorizedUsd: 0 } : receipt;
							const before = calls;
							try {
								await broker.deliver(input);
							} catch {
								/* Refusal or uncertain dispatch. */
							}
							const shouldDispatch = step === "deliver" && fresh && !claimed;
							expect(calls - before).toBe(shouldDispatch ? 1 : 0);
							if (shouldDispatch) claimed = true;
						}
						expect(calls).toBeLessThanOrEqual(1);
					}
					expect(release).not.toHaveBeenCalled();
				},
			),
			{ seed: 614517, numRuns: 250 },
		);
	});

	it("claims delivery before an attestor can reenter it", async () => {
		let reenter = false;
		let retried: Promise<unknown> | undefined;
		let receipt: Awaited<
			ReturnType<ReturnType<typeof createBroker>["resolve"]>
		>["receipt"];
		const submit = vi.fn(async () => ({
			engine: "in-proc",
			reconcilerMode: "conductor" as const,
			target: "local",
			document: {},
		}));
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => {
					if (reenter && receipt)
						retried = broker.deliver(receipt).catch((error) => error);
					return { liabilityBoundUsd: "5" };
				},
			},
			deliveryPlane: { submit },
		});
		receipt = (await broker.resolve(request)).receipt;
		if (!receipt) throw new Error("expected a receipt");
		reenter = true;
		await broker.deliver(receipt);
		expect(await retried).toMatchObject({ code: "delivery-already-claimed" });
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("rechecks the context after the delivery attestor runs", async () => {
		const environment = {
			environmentId: "env",
			approved: true,
			approvedProviders: ["provider"],
		};
		let revoke = false;
		const submit = vi.fn(async () => ({
			engine: "in-proc",
			reconcilerMode: "conductor" as const,
			target: "local",
			document: {},
		}));
		const broker = createBroker({
			...common,
			environment,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => {
					if (revoke) environment.approved = false;
					return { liabilityBoundUsd: "5" };
				},
			},
			deliveryPlane: { submit },
		});
		const receipt = (await broker.resolve(request)).receipt;
		if (!receipt) throw new Error("expected a receipt");
		revoke = true;
		await expect(broker.deliver(receipt)).rejects.toThrow(
			/delivery-context-stale/u,
		);
		expect(submit).not.toHaveBeenCalled();
	});

	it("requires reconciliation after an ambiguous delivery transport error", async () => {
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			deliveryPlane: createReconcilerDeliveryPlane({
				requestPromotion: async () => {
					throw new Error("lost reply");
				},
			}),
		});
		const receipt = (await broker.resolve(request)).receipt;
		if (!receipt) throw new Error("expected a receipt");
		await expect(broker.deliver(receipt)).rejects.toMatchObject({
			code: "delivery-transport-failed",
			remediation: expect.stringMatching(/reconcil/iu),
		});
	});

	it("does not issue a second receipt for a request after completion", async () => {
		const broker = createBroker({
			...common,
			pricingAuthority: {
				quote: () => quote("1"),
				attest: () => ({ liabilityBoundUsd: "5" }),
			},
			billingPlane: {
				authorize: () => ({ ok: true, reasons: [], reservationCreated: true }),
			},
		});
		expect((await broker.resolve(request)).outcome).toBe("resolved");
		const replay = await broker.resolve(request);
		expect(replay.outcome).toBe("rejected");
		expect(replay.rejection?.reasons[0]?.code).toBe(
			"reservation-replay-requires-reconciliation",
		);
	});
});
