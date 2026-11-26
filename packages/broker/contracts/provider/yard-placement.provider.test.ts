/**
 * Provider verification for Broker Yard-first placement surface.
 * Offline: real resolveBindleDeployment + fold path, no live cloud keys.
 * (Mirrors broker-resolution.provider.test.ts style — no contract-harness dep.)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildDeploymentRequestFromParts,
	contentHashOf,
	createLocalHostCatalog,
	createYardRuntimeCatalog,
	DEFAULT_YARD_GENERATION_POLICY,
	foldYardEventStoreAll,
	inventorySnapshotFromFold,
	LOCAL_HOST_PROVIDER_ID,
	localYardInstance,
	planYardGeneration,
	resolveBindleDeployment,
	YARD_EVENTS,
	yardEvent,
} from "../../src/index.js";
import type { JsonObject } from "../../src/json.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
// SAFETY: assertion required at this I/O or test boundary.
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/broker_yard_placement.pact.json"),
		"utf8",
	),
) as {
	provider: { name: string };
	interactions: Array<{
		description: string;
		request: { path: string; body?: JsonObject };
		response: { status: number; body?: JsonObject };
	}>;
};

describe("BrokerYardPlacement provider verification", () => {
	it("pact document names BrokerYardPlacement", () => {
		expect(pact.provider.name).toBe("BrokerYardPlacement");
		expect(pact.interactions.length).toBeGreaterThan(0);
	});

	it("resolve interaction: existing ready yard", async () => {
		const catalog = createLocalHostCatalog();
		const yard = localYardInstance({
			yardId: "yard:local-main",
			ownerTenantId: "local",
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		const deployment = buildDeploymentRequestFromParts({
			bindleName: "shop",
			providerId: LOCAL_HOST_PROVIDER_ID,
			yardId: "yard:local-main",
			selectionMode: "compatible",
			resources: [
				{ resourceId: "api", port: "hobo:http-service", features: [] },
			],
		});
		const result = await resolveBindleDeployment(deployment, {
			brokerId: "broker:pact",
			catalog,
			seedLocalYard: false,
			priorEvents: [
				yardEvent(YARD_EVENTS.Registered, { yard }),
				yardEvent(YARD_EVENTS.Ready, { yardId: "yard:local-main" }),
			],
		});
		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.schemaVersion).toBe(
			"hobo.yard-placement-receipt/v1",
		);
		expect(
			result.events.some((e) => e.type === YARD_EVENTS.PlacementResolved),
		).toBe(true);
	});

	it("rejects bindle provider selection on deployment request", async () => {
		const { parseBindleDeploymentRequest } = await import("../../src/index.js");
		expect(() =>
			parseBindleDeploymentRequest({
				schemaVersion: "hobo.bindle-deployment-request/v1",
				requestId: "r1",
				bindleName: "shop",
				manifestHash: "sha256:abc",
				provider: "azure",
				bindleRequirements: {
					require: [],
					prefer: [],
					runtimes: [],
					labels: {},
				},
				yard: {
					requestId: "y1",
					selectionMode: "compatible",
					requestedLayout: {},
					bindleManifestHash: "sha256:abc",
					bindleRequirementsHash: "sha256:def",
					allowGenerationRequested: false,
				},
				objective: "min-cost",
				spendEstimateUsd: 0,
				ownerTenantId: "local",
				resources: [],
			}),
		).toThrow(/bindle-provider-selection-forbidden/);
	});

	it("generation denied by default policy", () => {
		const runtimes = createYardRuntimeCatalog();
		runtimes.register({
			schemaVersion: "hobo.yard-runtime/v1",
			runtimeId: "azure-yard/v1",
			providerId: "azure",
			version: "1",
			supportedLayout: {
				regions: [],
				capabilities: [],
				requireProperties: [],
			},
			resolverCatalogHash: contentHashOf("r"),
			generatorConnectorId: "conn",
			default: true,
			priority: 1,
			requiredPermissions: [],
			conformanceRef: "c",
			conformanceHash: contentHashOf("c"),
			status: "approved",
		});
		const decision = planYardGeneration({
			ownerTenantId: "t",
			requestedLayout: {
				providerId: "azure",
				regions: [],
				require: [],
				prefer: [],
				residency: [],
				isolation: [],
				network: [],
				componentHosts: [],
				labels: {},
				properties: {},
				camps: [],
			},
			runtimeCatalog: runtimes.snapshot(),
			policy: DEFAULT_YARD_GENERATION_POLICY,
			allowGenerationRequested: true,
			attemptId: "pact-gen",
		});
		expect(decision.allowed).toBe(false);
	});

	it("fold inventory snapshot from yard events", () => {
		const yard = localYardInstance({
			yardId: "yard:fold",
			ownerTenantId: "local",
			providerId: "local",
		});
		const state = foldYardEventStoreAll("broker:pact", [
			yardEvent(YARD_EVENTS.Registered, { yard }),
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:fold" }),
		]);
		const snap = inventorySnapshotFromFold(state);
		expect(snap.schemaVersion).toBe("hobo.yard-inventory/v1");
		expect(snap.yards).toHaveLength(1);
		expect(snap.yards[0]?.status).toBe("ready");
	});
});
