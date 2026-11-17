import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createBroker } from "../src/broker.js";
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
function brokerFor(definitions: BrokerCatalogDefinition[]) {
	return createBroker({
		...common,
		catalog: { catalogHash: "sha256:catalog", definitions: () => definitions },
		trustLegacyEstimates: true,
	});
}

describe("broker catalog price ordering", () => {
	it("compares decimal prices exactly beyond floating point precision", async () => {
		const broker = brokerFor([
			candidate("a", "a", "0.10000000000000001"),
			candidate("z", "z", "0.10000000000000000"),
		]);
		expect(
			(await broker.resolve(request)).receipt?.placements[0]?.providerId,
		).toBe("z");
	});
	it("refuses malformed or negative candidate prices before choosing a winner", async () => {
		for (const price of ["0garbage", "-1", "", "Infinity"]) {
			const broker = brokerFor([
				candidate("a", "a", price),
				candidate("z", "z", "1"),
			]);
			const result = await broker.resolve(request);
			expect(result.outcome).toBe("rejected");
			expect(result.rejection?.reasons[0]?.code).toBe("catalog-price-invalid");
		}
	});
	it("does not compare prices with different units", async () => {
		const broker = brokerFor([
			candidate("a", "a", "1", "hour"),
			candidate("z", "z", "0.01", "request"),
		]);
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe(
			"catalog-price-incomparable",
		);
	});
	it("breaks exact price ties by provider and definition identity independent of input order", async () => {
		const a = candidate("provider", "a", "1.00");
		const z = candidate("provider", "z", "1.0");
		for (const defs of [
			[z, a],
			[a, z],
		])
			expect(
				(await brokerFor(defs).resolve(request)).receipt?.placements[0]
					?.definitionId,
			).toBe("a");
	});
	it("refuses duplicate candidate definition identities", async () => {
		const broker = brokerFor([
			candidate("provider", "same", "1"),
			candidate("provider", "same", "2"),
		]);
		const result = await broker.resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe(
			"catalog-definition-conflict",
		);
	});

	it("breaks provider ties by code-unit identity instead of locale collation", async () => {
		const broker = brokerFor([
			candidate("a", "a-id", "1"),
			candidate("Z", "z-id", "1"),
		]);
		expect(
			(await broker.resolve(request)).receipt?.placements[0]?.providerId,
		).toBe("Z");
	});

	it("matches an integer reference across generated high-precision prices and permutations", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.bigInt({ min: 0n, max: 99999999999999999999n }), {
					minLength: 1,
					maxLength: 7,
				}),
				async (prices) => {
					const definitions = prices.map((price, index) =>
						candidate(
							`p-${String(index).padStart(2, "0")}`,
							`d-${index}`,
							`0.${price.toString().padStart(20, "0")}`,
						),
					);
					let best = 0;
					let minimum = prices[0];
					if (minimum === undefined) throw new Error("expected a candidate");
					for (const [index, price] of prices.entries()) {
						if (price < minimum) {
							minimum = price;
							best = index;
						}
					}
					const expected = definitions[best];
					if (!expected) throw new Error("expected a winner");
					for (const ordered of [definitions, [...definitions].reverse()]) {
						const result = await brokerFor(ordered).resolve(request);
						expect(result.outcome).toBe("resolved");
						expect(result.receipt?.placements[0]?.providerId).toBe(
							expected.providerId,
						);
					}
				},
			),
			{ seed: 614519, numRuns: 300 },
		);
	});

	it("refuses incomplete catalog identities and failing capability checks", async () => {
		const missingProvider = candidate("", "bad", "1");
		const blankIdentity = candidate(" ", "bad", "1");
		const missingSku = {
			...candidate("a", "bad", "1"),
			cost: { sku: "", unit: "hour", marginalPrice: "1" },
		};
		const failing = {
			...candidate("a", "bad", "1"),
			satisfies: () => {
				throw new Error("broken capability");
			},
		};
		for (const definition of [
			missingProvider,
			blankIdentity,
			missingSku,
			failing,
		]) {
			const result = await brokerFor([definition]).resolve(request);
			expect(result.outcome).toBe("rejected");
			expect(result.rejection?.reasons[0]?.code).toBe(
				"catalog-definition-invalid",
			);
		}
	});

	it("rejects a definition whose region changes during selection", async () => {
		for (const nextRegions of [[], ["other"]]) {
			let reads = 0;
			const changing = {
				...candidate("a", "a", "1"),
				get regions() {
					return ++reads === 1 ? ["region"] : nextRegions;
				},
			};
			const result = await brokerFor([changing]).resolve(request);
			expect(result.outcome).toBe("rejected");
			expect(result.rejection?.reasons[0]?.code).toBe(
				"catalog-definition-invalid",
			);
		}
	});

	it("rejects a price that changes between comparison and the placement", async () => {
		let reads = 0;
		const changing = {
			...candidate("a", "a", "1"),
			cost: {
				sku: "a",
				unit: "hour",
				get marginalPrice() {
					return ++reads === 1 ? "1" : "0";
				},
			},
		};
		const result = await brokerFor([changing]).resolve(request);
		expect(result.outcome).toBe("rejected");
		expect(result.rejection?.reasons[0]?.code).toBe(
			"catalog-definition-invalid",
		);
	});

	it("compares prices only within the explicitly pinned provider", async () => {
		const broker = createBroker({
			...common,
			policies: {
				...policies,
				placementPolicies: [
					{
						id: "pin",
						scopeKind: "bindle",
						objective: "pinned",
						pinnedProviderId: "chosen",
					},
				],
			},
			catalog: {
				catalogHash: "sha256:catalog",
				definitions: () => [
					candidate("chosen", "chosen", "1", "hour"),
					{
						...candidate("other", "other", "0.01", "request"),
						satisfies: () => {
							throw new Error("unrelated provider");
						},
					},
				],
			},
			trustLegacyEstimates: true,
		});
		expect(
			(await broker.resolve(request)).receipt?.placements[0]?.providerId,
		).toBe("chosen");
	});
});
