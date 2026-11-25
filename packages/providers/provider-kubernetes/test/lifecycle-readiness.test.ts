import { parseResolveRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { parseDeploymentRecord } from "../src/api.js";
import {
	KUBERNETES_DEPLOYMENT_PRODUCT_ID,
	kubernetesResolvers,
} from "../src/resolvers.js";

function deployment(updatedReplicas = 2, observedGeneration = 2, replicas = 2) {
	return {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: {
			name: "api",
			namespace: "shop",
			uid: "11111111-2222-3333-4444-555555555555",
			resourceVersion: "123",
			generation: 2,
		},
		spec: {
			replicas: 2,
			template: {
				spec: {
					containers: [
						{
							name: "api",
							image: `registry.example/api@sha256:${"a".repeat(64)}`,
						},
					],
				},
			},
		},
		status: {
			observedGeneration,
			replicas,
			readyReplicas: 2,
			availableReplicas: 2,
			updatedReplicas,
			conditions: [],
		},
	};
}
describe("observed Kubernetes rollout readiness", () => {
	it("does not bless old available replicas while the new image is still rolling out", () => {
		expect(parseDeploymentRecord(JSON.stringify(deployment(0))).phase).toBe(
			"progressing",
		);
		expect(parseDeploymentRecord(JSON.stringify(deployment(1))).phase).toBe(
			"progressing",
		);
		expect(parseDeploymentRecord(JSON.stringify(deployment(2, 1))).phase).toBe(
			"pending",
		);
		expect(parseDeploymentRecord(JSON.stringify(deployment())).phase).toBe(
			"available",
		);
	});
	it("keeps surge rollouts progressing when only old replicas are available", () => {
		// Both new pods exist, but only the two old pods are available.
		const surging = deployment(2, 2, 4);
		expect(parseDeploymentRecord(JSON.stringify(surging)).phase).toBe(
			"progressing",
		);
		const settled = deployment(2, 2, 2);
		expect(parseDeploymentRecord(JSON.stringify(settled)).phase).toBe(
			"available",
		);
	});
	it("exports readiness and artifact evidence only from the actual controller read", async () => {
		const resolver = kubernetesResolvers({
			apiServerUrl: "https://cluster.example",
			resolveCredential: async () => "fixture-token",
		}).find((entry) => entry.productId === KUBERNETES_DEPLOYMENT_PRODUCT_ID);
		if (!resolver?.read) throw new Error("deployment observer unavailable");
		const request = parseResolveRequest({
			ref: {
				slot: "web",
				logicalId: "api",
				productId: KUBERNETES_DEPLOYMENT_PRODUCT_ID,
			},
			desired: { namespace: "shop" },
			credentialRef: "secret://camp/token",
		});
		const observed = await resolver.read(request, async () => ({
			status: 200,
			headers: {},
			body: JSON.stringify(deployment()),
		}));
		expect(observed?.outputs).toMatchObject({
			ready: true,
			operationConfirmed: true,
			lifecycleStatus: "ready",
			artifactDigest: `sha256:${"a".repeat(64)}`,
		});
		const old = await resolver.read(request, async () => ({
			status: 200,
			headers: {},
			body: JSON.stringify(deployment(0)),
		}));
		expect(old?.outputs).toMatchObject({
			ready: false,
			operationConfirmed: false,
			lifecycleStatus: "pending",
		});
		const surging = await resolver.read(request, async () => ({
			status: 200,
			headers: {},
			body: JSON.stringify(deployment(2, 2, 4)),
		}));
		expect(surging?.outputs).toMatchObject({
			ready: false,
			operationConfirmed: false,
			lifecycleStatus: "pending",
		});
	});
});
