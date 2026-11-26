import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoutingPlan } from "@hobo/core";
import { describe, it } from "vitest";
import {
	assertDriverProgram,
	LAKEBED_DRIVER,
	lakebed,
	mergeLakebedOptions,
	realizeResourcePlan,
	realizeResourcePlans,
	realizeTrafficRoutingPlan,
} from "../src/index.js";
import { isJsonObject } from "../src/json.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/provider-lakebed-boundary.pact.json"),
		"utf8",
	),
);

describe("realize: ResourcePlan -> lakebed-deploy DRIVER program (ADR-0127)", () => {
	it("realizes a compute plan into a Capsule driver program (pact-recorded shape)", () => {
		const { driver } = realizeResourcePlan({
			name: "api",
			port: "compute",
			provider: "lakebed",
			deploymentId: "shop",
		});
		assertDriverProgram(driver);
		const expected = pact.interactions[2].response.body.driver;
		assert.equal(driver.apiVersion, expected.apiVersion);
		assert.equal(driver.driver, LAKEBED_DRIVER);
		assert.equal(driver.capsule, "capsule/shop");
		assert.equal(driver.resources[0].type, "lakebed:capsule");
		assert.ok(driver.resources[0].outputs.includes("binding"));
	});

	it("realizes a whole plan into ONE Capsule deploy with resolving bind refs", () => {
		const { driver } = realizeResourcePlans(
			[
				{ name: "api", port: "compute", provider: "lakebed", deps: ["state"] },
				{ name: "state", port: "kv", provider: "lakebed" },
				{ name: "docs", port: "database", provider: "lakebed" },
			],
			{ deploymentId: "shop" },
		);
		assertDriverProgram(driver);
		assert.equal(driver.resources.length, 3);
		const api = driver.resources.find((r) => r.name === "api");
		assert.ok(api);
		const bindings = api.inputs.bindings;
		assert.ok(Array.isArray(bindings));
		assert.deepEqual(
			bindings.map((b) => (isJsonObject(b) ? b.ref : undefined)),
			["${resources.state.outputs.binding}"],
		);
	});

	it("rejects unrealizable ports (honest gap, never fabricated)", () => {
		assert.throws(() =>
			realizeResourcePlan({ name: "jobs", port: "queue", provider: "lakebed" }),
		);
	});

	it("merges only lakebed-owned .with() option blocks; foreign blocks drop", () => {
		const merged = mergeLakebedOptions([
			lakebed.with.capsule({ coldStart: "warm" }),
			{
				providerId: "aws",
				port: "compute",
				optionName: "fargate",
				negotiation: "prefer",
				options: { cpu: 512 },
			},
		]);
		assert.equal(merged.coldStart, "warm");
		assert.equal(merged.syncRpc, true);
		assert.equal("cpu" in merged, false);
	});

	it("realizes a TrafficRouting plan as lakebed:traffic-route", () => {
		const plan = parseRoutingPlan({
			planId: "plan:checkout",
			intent: {
				service: "checkout",
				tenantId: "tenant-a",
				rules: [
					{
						backends: [
							{
								id: "backend:a",
								service: "checkout",
								weight: 60,
								endpoint: "https://a.lakebed.app",
							},
							{
								id: "backend:b",
								service: "checkout",
								weight: 40,
								endpoint: "https://b.lakebed.app",
							},
						],
					},
				],
			},
			backends: [
				{
					id: "backend:a",
					service: "checkout",
					weight: 60,
					endpoint: "https://a.lakebed.app",
				},
				{
					id: "backend:b",
					service: "checkout",
					weight: 40,
					endpoint: "https://b.lakebed.app",
				},
			],
			createdAt: "2026-08-03T15:00:00.000Z",
		});
		const { driver } = realizeTrafficRoutingPlan(plan, {
			deploymentId: "shop",
			capsule: "capsule/shop",
		});
		assertDriverProgram(driver);
		assert.equal(driver.resources[0]?.type, "lakebed:traffic-route");
		assert.equal(driver.capsule, "capsule/shop");
		const route = driver.resources[0];
		assert.ok(route);
		assert.equal(route.inputs.planId, "plan:checkout");
	});
});
