import { parseManifest } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import type { PlacementCriteria, ResourceIntent } from "../src/plan-types.js";
import { matchResource } from "../src/planner/matching.js";
import type { PlacementContext } from "../src/planner/placement.js";
import { plan } from "../src/planner/plan.js";
import type {
	PlannerRegistry,
	ResourceDefinition,
} from "../src/registry/catalog.js";

function definition(
	id: string,
	regions: string[],
	price: string,
): ResourceDefinition {
	return {
		id,
		providerId: id,
		port: "kv",
		features: [],
		regions,
		specificity: 10,
		priority: 0,
		cost: { sku: "cache", unit: "hour", marginalPrice: price },
		satisfies: () => ({ kind: "full" }),
	};
}

function registry(...definitions: ResourceDefinition[]): PlannerRegistry {
	return {
		catalogHash: "sha256:test",
		definitions: () => definitions,
		providers: () => definitions.map((entry) => entry.providerId),
	};
}

function intent(overrides: Partial<ResourceIntent> = {}): ResourceIntent {
	return {
		name: "cache",
		port: "kv",
		require: [],
		prefer: [],
		negotiation: "require",
		deps: [],
		objective: "min-cost",
		...overrides,
	};
}

function criteria(overrides: Partial<PlacementCriteria>): PlacementCriteria {
	return { selectors: [], affinities: [], ...overrides };
}

const databaseEast: PlacementContext = {
	placements: [
		{
			resource: "db",
			port: "database",
			providerId: "other",
			region: "us-east",
		},
	],
};

describe("planner region constraints", () => {
	it("records the selected advertised region in a deployment plan", () => {
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasmtime", version: "1.0.0" },
			resources: { cache: { type: "data.v1", port: "kv" } },
		});
		const providers = registry(
			definition("west", ["eu-west"], "1"),
			definition("east", ["us-east"], "2"),
		);
		const result = plan(
			manifest,
			{ deploymentId: "example", region: "us-east" },
			providers,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.resources).toMatchObject([
			{ name: "cache", provider: "east", region: "us-east" },
		]);
	});

	it("filters providers against the requested region before ranking by cost", () => {
		const result = matchResource(
			intent({ region: "us-east" }),
			registry(
				definition("west", ["eu-west"], "1"),
				definition("east", ["us-east"], "2"),
			),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.definition.id).toBe("east");
		expect(result.region).toBe("us-east");
	});

	it("chooses a region satisfying the selector for a multi-region provider", () => {
		const result = matchResource(
			intent({
				placement: criteria({
					selectors: [{ key: "region", op: "eq", values: ["us-east"] }],
				}),
			}),
			registry(definition("multi", ["eu-west", "us-east"], "1")),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.region).toBe("us-east");
	});

	it("keeps eligible regions when a selector excludes only some of them", () => {
		const result = matchResource(
			intent({
				placement: criteria({
					selectors: [{ key: "region", op: "not-in", values: ["eu-west"] }],
				}),
			}),
			registry(definition("multi", ["eu-west", "us-east"], "1")),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.region).toBe("us-east");
	});

	it("rejects a selector and affinity that have no region in common", () => {
		const result = matchResource(
			intent({
				placement: criteria({
					selectors: [{ key: "region", op: "eq", values: ["eu-west"] }],
					affinities: [
						{ mode: "affinity", scope: "region", targetPort: "database" },
					],
				}),
			}),
			registry(definition("multi", ["eu-west", "us-east"], "1")),
			databaseEast,
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.remediation.code).toBe("placement.unsatisfiable");
	});

	it("rejects an explicit region that conflicts with anti-affinity", () => {
		const result = matchResource(
			intent({
				region: "us-east",
				placement: criteria({
					affinities: [
						{ mode: "anti-affinity", scope: "region", targetPort: "database" },
					],
				}),
			}),
			registry(definition("multi", ["eu-west", "us-east"], "1")),
			databaseEast,
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.remediation.code).toBe("placement.unsatisfiable");
	});

	it("rejects region affinities whose target classes have no shared region", () => {
		const result = matchResource(
			intent({
				placement: criteria({
					affinities: [
						{ mode: "affinity", scope: "region", targetPort: "database" },
						{ mode: "affinity", scope: "region", targetPort: "queue" },
					],
				}),
			}),
			registry(definition("multi", ["eu-west", "us-east"], "1")),
			{
				placements: [
					...databaseEast.placements,
					{
						resource: "queue",
						port: "queue",
						providerId: "other",
						region: "eu-west",
					},
				],
			},
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.remediation.code).toBe("placement.unsatisfiable");
	});

	it("does not invent a requested region for a provider with no region data", () => {
		const unscoped = registry(definition("global", [], "1"));
		expect(matchResource(intent(), unscoped).ok).toBe(true);
		const result = matchResource(intent({ region: "us-east" }), unscoped);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.remediation.code).toBe("placement.unsatisfiable");
	});
});
