import { parseResolveRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	AZURE_CONTAINER_APPS_PRODUCT_ID,
	azureResolverRegistry,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

const subscription = "11111111-2222-3333-4444-555555555555";
const physicalId = `/subscriptions/${subscription}/resourceGroups/hosting/providers/Microsoft.App/containerApps/app`;
const image = `registry.example/app@sha256:${"a".repeat(64)}`;
const owner = `sha256:${"b".repeat(64)}`;
const artifact = `sha256:${"c".repeat(64)}`;
const ready = {
	id: physicalId,
	tags: { "hobo.owner": owner, "hobo.artifact": artifact },
	location: "eastus",
	properties: {
		managedEnvironmentId: `/subscriptions/${subscription}/resourceGroups/hosting/providers/Microsoft.App/managedEnvironments/env`,
		provisioningState: "Succeeded",
		runningStatus: "Running",
		latestRevisionName: "app--2",
		latestReadyRevisionName: "app--2",
		template: {
			containers: [
				{ name: "app", image, resources: { cpu: 0.5, memory: "1Gi" } },
			],
			scale: { minReplicas: 1, maxReplicas: 2 },
		},
		configuration: {
			ingress: {
				external: true,
				targetPort: 8080,
				fqdn: "app.example.azurecontainerapps.io",
			},
		},
	},
};
function request(id = physicalId) {
	return parseResolveRequest({
		ref: {
			slot: "service",
			productId: AZURE_CONTAINER_APPS_PRODUCT_ID,
			logicalId: "app",
			physicalId: id,
		},
		desired: {
			image,
			location: "eastus",
			managedEnvironmentId: `/subscriptions/${subscription}/resourceGroups/hosting/providers/Microsoft.App/managedEnvironments/env`,
			ingress: "external",
			targetPort: 8080,
			cpu: 0.5,
			memory: "1Gi",
			minReplicas: 1,
			maxReplicas: 2,
			ownershipRef: owner,
			artifactDigest: artifact,
		},
		credentialRef: "secret://hosting/azure",
	});
}
function resolver() {
	const value = azureResolverRegistry({
		subscriptionId: subscription,
		resourceGroup: "hosting",
		resolveCredential: async () => "token",
		pollBudget: 1,
	}).get(AZURE_CONTAINER_APPS_PRODUCT_ID);
	if (!value) throw new Error("missing Container Apps resolver");
	return value;
}
function response(body: JsonObject, status = 200) {
	return { status, headers: {}, body: JSON.stringify(body) };
}
describe("Container Apps authoritative hosting lifecycle", () => {
	it("binds serving evidence to the actual native ingress only after readiness", async () => {
		const observed = {
			...ready,
			properties: {
				...ready.properties,
				configuration: {
					ingress: {
						...ready.properties.configuration.ingress,
						fqdn: "native-other.azurecontainerapps.io",
					},
				},
			},
		};
		expect(
			(await resolver().read?.(request(), async () => response(observed)))
				?.outputs.servingEndpoint,
		).toBe("https://native-other.azurecontainerapps.io/");
		for (const properties of [
			{ ...observed.properties, runningStatus: "Stopped" },
			{
				...observed.properties,
				configuration: {
					ingress: {
						...observed.properties.configuration.ingress,
						fqdn: "user:credential@native-other.azurecontainerapps.io",
					},
				},
			},
		])
			expect(
				(
					await resolver().read?.(request(), async () =>
						response({ ...ready, properties }),
					)
				)?.outputs.servingEndpoint,
			).toBeUndefined();
	});
	it("never approves an undeclared sidecar or init container as the quoted single-container workload", async () => {
		for (const extra of [
			{
				containers: [
					...ready.properties.template.containers,
					{ name: "sidecar", image, resources: { cpu: 8, memory: "16Gi" } },
				],
			},
			{
				initContainers: [
					{ name: "init", image, resources: { cpu: 8, memory: "16Gi" } },
				],
			},
		]) {
			const observed = {
				...ready,
				properties: {
					...ready.properties,
					template: { ...ready.properties.template, ...extra },
				},
			};
			expect(
				(await resolver().read?.(request(), async () => response(observed)))
					?.outputs.ready,
			).toBe(false);
		}
	});
	it("does not use an ownership marker as content verification", async () => {
		const result = await resolver().read?.(request(), async () =>
			response(ready),
		);
		expect(result?.outputs).toMatchObject({
			artifactDigest: `sha256:${"a".repeat(64)}`,
			artifactMarker: artifact,
		});
		const noContent = {
			...ready,
			properties: {
				...ready.properties,
				template: {
					...ready.properties.template,
					containers: [{ image: "repo/app:latest" }],
				},
			},
		};
		const missing = await resolver().read?.(request(), async () =>
			response(noContent),
		);
		expect(missing?.outputs.artifactDigest).toBeUndefined();
		expect(missing?.outputs.ready).toBe(false);
	});
	it("requires matching ready revision and running state", async () => {
		for (const observed of [
			ready,
			{
				...ready,
				properties: { ...ready.properties, latestReadyRevisionName: "app--1" },
			},
			{
				...ready,
				properties: { ...ready.properties, runningStatus: "Stopped" },
			},
		]) {
			const result = await resolver().read?.(request(), async () =>
				response(observed),
			);
			expect(result?.outputs.ready).toBe(observed === ready);
		}
	});
	it("rejects a foreign response and a previously bound physical identity", async () => {
		await expect(
			resolver().read?.(request(), async () =>
				response({
					...ready,
					id: physicalId.replace("hosting/", "another-group/"),
				}),
			),
		).rejects.toThrow(/identity|scope/);
		let calls = 0;
		await expect(
			resolver().delete(
				request(physicalId.replace("hosting/", "another-group/")),
				async () => {
					calls++;
					return response({}, 404);
				},
			),
		).rejects.toThrow(/identity|scope/);
		expect(calls).toBe(0);
	});
	it("does not report retirement merely from a delete acknowledgement", async () => {
		await expect(
			resolver().delete(request(), async (call) =>
				call.method === "DELETE"
					? { status: 204, headers: {}, body: "" }
					: response(ready),
			),
		).rejects.toThrow(/still exists|absence/);
	});
	it("confirms deletion only after a scoped absent read", async () => {
		const calls: string[] = [];
		await resolver().delete(request(), async (call) => {
			calls.push(call.method);
			return calls.length === 1
				? response(ready)
				: {
						status: call.method === "DELETE" ? 204 : 404,
						headers: {},
						body: "",
					};
		});
		expect(calls).toEqual(["GET", "DELETE", "GET"]);
	});
	it("never follows a long-running operation into another subscription", async () => {
		const calls: string[] = [];
		await expect(
			resolver().delete(request(), async (call) => {
				calls.push(call.url);
				return call.method === "GET"
					? response(ready)
					: {
							status: 202,
							headers: {
								"azure-asyncoperation": `https://management.azure.com/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/providers/Microsoft.App/locations/eastus/operations/other?api-version=2024-03-01`,
							},
							body: "",
						};
			}),
		).rejects.toThrow(/subscription scope/);
		expect(calls).toHaveLength(2);
	});
	it("refuses to overwrite or retire a differently owned resource", async () => {
		for (const action of ["reconcile", "delete"] as const) {
			let writes = 0;
			await expect(
				resolver()[action](request(), async (call) => {
					if (call.method !== "GET") writes++;
					return response({
						...ready,
						tags: { "hobo.owner": "another-owner" },
					});
				}),
			).rejects.toThrow(/ownership/);
			expect(writes).toBe(0);
		}
	});
	it("never treats an empty successful read as confirmed absence", async () => {
		await expect(
			resolver().read?.(request(), async () => ({
				status: 200,
				headers: {},
				body: "",
			})),
		).rejects.toThrow(/absence is not confirmed/);
	});
	it("never retires a reused name carrying another artifact", async () => {
		let writes = 0;
		await expect(
			resolver().delete(request(), async (call) => {
				if (call.method !== "GET") writes++;
				return response({
					...ready,
					tags: {
						"hobo.owner": owner,
						"hobo.artifact": `sha256:${"d".repeat(64)}`,
					},
				});
			}),
		).rejects.toThrow(/artifact/);
		expect(writes).toBe(0);
	});
	it("keeps an oversized or mismatched native replica bound ineligible", async () => {
		const observed = {
			...ready,
			properties: {
				...ready.properties,
				template: {
					...ready.properties.template,
					scale: { minReplicas: 1, maxReplicas: 20 },
				},
			},
		};
		expect(
			(await resolver().read?.(request(), async () => response(observed)))
				?.outputs.ready,
		).toBe(false);
	});
	it("keeps a wrong native region ineligible even with matching revision and artifact", async () => {
		expect(
			(
				await resolver().read?.(request(), async () =>
					response({ ...ready, location: "westeurope" }),
				)
			)?.outputs.ready,
		).toBe(false);
	});
});
