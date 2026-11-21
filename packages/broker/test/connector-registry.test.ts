import { describe, expect, it } from "vitest";

import { createBroker } from "../src/broker.js";
import {
	createConnectorRegistry,
	foldConnectorRegistry,
	parseConnectorConfig,
} from "../src/connector-registry.js";
import { BROKER_EVENTS } from "../src/events.js";
import { BrokerParseError } from "../src/policies.js";
import type { BrokerCatalog } from "../src/types.js";

describe("parseConnectorConfig", () => {
	it("parses each well-known connector kind with its required settings", async () => {
		const githubApp = parseConnectorConfig({
			id: "conn-github",
			kind: "github-app",
			displayName: "HoBo GitHub App",
			settings: { appId: "12345", installationId: "678" },
			credentialRef: "token-broker://github-app/hobo",
		});
		expect(githubApp.kind).toBe("github-app");
		expect(githubApp.enabled).toBe(true);

		expect(
			parseConnectorConfig({
				id: "conn-pulumi",
				kind: "pulumi",
				displayName: "Pulumi",
				settings: { organization: "acme" },
			}).kind,
		).toBe("pulumi");
		expect(
			parseConnectorConfig({
				id: "conn-azure",
				kind: "azure",
				displayName: "Azure",
				settings: { subscriptionId: "sub-1", tenantId: "ten-1" },
			}).kind,
		).toBe("azure");
		expect(
			parseConnectorConfig({
				id: "conn-vercel",
				kind: "vercel",
				displayName: "Vercel",
				settings: { teamId: "team-1" },
			}).kind,
		).toBe("vercel");
		expect(
			parseConnectorConfig({
				id: "conn-cf",
				kind: "cloudflare",
				displayName: "Cloudflare",
				settings: { accountId: "acct-1" },
			}).kind,
		).toBe("cloudflare");
	});

	it("refuses unknown kinds and missing required settings", async () => {
		expect(() =>
			parseConnectorConfig({
				id: "conn-x",
				kind: "smoke-signals",
				displayName: "Nope",
			}),
		).toThrow(BrokerParseError);
		expect(() =>
			parseConnectorConfig({
				id: "conn-github",
				kind: "github-app",
				displayName: "HoBo GitHub App",
				settings: { appId: "12345" },
			}),
		).toThrow(/connector-settings-missing/);
	});
});

describe("createConnectorRegistry", () => {
	it("registers, disables, and reports missing kinds", async () => {
		const registry = createConnectorRegistry();
		const { event } = registry.register({
			id: "conn-github",
			kind: "github-app",
			displayName: "HoBo GitHub App",
			settings: { appId: "12345", installationId: "678" },
		});
		expect(event.type).toBe(BROKER_EVENTS.ConnectorRegistered);
		expect(registry.byKind("github-app")).toHaveLength(1);
		expect(registry.missingKinds(["github-app", "vercel"])).toEqual(["vercel"]);

		const disabled = registry.disable("conn-github");
		expect(disabled.type).toBe(BROKER_EVENTS.ConnectorDisabled);
		expect(registry.byKind("github-app")).toHaveLength(0);
		expect(registry.missingKinds(["github-app"])).toEqual(["github-app"]);
	});

	it("folds registration facts back into the read model from zero", async () => {
		const registry = createConnectorRegistry();
		const first = registry.register({
			id: "conn-github",
			kind: "github-app",
			displayName: "HoBo GitHub App",
			settings: { appId: "12345", installationId: "678" },
		});
		const second = registry.register({
			id: "conn-cf",
			kind: "cloudflare",
			displayName: "Cloudflare",
			settings: { accountId: "acct-1" },
		});
		const disabled = registry.disable("conn-cf");

		const rows = foldConnectorRegistry([first.event, second.event, disabled]);
		const byId = new Map(rows.map((row) => [row.connectorId, row]));
		expect(byId.get("conn-github")?.enabled).toBe(true);
		expect(byId.get("conn-cf")?.enabled).toBe(false);
	});

	it("satisfies the broker's required-connector gate once registered", async () => {
		const catalog: BrokerCatalog = {
			catalogHash: "sha256:catalog-min",
			definitions: () => [
				{
					id: "@hobo/provider-cloudflare:hobo:http-service",
					providerId: "@hobo/provider-cloudflare",
					port: "hobo:http-service",
					features: [],
					regions: ["us-east-1"],
					cost: { sku: "cf-svc", unit: "hour", marginalPrice: "0.02" },
					satisfies: (req) =>
						req.port === "hobo:http-service"
							? { kind: "full" }
							: { kind: "none" },
				},
			],
		};
		const connectors = createConnectorRegistry([
			{
				id: "conn-cf",
				kind: "cloudflare",
				displayName: "Cloudflare",
				settings: { accountId: "acct-1" },
			},
		]);
		const broker = createBroker({
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			policies: {
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
				requiredConnectorKinds: ["cloudflare"],
			},
			catalog,
			connectors,
		});
		const result = await broker.resolve({
			schemaVersion: "hobo.broker/v1",
			requestId: "req-conn",
			scope: { bindleId: "bindle:site" },
			requirements: [{ resourceId: "api", port: "hobo:http-service" }],
			spendEstimateUsd: 1,
		});
		expect(result.outcome).toBe("resolved");
	});
});
