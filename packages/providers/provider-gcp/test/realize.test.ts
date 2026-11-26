import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
	assertLocalIacProgram,
	gcp,
	mergeGcpOptions,
	realizeResourcePlan,
	realizeResourcePlans,
} from "../src/index.js";
import { isJsonArray, isJsonObject, isJsonString } from "../src/json.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/provider-gcp-boundary.pact.json"),
		"utf8",
	),
);

describe("realize: ResourcePlan -> pulumi IacProgram", () => {
	it("realizes a compute plan into a gcp:cloud-run-service resource (pact-recorded shape)", () => {
		const { iac } = realizeResourcePlan({
			name: "api",
			port: "compute",
			provider: "gcp",
			deploymentId: "shop",
		});
		assertLocalIacProgram(iac);
		const interaction = pact.interactions[2];
		const expected = interaction.response.body.iac;
		assert.equal(iac.apiVersion, expected.apiVersion);
		assert.equal(iac.provider, expected.provider);
		assert.equal(iac.resources[0].name, "api");
		assert.equal(iac.resources[0].type, "gcp:cloud-run-service");
		assert.equal(iac.stack, "gcp/shop");
		assert.ok(iac.resources[0].outputs.includes("binding"));
	});

	it("realizes a whole plan with bind edges resolving across resources", () => {
		const { iac } = realizeResourcePlans(
			[
				{
					name: "api",
					port: "compute",
					provider: "gcp",
					deps: ["sessions", "assets"],
				},
				{ name: "sessions", port: "kv", provider: "aws" },
				{ name: "assets", port: "objectStore", provider: "aws" },
				{ name: "ledger", port: "database", provider: "aws" },
				{ name: "jobs", port: "queue", provider: "aws" },
				{ name: "hot", port: "cache", provider: "aws" },
			],
			{ deploymentId: "shop" },
		);
		assertLocalIacProgram(iac);
		assert.equal(iac.resources.length, 6);
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
			[
				// biome-ignore-start lint/suspicious/noTemplateCurlyInString: these are
				// the IaC program's own output-reference tokens, asserted verbatim. A
				// template literal would interpolate them and assert the wrong thing.
				"${resources.sessions.outputs.binding}",
				"${resources.assets.outputs.binding}",
				// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see above
			],
		);
		assert.equal(
			iac.resources.find((r) => r.name === "ledger")?.type,
			"gcp:cloud-sql-postgres",
		);
	});

	it("rejects unrealizable ports (honest gap, never fabricated)", () => {
		assert.throws(() =>
			realizeResourcePlan({
				name: "gpu",
				port: "gpu-cluster",
				provider: "gcp",
			}),
		);
	});

	it("merges only gcp-owned .with() option blocks; foreign blocks drop", () => {
		const merged = mergeGcpOptions([
			gcp.with.cloudRun({ cpu: 2 }),
			{
				providerId: "cloudflare",
				port: "compute",
				optionName: "worker",
				negotiation: "prefer",
				options: { cpuMs: 50_000 },
			},
		]);
		assert.equal(merged.cpu, 2);
		assert.equal(merged.memoryMiB, 512);
		assert.equal("cpuMs" in merged, false);
	});
});
