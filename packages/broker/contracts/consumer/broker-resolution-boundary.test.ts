import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBroker } from "../../src/broker.js";
import type { JsonObject } from "../../src/json.js";
import type {
	BrokerCatalog,
	BrokerCatalogDefinition,
} from "../../src/types.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/broker_resolution.pact.json"),
		"utf8",
	),
);

function definition(
	providerId: string,
	marginalPrice: string,
): BrokerCatalogDefinition {
	return {
		id: `${providerId}:hobo:http-service`,
		providerId,
		port: "hobo:http-service",
		features: [],
		regions: ["us-east-1"],
		cost: { sku: `${providerId}-svc`, unit: "hour", marginalPrice },
		satisfies: (req) =>
			req.port === "hobo:http-service" ? { kind: "full" } : { kind: "none" },
	};
}

const catalog: BrokerCatalog = {
	catalogHash: "sha256:test-catalog",
	definitions: () => [
		definition("@hobo/provider-pricey", "0.25"),
		definition("@hobo/provider-cheap", "0.01"),
	],
};

function brokerWith(policies: JsonObject) {
	return createBroker({
		stationId: "station:test",
		railHash:
			"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		policies: {
			schemaVersion: "hobo.broker/v1",
			brokerId: "broker:test-yard",
			billing: {
				quota: "deployments/day",
				quotaUsed: 0,
				quotaLimit: 10,
				budgetUsd: 1000,
				spendCapUsd: 50,
			},
			delivery: { engine: "in-proc", syncMode: "manual" },
			...policies,
		},
		catalog,
	});
}

describe("HoBo Broker resolution boundary (consumer side of the pact)", () => {
	it("resolves a policy-clean request to the cheapest eligible provider", async () => {
		const interaction = pact.interactions[0];
		const broker = brokerWith({
			placementPolicies: [
				{ id: "pp-default", scopeKind: "bindle", objective: "min-cost" },
			],
		});
		const result = await broker.resolve(interaction.request.body);

		expect(result.outcome).toBe(interaction.response.body.outcome);
		expect(result.receipt?.requestId).toBe(
			interaction.response.body.receipt.requestId,
		);
		expect(result.receipt?.placements[0]?.providerId).toBe(
			interaction.response.body.receipt.placements[0].providerId,
		);
		const expectedTypes = interaction.response.body.events.map(
			(event: { type: string }) => event.type,
		);
		const actualTypes = result.events.map((event) => event.type);
		for (const type of expectedTypes) {
			expect(actualTypes).toContain(type);
		}
	});

	it("rejects a locked-down junction request that names no explicit camp", async () => {
		const interaction = pact.interactions[1];
		const broker = brokerWith({
			placementPolicies: [
				{ id: "pp-default", scopeKind: "bindle", objective: "min-cost" },
				{
					id: "pp-junction-lockdown",
					scopeKind: "junction",
					objective: "min-cost",
					requireExplicitCamps: true,
				},
			],
		});
		const result = await broker.resolve(interaction.request.body);

		expect(result.outcome).toBe(interaction.response.body.outcome);
		expect(result.rejection?.reasons[0]?.plane).toBe(
			interaction.response.body.rejection.reasons[0].plane,
		);
		expect(result.rejection?.reasons[0]?.code).toBe(
			interaction.response.body.rejection.reasons[0].code,
		);
	});

	it("rejects a spend estimate above the billing plane's cap", async () => {
		const interaction = pact.interactions[2];
		const broker = brokerWith({
			placementPolicies: [
				{ id: "pp-default", scopeKind: "bindle", objective: "min-cost" },
			],
		});
		const result = await broker.resolve(interaction.request.body);

		expect(result.outcome).toBe(interaction.response.body.outcome);
		expect(result.rejection?.reasons[0]?.plane).toBe(
			interaction.response.body.rejection.reasons[0].plane,
		);
		expect(result.rejection?.reasons[0]?.code).toBe(
			interaction.response.body.rejection.reasons[0].code,
		);
	});
});
