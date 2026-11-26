import { describe, expect, it } from "vitest";

import { createBroker } from "../src/broker.js";
import {
	createLocalHostCatalog,
	defaultLocalPolicySet,
	LOCAL_HOST_PROVIDER_ID,
	LOCAL_HOST_REGION,
} from "../src/local-host.js";

describe("local-host catalog — the running machine as a provider host", () => {
	it("advertises the core runtime ports at zero cost with a stable hash", () => {
		const catalog = createLocalHostCatalog("test-machine");
		const definitions = catalog.definitions();
		expect(
			definitions.every(
				(definition) => definition.providerId === LOCAL_HOST_PROVIDER_ID,
			),
		).toBe(true);
		expect(
			definitions.every((definition) =>
				definition.regions.includes(LOCAL_HOST_REGION),
			),
		).toBe(true);
		expect(
			definitions.every(
				(definition) => definition.cost.marginalPrice === "0.00",
			),
		).toBe(true);
		// Deterministic content address for the same machine name.
		expect(catalog.catalogHash).toBe(
			createLocalHostCatalog("test-machine").catalogHash,
		);
	});

	it("brokers ANY port through the wildcard test-lane definition", async () => {
		const broker = createBroker({
			stationId: "station:test",
			railHash:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			policies: defaultLocalPolicySet("broker:test"),
			catalog: createLocalHostCatalog("test-machine"),
		});
		const result = await broker.resolve({
			schemaVersion: "hobo.broker/v1",
			requestId: "req-local-1",
			scope: { bindleId: "bindle:anything" },
			requirements: [
				{ resourceId: "svc", port: "component.v1" },
				{ resourceId: "kv", port: "kv" },
				{ resourceId: "api", port: "hobo:http-service" },
			],
			spendEstimateUsd: 0,
		});
		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.placements).toHaveLength(3);
		for (const placement of result.receipt?.placements ?? []) {
			expect(placement.providerId).toBe(LOCAL_HOST_PROVIDER_ID);
			expect(placement.region).toBe(LOCAL_HOST_REGION);
		}
	});
});
