import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
	assertLocalIacProgram,
	digitalocean,
	mergeDigitalOceanOptions,
	realizeResourcePlan,
	realizeResourcePlans,
} from "../src/index.js";
import { isJsonObject } from "../src/json.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/provider-digitalocean-boundary.pact.json"),
		"utf8",
	),
);

describe("realize: ResourcePlan -> pulumi IacProgram", () => {
	it("realizes a compute plan into a digitalocean:app-platform-service resource (pact-recorded shape)", () => {
		const { iac } = realizeResourcePlan({
			name: "api",
			port: "compute",
			provider: "digitalocean",
			deploymentId: "shop",
		});
		assertLocalIacProgram(iac);
		const interaction = pact.interactions[2];
		const expected = interaction.response.body.iac;
		assert.equal(iac.apiVersion, expected.apiVersion);
		assert.equal(iac.provider, expected.provider);
		assert.equal(iac.resources[0].name, "api");
		assert.equal(iac.resources[0].type, "digitalocean:app-platform-service");
		assert.equal(iac.stack, "digitalocean/shop");
		assert.ok(iac.resources[0].outputs.includes("binding"));
	});

	it("realizes a whole plan with bind edges resolving across resources", () => {
		const { iac } = realizeResourcePlans(
			[
				{
					name: "api",
					port: "compute",
					provider: "digitalocean",
					deps: ["assets", "ledger"],
				},
				{ name: "assets", port: "objectStore", provider: "digitalocean" },
				{ name: "ledger", port: "database", provider: "digitalocean" },
				{ name: "hot", port: "cache", provider: "digitalocean" },
			],
			{ deploymentId: "shop" },
		);
		assertLocalIacProgram(iac);
		assert.equal(iac.resources.length, 4);
		const api = iac.resources.find((r) => r.name === "api");
		if (api === undefined) throw new Error("expected api resource");
		const bindings = api.inputs.bindings;
		assert.ok(Array.isArray(bindings));
		assert.deepEqual(
			bindings.map((binding) =>
				isJsonObject(binding) ? binding.ref : undefined,
			),
			[
				"${resources.assets.outputs.binding}",
				"${resources.ledger.outputs.binding}",
			],
		);
		assert.equal(
			iac.resources.find((r) => r.name === "ledger")?.type,
			"digitalocean:managed-postgres",
		);
	});

	it("rejects unrealizable ports (honest gap, never fabricated)", () => {
		assert.throws(() =>
			realizeResourcePlan({
				name: "jobs",
				port: "queue",
				provider: "digitalocean",
			}),
		);
	});

	it("merges only digitalocean-owned .with() option blocks; foreign blocks drop", () => {
		const merged = mergeDigitalOceanOptions([
			digitalocean.with.appPlatform({ instanceCount: 3 }),
			{
				providerId: "aws",
				port: "compute",
				optionName: "fargate",
				negotiation: "prefer",
				options: { cpu: 512 },
			},
		]);
		assert.equal(merged.instanceCount, 3);
		assert.equal(merged.instanceSizeSlug, "basic-xxs");
		assert.equal("cpu" in merged, false);
	});
});
