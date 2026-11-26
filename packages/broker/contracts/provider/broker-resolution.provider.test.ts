import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBroker } from "../../src/broker.js";
import { createBrokerHttpHandler } from "../../src/http.js";
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

// PROVIDER verification: the hosted HTTP surface (http.ts) replays every
// interaction in broker_resolution.pact.json and must reproduce the recorded
// status and body layout. The consumer suite exercises the same pact from the
// caller's side, so the boundary is pinned from both directions.

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

const broker = createBroker({
	stationId: "station:test",
	railHash:
		"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	policies: {
		schemaVersion: "hobo.broker/v1",
		brokerId: "broker:test-yard",
		placementPolicies: [
			{ id: "pp-default", scopeKind: "bindle", objective: "min-cost" },
			{
				id: "pp-junction-lockdown",
				scopeKind: "junction",
				objective: "min-cost",
				requireExplicitCamps: true,
			},
		],
		billing: {
			quota: "deployments/day",
			quotaUsed: 0,
			quotaLimit: 10,
			budgetUsd: 1000,
			spendCapUsd: 50,
		},
		delivery: { engine: "in-proc", syncMode: "manual" },
	},
	catalog,
});

const handle = createBrokerHttpHandler(broker);

describe("HoBo Broker resolve surface — provider verification of the pact", () => {
	for (const interaction of pact.interactions) {
		it(interaction.description, async () => {
			const response = await handle({
				method: interaction.request.method,
				path: interaction.request.path,
				body: interaction.request.body,
			});
			expect(response.status).toBe(interaction.response.status);
			expect(response.body.outcome).toBe(interaction.response.body.outcome);

			const expectedReceipt = interaction.response.body.receipt;
			if (expectedReceipt !== undefined) {
				// SAFETY: assertion required at this I/O or test boundary.
				const receipt = response.body.receipt as JsonObject;
				expect(receipt.requestId).toBe(expectedReceipt.requestId);
				// SAFETY: assertion required at this I/O or test boundary.
				const placements = receipt.placements as Array<JsonObject>;
				expect(placements[0]?.providerId).toBe(
					expectedReceipt.placements[0].providerId,
				);
			}
			const expectedRejection = interaction.response.body.rejection;
			if (expectedRejection !== undefined) {
				// SAFETY: assertion required at this I/O or test boundary.
				const rejection = response.body.rejection as {
					reasons: Array<JsonObject>;
				};
				expect(rejection.reasons[0]?.plane).toBe(
					expectedRejection.reasons[0].plane,
				);
				expect(rejection.reasons[0]?.code).toBe(
					expectedRejection.reasons[0].code,
				);
			}
			const expectedTypes =
				// SAFETY: assertion required at this I/O or test boundary.
				(interaction.response.body.events as Array<{ type: string }>).map(
					(event) => event.type,
				);
			// SAFETY: assertion required at this I/O or test boundary.
			const actualTypes = (response.body.events as Array<{ type: string }>).map(
				(event) => event.type,
			);
			for (const type of expectedTypes) {
				expect(actualTypes).toContain(type);
			}
		});
	}
});
