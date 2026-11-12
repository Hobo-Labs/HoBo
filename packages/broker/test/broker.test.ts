import { definePolicyRule } from "@hobo/contracts";
import { describe, expect, it } from "vitest";
import {
	createBroker,
	foldBrokerDecisions,
	restoreBrokerDecisions,
	snapshotBrokerDecisions,
} from "../src/broker.js";
import { DELIVERY_SUBMITTED_SCHEMA } from "../src/delivery.js";
import { BROKER_EVENTS } from "../src/events.js";
import type { JsonObject } from "../src/json.js";
import {
	createGatekeeperGatePlane,
	createReconcilerDeliveryPlane,
	type DeliveryPromotionRequest,
} from "../src/planes.js";
import {
	BrokerParseError,
	effectivePlacementPolicy,
	parseBrokerPolicySet,
} from "../src/policies.js";
import type { BrokerCatalog, BrokerCatalogDefinition } from "../src/types.js";

function definition(
	providerId: string,
	port: string,
	marginalPrice: string,
	regions: string[] = ["us-east-1", "eu-west-1"],
): BrokerCatalogDefinition {
	return {
		id: `${providerId}:${port}`,
		providerId,
		port,
		features: ["autoscaling"],
		regions,
		cost: { sku: `${providerId}-${port}`, unit: "hour", marginalPrice },
		satisfies: (req) => {
			if (req.port !== port) return { kind: "none" };
			const missing = (req.features ?? []).filter(
				(feature) => feature !== "autoscaling",
			);
			return missing.length === 0
				? { kind: "full" }
				: { kind: "partial", missing };
		},
	};
}

const catalog: BrokerCatalog = {
	catalogHash: "sha256:catalog-abc",
	definitions: () => [
		definition("@hobo/provider-aws", "hobo:http-service", "0.12"),
		definition("@hobo/provider-cloudflare", "hobo:http-service", "0.02"),
		definition("@hobo/provider-azure", "hobo:http-service", "0.10"),
		definition("@hobo/provider-aws", "hobo:object-store", "0.03"),
		definition("@hobo/provider-azure", "hobo:object-store", "0.01", [
			"eu-west-1",
		]),
	],
};

const basePolicies = {
	schemaVersion: "hobo.broker/v1",
	brokerId: "broker:yard-1",
	placementPolicies: [
		{ id: "pp-bindle", scopeKind: "bindle", objective: "min-cost" },
	],
	billing: {
		quota: "deployments/day",
		quotaUsed: 2,
		quotaLimit: 20,
		budgetUsd: 500,
		spendCapUsd: 100,
	},
	delivery: {
		engine: "argo",
		syncMode: "auto",
		prune: true,
		gitopsRepo: "https://git.example/hobo-receipts",
		destinationNamespace: "hobo-prod",
	},
};

const baseRequest = {
	schemaVersion: "hobo.broker/v1",
	requestId: "req-1",
	scope: { bindleId: "bindle:checkout" },
	requirements: [
		{ resourceId: "api", port: "hobo:http-service", features: ["autoscaling"] },
		{ resourceId: "media", port: "hobo:object-store" },
	],
	spendEstimateUsd: 12,
};

describe("createBroker.resolve — brokering across providers", () => {
	it("places each resource on the cheapest provider that satisfies it", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const result = await broker.resolve(baseRequest);

		expect(result.outcome).toBe("resolved");
		const byResource = new Map(
			(result.receipt?.placements ?? []).map((p) => [p.resourceId, p]),
		);
		// Different resources land on DIFFERENT providers — brokered per resource.
		expect(byResource.get("api")?.providerId).toBe("@hobo/provider-cloudflare");
		expect(byResource.get("media")?.providerId).toBe("@hobo/provider-azure");
		expect(result.receipt?.catalogHash).toBe("sha256:catalog-abc");
		expect(result.receipt?.policyHash).toMatch(/^sha256:/);
		expect(result.receipt?.placementPolicyId).toBe("pp-bindle");
	});

	it("honours denied providers accumulated from broader scope policies", async () => {
		const broker = createBroker({
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			policies: {
				...basePolicies,
				placementPolicies: [
					{ id: "pp-bindle", scopeKind: "bindle", objective: "min-cost" },
					{
						id: "pp-yard",
						scopeKind: "yard",
						objective: "min-cost",
						deniedProviders: ["@hobo/provider-cloudflare"],
					},
				],
			},
			catalog,
		});
		const result = await broker.resolve({
			...baseRequest,
			scope: { bindleId: "bindle:checkout", yardId: "yard:eu" },
		});

		expect(result.outcome).toBe("resolved");
		const api = result.receipt?.placements.find((p) => p.resourceId === "api");
		// Cloudflare is cheapest but denied by the yard policy → azure wins.
		expect(api?.providerId).toBe("@hobo/provider-azure");
	});

	it("pins placement to the pinned provider when the objective is pinned", async () => {
		const broker = createBroker({
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			policies: {
				...basePolicies,
				placementPolicies: [
					{
						id: "pp-pinned",
						scopeKind: "bindle",
						objective: "pinned",
						pinnedProviderId: "@hobo/provider-aws",
					},
				],
			},
			catalog,
		});
		const result = await broker.resolve(baseRequest);

		expect(result.outcome).toBe("resolved");
		for (const placement of result.receipt?.placements ?? []) {
			expect(placement.providerId).toBe("@hobo/provider-aws");
		}
	});

	it("rejects with explicit-camp-required when a junction policy locks placement down", async () => {
		const broker = createBroker({
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			policies: {
				...basePolicies,
				placementPolicies: [
					{ id: "pp-bindle", scopeKind: "bindle", objective: "min-cost" },
					{
						id: "pp-junction",
						scopeKind: "junction",
						objective: "min-cost",
						requireExplicitCamps: true,
					},
				],
			},
			catalog,
		});
		const rejected = await broker.resolve({
			...baseRequest,
			scope: { bindleId: "bindle:checkout", junctionId: "junction:global" },
		});
		expect(rejected.outcome).toBe("rejected");
		expect(rejected.rejection?.reasons[0]?.code).toBe("explicit-camp-required");

		// Naming an explicit camp satisfies the lockdown.
		const allowed = await broker.resolve({
			...baseRequest,
			scope: {
				bindleId: "bindle:checkout",
				campId: "camp:prod-eu",
				junctionId: "junction:global",
			},
		});
		expect(allowed.outcome).toBe("resolved");
	});

	it("rejects through the billing plane when the estimate exceeds the spend cap", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const result = await broker.resolve({
			...baseRequest,
			spendEstimateUsd: 250,
		});

		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.plane).toBe("billing");
		expect(result.rejection?.reasons[0]?.code).toBe("spend-cap-exceeded");
	});

	it("rejects through the gate plane when a policy rule denies the resolve action", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			gatePlane: createGatekeeperGatePlane({
				policyPack: {
					id: "hobo.test/deny-prod",
					version: "1.0.0",
					rules: [
						definePolicyRule({
							id: "deny-checkout",
							when: (request) => request.context?.target === "bindle:checkout",
							decide: () => ({
								effect: "deny",
								reason: "checkout deploys are frozen",
							}),
						}),
					],
				},
			}),
		});
		const result = await broker.resolve(baseRequest);

		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.plane).toBe("policy");
		// The gatekeeper's policy.Decided fact is part of the emitted events.
		expect(result.events.some((event) => event.type === "policy.Decided")).toBe(
			true,
		);
	});

	it("rejects with no-eligible-provider when no provider satisfies a port", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const result = await broker.resolve({
			...baseRequest,
			requirements: [{ resourceId: "queue", port: "hobo:message-queue" }],
		});

		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.plane).toBe("placement");
		expect(result.rejection?.reasons[0]?.code).toBe("no-eligible-provider");
	});

	it("respects allowed regions and per-requirement region pins", async () => {
		const broker = createBroker({
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			policies: {
				...basePolicies,
				placementPolicies: [
					{
						id: "pp-eu-only",
						scopeKind: "bindle",
						objective: "min-cost",
						allowedRegions: ["eu-west-1"],
					},
				],
			},
			catalog,
		});
		const result = await broker.resolve(baseRequest);
		expect(result.outcome).toBe("resolved");
		for (const placement of result.receipt?.placements ?? []) {
			expect(placement.region).toBe("eu-west-1");
		}

		const pinned = await broker.resolve({
			...baseRequest,
			requirements: [
				{ resourceId: "api", port: "hobo:http-service", region: "us-east-1" },
			],
		});
		// us-east-1 is outside the allowed regions → no eligible provider.
		expect(pinned.outcome).toBe("rejected");
	});
});

describe("createBroker.scale — spin resources up and down", () => {
	it("emits broker.ScaleRequested for a valid directive", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const { directive, events } = broker.scale({
			resourceId: "api",
			direction: "zero",
		});
		expect(directive.replicas).toBe(0);
		expect(events[0]?.type).toBe(BROKER_EVENTS.ScaleRequested);
	});

	it("refuses a zero directive with non-zero replicas", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		expect(() =>
			broker.scale({ resourceId: "api", direction: "zero", replicas: 3 }),
		).toThrow(BrokerParseError);
	});
});

describe("createBroker.deliver — delivers through CD (D14)", () => {
	it("legacy Argo policy still delivers via the publisher", async () => {
		const requests: DeliveryPromotionRequest[] = [];
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			deliveryPlane: createReconcilerDeliveryPlane({
				requestPromotion: async (request) => {
					requests.push(request);
					return { ok: true, promotionId: "promo-1", target: "camp:prod" };
				},
			}),
		});
		const resolved = await broker.resolve(baseRequest);
		const receipt = resolved.receipt;
		if (receipt === undefined) throw new Error("expected a receipt");

		const { ticket, events } = await broker.deliver(receipt);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.delivery).toMatchObject({
			reconcilerMode: "publisher",
			publisher: {
				target: "argo-cd",
				repository: "https://git.example/hobo-receipts",
			},
		});
		expect(requests[0]?.receipt.requestId).toBe(receipt.requestId);
		expect(ticket.reconcilerMode).toBe("publisher");
		expect(ticket.publisher).toBe("argo-cd");
		expect(ticket.promotionId).toBe("promo-1");
		expect(ticket.target).toBe("camp:prod");
		expect(events[0]?.type).toBe(BROKER_EVENTS.DeliverySubmitted);
		expect(events[0]?.data).toMatchObject({
			schema: DELIVERY_SUBMITTED_SCHEMA,
			reconcilerMode: "publisher",
			publisher: "argo-cd",
			promotionId: "promo-1",
		});
		// No Kubernetes vocabulary leaves the neutral broker.
		expect(JSON.stringify(ticket)).not.toMatch(/namespace|argoproj/u);
	});

	it("the default plane only runs the in-process conductor and refuses publisher mode", async () => {
		const legacy = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const resolved = await legacy.resolve(baseRequest);
		const receipt = resolved.receipt;
		if (receipt === undefined) throw new Error("expected a receipt");
		await expect(legacy.deliver(receipt)).rejects.toMatchObject({
			code: "delivery-plane-unwired",
		});

		const local = createBroker({
			policies: { ...basePolicies, delivery: { reconcilerMode: "conductor" } },
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const localReceipt = (await local.resolve(baseRequest)).receipt;
		if (localReceipt === undefined) throw new Error("expected a receipt");
		const { ticket } = await local.deliver(localReceipt);
		expect(ticket.reconcilerMode).toBe("conductor");
		expect(ticket.engine).toBe("in-proc");
	});
});

describe("effectivePlacementPolicy — scope merge semantics", () => {
	it("lets narrower scopes override choice fields while restrictions accumulate", async () => {
		const policies = parseBrokerPolicySet({
			...basePolicies,
			placementPolicies: [
				{
					id: "pp-junction",
					scopeKind: "junction",
					objective: "min-cost",
					deniedProviders: ["@hobo/provider-aws"],
					requireExplicitCamps: true,
				},
				{
					id: "pp-bindle",
					scopeKind: "bindle",
					objective: "pinned",
					pinnedProviderId: "@hobo/provider-azure",
				},
			],
		});
		const effective = effectivePlacementPolicy(policies, {
			bindleId: "bindle:checkout",
			junctionId: "junction:global",
		});
		expect(effective?.objective).toBe("pinned");
		expect(effective?.pinnedProviderId).toBe("@hobo/provider-azure");
		expect(effective?.deniedProviders).toContain("@hobo/provider-aws");
		expect(effective?.requireExplicitCamps).toBe(true);
	});
});

describe("broker decision read model", () => {
	it("folds decision facts into a materialized view and round-trips snapshots", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const resolved = await broker.resolve(baseRequest);
		const rejected = await broker.resolve({
			...baseRequest,
			requestId: "req-2",
			spendEstimateUsd: 9999,
		});

		const rows = foldBrokerDecisions([...resolved.events, ...rejected.events]);
		const byRequest = new Map(rows.map((row) => [row.requestId, row]));
		expect(byRequest.get("req-1")?.outcome).toBe("resolved");
		expect(byRequest.get("req-1")?.placementCount).toBe(2);
		expect(byRequest.get("req-2")?.outcome).toBe("rejected");
		expect(byRequest.get("req-2")?.reasonCodes).toContain("spend-cap-exceeded");

		const restored = restoreBrokerDecisions(snapshotBrokerDecisions(rows));
		expect(restored).toEqual(rows);
	});
});

describe("connector requirements gate", () => {
	it("rejects when a required connector kind is not registered", async () => {
		const broker = createBroker({
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			policies: {
				...basePolicies,
				requiredConnectorKinds: ["github-app"],
			},
			catalog,
		});
		const result = await broker.resolve(baseRequest);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.plane).toBe("connectors");
		expect(result.rejection?.reasons[0]?.code).toBe("connector-missing");
	});
});

describe("residency plane mapping (ADR-0146)", () => {
	it("maps gate:'residency' reasons to the residency plane, not policy", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			gatePlane: createGatekeeperGatePlane({
				residency: {
					ok: false,
					reasons: [
						{
							code: "jurisdiction-not-allowed",
							message:
								'region "us-east-1" (us) is outside allowed jurisdictions [eu]',
							region: "us-east-1",
							jurisdictions: ["us"],
						},
					],
				},
			}),
		});
		const result = await broker.resolve(baseRequest);

		expect(result.outcome).toBe("rejected");
		const reason = result.rejection?.reasons.find(
			(entry) => entry.code === "jurisdiction-not-allowed",
		);
		expect(reason?.plane).toBe("residency");
	});
});
