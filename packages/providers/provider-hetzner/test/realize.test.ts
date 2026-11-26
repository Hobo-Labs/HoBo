import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
	assertLocalIacProgram,
	hetzner,
	mergeHetznerOptions,
	realizeResourcePlan,
	realizeResourcePlans,
} from "../src/index.js";
import { isJsonArray, isJsonObject, isJsonString } from "../src/json.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/provider-hetzner-boundary.pact.json"),
		"utf8",
	),
);

describe("realize: ResourcePlan -> pulumi IacProgram", () => {
	it("realizes a compute plan into a hetzner:cloud-server resource (pact-recorded shape)", () => {
		const { iac } = realizeResourcePlan({
			name: "api",
			port: "compute",
			provider: "hetzner",
			deploymentId: "shop",
		});
		assertLocalIacProgram(iac);
		const expected = pact.interactions[2].response.body.iac;
		assert.equal(iac.apiVersion, expected.apiVersion);
		assert.equal(iac.provider, expected.provider);
		assert.equal(iac.resources[0].name, "api");
		assert.equal(iac.resources[0].type, "hetzner:cloud-server");
		assert.equal(iac.stack, "hetzner/shop");
		assert.ok(iac.resources[0].outputs.includes("binding"));
	});

	it("realizes a whole plan with bind edges resolving across resources", () => {
		const { iac } = realizeResourcePlans(
			[
				{
					name: "api",
					port: "compute",
					provider: "hetzner",
					deps: ["assets"],
				},
				{ name: "assets", port: "objectStore", provider: "hetzner" },
			],
			{ deploymentId: "shop" },
		);
		assertLocalIacProgram(iac);
		assert.equal(iac.resources.length, 2);
		const api = iac.resources.find((r) => r.name === "api");
		if (api === undefined) {
			throw new Error("expected an api resource");
		}
		const bindings = api.inputs.bindings;
		if (!isJsonArray(bindings)) {
			throw new Error("expected bind refs on the api resource");
		}
		assert.deepEqual(
			bindings.map((binding) => {
				if (!isJsonObject(binding) || !isJsonString(binding.ref)) {
					throw new Error("expected a bind ref");
				}
				return binding.ref;
			}),
			["${resources.assets.outputs.binding}"],
		);
		assert.equal(
			iac.resources.find((r) => r.name === "assets")?.type,
			"hetzner:object-storage-bucket",
		);
	});

	it("rejects ports Hetzner has no product for (honest gap, never fabricated)", () => {
		for (const port of ["database", "cache", "queue"]) {
			assert.throws(
				() => realizeResourcePlan({ name: "x", port, provider: "hetzner" }),
				new RegExp(`cannot realize port ${port}`),
			);
		}
	});

	it("merges only hetzner-owned .with() option blocks; foreign blocks drop", () => {
		const merged = mergeHetznerOptions([
			hetzner.with.cloudServer({ serverType: "cax21" }),
			{
				providerId: "aws",
				port: "compute",
				optionName: "fargate",
				negotiation: "prefer",
				options: { cpu: 512 },
			},
		]);
		assert.equal(merged.serverType, "cax21");
		assert.equal(merged.backups, false);
		assert.equal("cpu" in merged, false);
	});
});
