import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
	assertLocalIacProgram,
	createKubernetesProvider,
	KUBERNETES_PROVIDER_ID,
	KUBERNETES_TRAFFIC_ROUTING_OFFERING_IDS,
	KUBERNETES_TRAFFIC_ROUTING_PROFILE,
	kubernetes,
	kubernetesDriverProgram,
	mergeKubernetesOptions,
	parsePublishedManifest,
	realizeResourcePlan,
	realizeResourcePlans,
} from "../src/index.js";
import { isJsonObject, parseJsonObject } from "../src/json.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));

const pact = parseJsonObject(
	readFileSync(
		join(packageRoot, "../contracts/provider-kubernetes-boundary.pact.json"),
		"utf8",
	),
);

describe("realize: ResourcePlan -> pulumi IacProgram", () => {
	it("realizes a compute plan into a kubernetes:deployment resource (pact-recorded shape)", () => {
		const { iac } = realizeResourcePlan({
			name: "api",
			port: "compute",
			provider: "kubernetes",
			deploymentId: "shop",
		});
		assertLocalIacProgram(iac);
		const expected = pact.interactions[2].response.body.iac;
		assert.equal(iac.apiVersion, expected.apiVersion);
		assert.equal(iac.provider, expected.provider);
		assert.equal(iac.resources[0].name, "api");
		assert.equal(iac.resources[0].type, "kubernetes:deployment");
		assert.equal(iac.stack, "kubernetes/shop");
		assert.ok(iac.resources[0].outputs.includes("binding"));
	});

	/**
	 * `realize()` now emits the canonical IacProgram every provider emits, which
	 * is what @hobo/core's CloudProvider contract requires. The driver-program
	 * document this package used to return is still available by name, because
	 * it names the apply path `./driver.ts` actually implements.
	 */
	it("returns the canonical IacProgram from the provider factory", () => {
		const realized = createKubernetesProvider().realize({
			name: "api",
			port: "compute",
			provider: "kubernetes",
		});
		assertLocalIacProgram(realized.iac);
		assert.equal(realized.iac.resources[0].type, "kubernetes:deployment");
	});

	it("keeps the driver-program lane reachable by name", () => {
		const program = kubernetesDriverProgram({
			name: "api",
			port: "compute",
			provider: "kubernetes",
		});
		assert.equal(program.apiVersion, "hobo.driver-program/v1");
		assert.equal(program.driver, "kubernetes-deploy");
		assert.equal(program.resources[0]?.type, "kubernetes:deployment");
	});

	it("realizes a whole plan with bind edges resolving across resources", () => {
		const { iac } = realizeResourcePlans(
			[
				{
					name: "api",
					port: "compute",
					provider: "kubernetes",
					deps: ["worker"],
				},
				{ name: "worker", port: "compute", provider: "kubernetes" },
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
		if (!Array.isArray(bindings)) {
			throw new Error("expected api.inputs.bindings to be an array");
		}
		assert.deepEqual(
			bindings.map((binding) => {
				if (!isJsonObject(binding)) {
					throw new Error("expected a binding object");
				}
				return binding.ref;
			}),
			["${resources.worker.outputs.binding}"],
		);
	});

	it("rejects ports a bare cluster has no product for", () => {
		for (const port of ["database", "objectStore", "queue"]) {
			assert.throws(
				() => realizeResourcePlan({ name: "x", port, provider: "kubernetes" }),
				new RegExp(`cannot realize port ${port}`),
			);
		}
	});

	it("merges only kubernetes-owned .with() option blocks; foreign blocks drop", () => {
		const merged = mergeKubernetesOptions([
			kubernetes.with.deployment({ replicas: 3 }),
			{
				providerId: "aws",
				port: "compute",
				optionName: "fargate",
				negotiation: "prefer",
				options: { cpu: 512 },
			},
		]);
		assert.equal(merged.replicas, 3);
		assert.equal(merged.simulation, true);
		assert.equal("cpu" in merged, false);
	});
});

describe("capabilityManifest: published well-known bundle", () => {
	it("parses cleanly and publishes the projected-token posture", () => {
		const manifest = createKubernetesProvider().capabilityManifest();
		assert.equal(manifest.providerId, KUBERNETES_PROVIDER_ID);
		const parsed = parsePublishedManifest(manifest.published);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.auth.exchange, "kubernetes:BoundServiceAccountToken");
		assert.equal(parsed.auth.staticSecrets, false);
	});

	/**
	 * A structural zero, not a placeholder: the Kubernetes API charges nothing
	 * for a Deployment, and the nodes are billed by whoever owns the cluster —
	 * a provider HoBo already prices through that provider's own facts.
	 */
	it("declares a truthful zero rather than double-counting the node bill", () => {
		const compute = createKubernetesProvider().capabilities.find(
			(entry) => entry.port === "compute",
		);
		const cost = compute?.estimateCost({ port: "compute" });
		assert.equal(cost?.sku, "kubernetes.deployment.pod-hour");
		assert.equal(cost?.marginalPrice, "0.0000");
		assert.equal(cost?.freeTier.included, 0);
	});
});

describe("TrafficRouting offerings surface", () => {
	/**
	 * Simulated, not real: a Service load-balances across one Deployment's pods
	 * and nothing more. Header matching and canaries need a controller or a mesh
	 * an operator installs, so declaring them `real` would let Matching
	 * negotiate a feature that falls through on a bare cluster.
	 */
	it("declares every offering as simulated except the portable floor", () => {
		assert.ok(
			KUBERNETES_TRAFFIC_ROUTING_OFFERING_IDS.includes("inprocess.weighted"),
		);
		for (const entry of KUBERNETES_TRAFFIC_ROUTING_PROFILE.offerings) {
			if (entry.id === "inprocess.weighted") continue;
			assert.equal(
				entry.fidelity,
				"simulated",
				`${entry.id} must declare simulated fidelity on a bare cluster`,
			);
		}
		assert.ok(
			KUBERNETES_TRAFFIC_ROUTING_PROFILE.fallbacks.includes(
				"inprocess.weighted",
			),
		);
	});
});
