import { type HttpTransport, parseResolveRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { GCP_CLOUD_RUN_PRODUCT_ID, gcpResolverRegistry } from "../src/index.js";
import type { JsonObject } from "../src/json.js";

const resource = "projects/hosting-test/locations/us-central1/services/app";
const operation = "projects/hosting-test/locations/us-central1/operations/op";
const image = `us-docker.pkg.dev/hosting-test/images/app@sha256:${"a".repeat(64)}`;
const owner = `sha256:${"b".repeat(64)}`;
const artifact = `sha256:${"c".repeat(64)}`;
function request(physicalId?: string) {
	const ref = {
		slot: "service",
		productId: GCP_CLOUD_RUN_PRODUCT_ID,
		logicalId: "app",
	};
	return parseResolveRequest({
		ref: physicalId === undefined ? ref : { ...ref, physicalId },
		desired: {
			location: "us-central1",
			image,
			serviceAccount: "hosting@hosting-test.iam.gserviceaccount.com",
			cpu: "1",
			memory: "512Mi",
			minInstances: 1,
			maxInstances: 2,
			concurrency: 10,
			ownershipRef: owner,
			artifactDigest: artifact,
		},
		credentialRef: "secret://hosting/google",
	});
}
function resolver() {
	const value = gcpResolverRegistry({
		projectId: "hosting-test",
		resolveCredential: async () => "token",
		operationPoll: { attempts: 1 },
	}).get(GCP_CLOUD_RUN_PRODUCT_ID);
	if (!value) throw new Error("missing Cloud Run resolver");
	return value;
}
function response(body: JsonObject, status = 200) {
	return { status, headers: {}, body: JSON.stringify(body) };
}
const ready = {
	annotations: { "hobo.dev/owner": owner, "hobo.dev/artifact": artifact },
	name: resource,
	uri: "https://app-abc.a.run.app",
	generation: "2",
	observedGeneration: "2",
	reconciling: false,
	terminalCondition: { state: "CONDITION_SUCCEEDED" },
	template: {
		serviceAccount: "hosting@hosting-test.iam.gserviceaccount.com",
		containers: [
			{ image, resources: { limits: { cpu: "1", memory: "512Mi" } } },
		],
		scaling: { minInstanceCount: 1, maxInstanceCount: 2 },
		maxInstanceRequestConcurrency: 10,
	},
};
describe("Cloud Run authoritative hosting lifecycle", () => {
	it("reports the independently read native serving URI without inventing a URL", async () => {
		expect(
			(
				await resolver().read?.(request(), async () =>
					response({ ...ready, uri: "https://native-other.a.run.app" }),
				)
			)?.outputs.servingEndpoint,
		).toBe("https://native-other.a.run.app/");
		for (const observed of [
			{ ...ready, observedGeneration: "1" },
			{ ...ready, uri: "https://user:credential@native-other.a.run.app" },
			{ ...ready, uri: "https://unverified.example.test" },
		])
			expect(
				(await resolver().read?.(request(), async () => response(observed)))
					?.outputs.servingEndpoint,
			).toBeUndefined();
	});
	it("rejects extra sidecars outside the approved capacity and artifact shape", async () => {
		const observed = {
			...ready,
			template: {
				...ready.template,
				containers: [
					...ready.template.containers,
					{ image, resources: { limits: { cpu: "8", memory: "16Gi" } } },
				],
			},
		};
		expect(
			(await resolver().read?.(request(), async () => response(observed)))
				?.outputs.ready,
		).toBe(false);
	});
	it("uses the observed image content digest rather than a caller supplied annotation", async () => {
		const result = await resolver().read?.(request(), async () =>
			response(ready),
		);
		expect(result?.outputs).toMatchObject({
			artifactDigest: `sha256:${"a".repeat(64)}`,
			artifactMarker: artifact,
		});
		const noContent = {
			...ready,
			template: {
				...ready.template,
				containers: [{ image: "repo/app:latest" }],
			},
		};
		const missing = await resolver().read?.(request(), async () =>
			response(noContent),
		);
		expect(missing?.outputs.artifactDigest).toBeUndefined();
		expect(missing?.outputs.ready).toBe(false);
	});
	it("requires a current successful terminal condition, not merely an endpoint", async () => {
		for (const observed of [
			ready,
			{ ...ready, reconciling: true },
			{ ...ready, observedGeneration: "1" },
			{ ...ready, terminalCondition: { state: "CONDITION_PENDING" } },
		]) {
			const result = await resolver().read?.(request(), async () =>
				response(observed),
			);
			expect(result?.outputs.ready).toBe(observed === ready);
		}
	});
	it("rejects foreign resource identity and a foreign previously bound physical id", async () => {
		await expect(
			resolver().read?.(request(), async () =>
				response({
					...ready,
					name: resource.replace("hosting-test", "another-project"),
				}),
			),
		).rejects.toThrow(/identity|scope/);
		let calls = 0;
		await expect(
			resolver().read?.(
				request(resource.replace("hosting-test", "another-project")),
				async () => {
					calls++;
					return response(ready);
				},
			),
		).rejects.toThrow(/identity|scope/);
		expect(calls).toBe(0);
	});
	it("does not confirm creation from a completed operation whose resource is absent", async () => {
		let reads = 0;
		const transport: HttpTransport = async (call) => {
			if (call.method === "GET") {
				reads++;
				return response({}, 404);
			}
			return response({ name: operation, done: true });
		};
		const result = await resolver().reconcile(request(), transport);
		expect(reads).toBe(2);
		expect(result.outputs.operationConfirmed).toBe(false);
		expect(result.outputs.ready).toBe(false);
	});
	it("does not report retirement while a resource remains after terminal deletion", async () => {
		await expect(
			resolver().delete(request(resource), async (call) =>
				call.method === "DELETE"
					? response({ name: operation, done: true })
					: response(ready),
			),
		).rejects.toThrow(/still exists|absence/);
	});
	it("rejects a long-running operation in a different project", async () => {
		await expect(
			resolver().reconcile(request(), async (call) =>
				call.method === "GET"
					? response({}, 404)
					: response({
							name: operation.replace("hosting-test", "another-project"),
							done: true,
						}),
			),
		).rejects.toThrow(/scope|project/);
	});
	it("never accepts a foreign deletion operation as retirement evidence", async () => {
		let polls = 0;
		await expect(
			resolver().delete(request(resource), async (call) => {
				if (call.method === "DELETE")
					return response({
						name: operation.replace("hosting-test", "another-project"),
						done: true,
					});
				polls++;
				return response(ready);
			}),
		).rejects.toThrow(/scope|project/);
		expect(polls).toBe(1);
	});
	it("refuses to overwrite or retire a differently owned resource", async () => {
		for (const action of ["reconcile", "delete"] as const) {
			let writes = 0;
			await expect(
				resolver()[action](request(), async (call) => {
					if (call.method !== "GET") writes++;
					return response({
						...ready,
						annotations: { "hobo.dev/owner": "another-owner" },
					});
				}),
			).rejects.toThrow(/ownership/);
			expect(writes).toBe(0);
		}
	});
	it("refuses capacity drift and malformed generations even when an artifact tag matches", async () => {
		for (const observed of [
			{ ...ready, generation: true, observedGeneration: true },
			{
				...ready,
				template: {
					...ready.template,
					scaling: { minInstanceCount: 1, maxInstanceCount: 20 },
				},
			},
			{
				...ready,
				template: {
					...ready.template,
					containers: [
						{ image, resources: { limits: { cpu: "8", memory: "512Mi" } } },
					],
				},
			},
		])
			expect(
				(await resolver().read?.(request(), async () => response(observed)))
					?.outputs.ready,
			).toBe(false);
	});
	it("never retires a reused name carrying another artifact", async () => {
		let writes = 0;
		await expect(
			resolver().delete(request(), async (call) => {
				if (call.method !== "GET") writes++;
				return response({
					...ready,
					annotations: {
						"hobo.dev/owner": owner,
						"hobo.dev/artifact": `sha256:${"d".repeat(64)}`,
					},
				});
			}),
		).rejects.toThrow(/artifact/);
		expect(writes).toBe(0);
	});
	it("recognizes equivalent CPU and memory quantities without reconfiguration", async () => {
		const observed = {
			...ready,
			template: {
				...ready.template,
				containers: [
					{ image, resources: { limits: { cpu: "1000m", memory: "0.5Gi" } } },
				],
			},
		};
		expect(
			(await resolver().read?.(request(), async () => response(observed)))
				?.outputs.ready,
		).toBe(true);
	});
});
