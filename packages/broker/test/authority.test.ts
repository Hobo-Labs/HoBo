import { describe, expect, it } from "vitest";
import { createBroker } from "../src/broker.js";
import {
	approveEnvironmentFact,
	foldBrokerEnvironments,
	parseBrokerEnvironment,
	publishEnvironmentFact,
} from "../src/environments.js";
import { createBrokerHttpHandler, serveBroker } from "../src/http.js";
import { isJsonString } from "../src/json.js";
import type { BrokerCatalog } from "../src/types.js";

const catalog: BrokerCatalog = {
	catalogHash: "sha256:catalog-live",
	definitions: () => [
		{
			id: "@hobo/provider-cheap:hobo:http-service",
			providerId: "@hobo/provider-cheap",
			port: "hobo:http-service",
			features: [],
			regions: ["us-east-1"],
			cost: { sku: "cheap-svc", unit: "hour", marginalPrice: "0.01" },
			satisfies: (req) =>
				req.port === "hobo:http-service" ? { kind: "full" } : { kind: "none" },
		},
		{
			id: "@hobo/provider-pricey:hobo:http-service",
			providerId: "@hobo/provider-pricey",
			port: "hobo:http-service",
			features: [],
			regions: ["us-east-1"],
			cost: { sku: "pricey-svc", unit: "hour", marginalPrice: "0.30" },
			satisfies: (req) =>
				req.port === "hobo:http-service" ? { kind: "full" } : { kind: "none" },
		},
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
		quotaUsed: 0,
		quotaLimit: 10,
		budgetUsd: 100,
		spendCapUsd: 50,
	},
	delivery: { engine: "in-proc", syncMode: "manual" },
};

const baseRequest = {
	schemaVersion: "hobo.broker/v1",
	requestId: "req-1",
	scope: { bindleId: "bindle:site" },
	requirements: [{ resourceId: "api", port: "hobo:http-service" }],
	spendEstimateUsd: 10,
};

describe("broker environments — admin controls", () => {
	it("publishes, approves, and folds the environment read model", () => {
		const published = publishEnvironmentFact({
			environmentId: "env-prod",
			approvedProviders: ["@hobo/provider-pricey"],
			catalogHash: "sha256:catalog-live",
		});
		expect(published.environment.approved).toBe(false);
		const rows = foldBrokerEnvironments([
			published.event,
			approveEnvironmentFact("env-prod", "user:platform-admin"),
		]);
		expect(rows[0]?.approved).toBe(true);
		expect(rows[0]?.approvedBy).toBe("user:platform-admin");
	});

	it("rejects resolutions against an unapproved environment", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			environment: parseBrokerEnvironment({
				environmentId: "env-prod",
				approvedProviders: [],
				approved: false,
			}),
		});
		const result = await broker.resolve(baseRequest);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe("environment-unapproved");
	});

	it("rejects when the pinned catalog snapshot is stale", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			environment: parseBrokerEnvironment({
				environmentId: "env-prod",
				approved: true,
				catalogHash: "sha256:catalog-older",
			}),
		});
		const result = await broker.resolve(baseRequest);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe("catalog-snapshot-stale");
	});

	it("bounds placement eligibility to the environment's approved providers", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			environment: parseBrokerEnvironment({
				environmentId: "env-prod",
				approved: true,
				catalogHash: "sha256:catalog-live",
				approvedProviders: ["@hobo/provider-pricey"],
			}),
		});
		const result = await broker.resolve(baseRequest);
		expect(result.outcome).toBe("resolved");
		// The cheaper provider exists in the catalog but is outside the
		// approved environment, so the approved (pricier) provider wins.
		expect(result.receipt?.placements[0]?.providerId).toBe(
			"@hobo/provider-pricey",
		);
	});
});

describe("hosted authority surface (HTTP)", () => {
	it("serves resolve/scale/rejection-matrix over a real node:http server", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const server = serveBroker(broker, { port: 0 });
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (address === null || isJsonString(address)) {
			throw new Error("expected a bound port");
		}
		const base = `http://127.0.0.1:${address.port}`;

		try {
			const resolved = await fetch(`${base}/broker/resolve`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(baseRequest),
			});
			expect(resolved.status).toBe(200);
			// SAFETY: assertion required at this I/O or test boundary.
			const body = (await resolved.json()) as {
				outcome: string;
				receipt: { placements: Array<{ providerId: string }> };
			};
			expect(body.outcome).toBe("resolved");
			expect(body.receipt.placements[0]?.providerId).toBe(
				"@hobo/provider-cheap",
			);

			const scaled = await fetch(`${base}/broker/scale`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ resourceId: "api", direction: "zero" }),
			});
			expect(scaled.status).toBe(200);

			const matrix = await fetch(`${base}/broker/rejection-matrix`);
			expect(matrix.status).toBe(200);

			const bad = await fetch(`${base}/broker/scale`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ resourceId: "api", direction: "sideways" }),
			});
			expect(bad.status).toBe(400);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("maps billing rejections to 402 through the pure handler", async () => {
		const broker = createBroker({
			policies: basePolicies,
			catalog,
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		const handle = createBrokerHttpHandler(broker);
		const response = await handle({
			method: "POST",
			path: "/broker/resolve",
			body: { ...baseRequest, spendEstimateUsd: 500 },
		});
		expect(response.status).toBe(402);
		const unknown = await handle({ method: "GET", path: "/nope" });
		expect(unknown.status).toBe(404);
	});
});
