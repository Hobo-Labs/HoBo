import {
	type HttpTransport,
	parseResolveRequest,
	type TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createDigitalOceanProvider,
	DIGITALOCEAN_APP_SERVICE_PRODUCT_ID,
	DIGITALOCEAN_DROPLET_PRODUCT_ID,
	digitaloceanResolvers,
} from "../src/index.js";
import { type JsonValue, parseJsonObject } from "../src/json.js";

const resolver = digitaloceanResolvers({
	resolveCredential: async () => "fixture-access",
}).find((item) => item.productId === DIGITALOCEAN_DROPLET_PRODUCT_ID);
if (!resolver) throw new Error("droplet resolver missing");
const request = parseResolveRequest({
	ref: {
		slot: "service",
		productId: DIGITALOCEAN_DROPLET_PRODUCT_ID,
		logicalId: "api",
		physicalId: "17",
	},
	desired: { name: "api", region: "nyc3" },
	credentialRef: "env://DIGITALOCEAN_TOKEN",
});
const json = (status: number, value: JsonValue): TransportResponse => ({
	status,
	headers: {},
	body: JSON.stringify(value),
});

describe("hosting identity and readiness", () => {
	it("does not allocate from a malformed discovery page", async () => {
		const unpinned = parseResolveRequest({
			...request,
			ref: {
				slot: "service",
				productId: DIGITALOCEAN_DROPLET_PRODUCT_ID,
				logicalId: "api",
			},
		});
		const calls: string[] = [];
		const transport: HttpTransport = async (call) => {
			calls.push(call.method);
			return json(200, { droplets: [null] });
		};
		await expect(resolver.reconcile(unpinned, transport)).rejects.toThrow(
			/incomplete collection/i,
		);
		expect(calls).toEqual(["GET"]);
	});
	it("persists markers in native tags and only observes values read from the provider", async () => {
		const artifactDigest = `sha256:${"a".repeat(64)}`,
			ownershipRef = `sha256:${"b".repeat(64)}`;
		const desired = {
			...request.desired,
			artifactDigest,
			ownershipRef,
			size: "s-1vcpu-1gb",
			image: "ubuntu-24-04-x64",
		};
		const input = parseResolveRequest({
			...request,
			ref: {
				slot: "service",
				productId: DIGITALOCEAN_DROPLET_PRODUCT_ID,
				logicalId: "api",
			},
			desired,
		});
		let tags: JsonValue = [];
		const transport: HttpTransport = async (call) => {
			if (call.method === "POST") {
				tags = parseJsonObject(call.body ?? "{}").tags ?? [];
				return json(202, {
					droplet: { id: 17, name: "api", status: "active", tags },
				});
			}
			if (new URL(call.url).pathname.endsWith("/17"))
				return json(200, {
					droplet: { id: 17, name: "api", status: "active", tags },
				});
			return json(200, { droplets: [] });
		};
		const applied = await resolver.reconcile(input, transport);
		expect(applied.outputs.operationConfirmed).toBe(false);
		const observed = await resolver.read?.(
			parseResolveRequest({
				...input,
				ref: { ...input.ref, physicalId: "17" },
			}),
			transport,
		);
		expect(observed?.outputs).toMatchObject({
			artifactDigest,
			ownershipRef,
			ready: true,
			operationConfirmed: true,
		});
		tags = [];
		expect(
			(
				await resolver.read?.(
					parseResolveRequest({
						...input,
						ref: { ...input.ref, physicalId: "17" },
					}),
					transport,
				)
			)?.outputs,
		).not.toHaveProperty("artifactDigest");
	});
	it("does not attest the requested app artifact while an older deployment remains active", async () => {
		const artifactDigest = `sha256:${"a".repeat(64)}`,
			oldDigest = `sha256:${"c".repeat(64)}`;
		const app = digitaloceanResolvers({
			resolveCredential: async () => "fixture-access",
		}).find((item) => item.productId === DIGITALOCEAN_APP_SERVICE_PRODUCT_ID);
		if (!app) throw new Error("app resolver missing");
		const input = parseResolveRequest({
			ref: {
				slot: "service",
				productId: DIGITALOCEAN_APP_SERVICE_PRODUCT_ID,
				logicalId: "api",
				physicalId: "app17",
			},
			desired: { name: "api", artifactDigest },
			credentialRef: request.credentialRef,
		});
		const transport: HttpTransport = async () =>
			json(200, {
				app: {
					id: "app17",
					spec: {
						name: "api",
						envs: [{ key: "HOBO_ARTIFACT_DIGEST", value: artifactDigest }],
					},
					active_deployment: {
						phase: "ACTIVE",
						spec: { envs: [{ key: "HOBO_ARTIFACT_DIGEST", value: oldDigest }] },
					},
					in_progress_deployment: { phase: "DEPLOYING" },
					live_url: "https://example.test",
				},
			});
		const observed = await app.read?.(input, transport);
		expect(observed?.outputs.artifactDigest).toBe(oldDigest);
		expect(observed?.outputs.ready).toBe(false);
	});
	it("publishes price estimates without certifying a free tier as a zero bill", () => {
		for (const capability of createDigitalOceanProvider().capabilities)
			expect(
				capability.estimateCost({ port: capability.port }).pricingStatus,
			).toBe("estimate");
	});
	it("reads and deletes the pinned resource even after its name changes", async () => {
		const calls: string[] = [];
		const transport: HttpTransport = async (call) => {
			const path = new URL(call.url).pathname;
			calls.push(`${call.method} ${path}`);
			if (call.method === "DELETE")
				return { status: 204, headers: {}, body: "" };
			if (path === "/v2/droplets/17")
				return json(200, {
					droplet: { id: 17, name: "renamed", status: "active" },
				});
			return json(200, {
				droplets: [{ id: 18, name: "api", status: "active" }],
			});
		};
		expect((await resolver.read?.(request, transport))?.physicalId).toBe("17");
		await resolver.delete(request, transport);
		expect(calls).toContain("DELETE /v2/droplets/17");
		expect(calls).not.toContain("DELETE /v2/droplets/18");
		expect((await resolver.read?.(request, transport))?.physicalId).toBe("17");
	});
	it("does not recreate a missing pinned resource under another identity", async () => {
		const calls: string[] = [];
		const transport: HttpTransport = async (call) => {
			calls.push(call.method);
			if (call.method === "POST")
				return json(202, { droplet: { id: 18, name: "api" } });
			return new URL(call.url).pathname.endsWith("/17")
				? json(404, {})
				: json(200, { droplets: [] });
		};
		await expect(resolver.reconcile(request, transport)).rejects.toThrow(
			/physical|pinned/i,
		);
		expect(calls).not.toContain("POST");
	});
	it("refuses an exact-ID response that identifies another resource", async () => {
		const transport: HttpTransport = async () =>
			json(200, {
				droplet: { id: 18, name: "api" },
				droplets: [{ id: 18, name: "api" }],
			});
		await expect(resolver.read?.(request, transport)).rejects.toThrow(
			/identity|physical/i,
		);
	});
	it.each([
		"new",
		"active",
		"unknown",
	])("requires explicit active state for readiness: %s", async (status) => {
		const transport: HttpTransport = async () =>
			json(200, {
				droplet: { id: 17, name: "api", status },
				droplets: [{ id: 17, name: "api", status }],
			});
		const result = await resolver.read?.(request, transport);
		expect(result?.outputs.ready).toBe(status === "active");
		expect(result?.outputs.operationConfirmed).toBe(status === "active");
	});
	it("does not adopt from an exhausted list before uniqueness is proven", async () => {
		const limited = digitaloceanResolvers({
			resolveCredential: async () => "fixture-access",
			maxListPages: 1,
		}).find((item) => item.productId === DIGITALOCEAN_DROPLET_PRODUCT_ID);
		if (!limited) throw new Error("droplet resolver missing");
		const unpinned = parseResolveRequest({
			...request,
			ref: {
				slot: "service",
				productId: DIGITALOCEAN_DROPLET_PRODUCT_ID,
				logicalId: "api",
			},
		});
		const records = Array.from({ length: 200 }, (_, id) => ({
			id: id + 1,
			name: id === 0 ? "api" : `other-${id}`,
		}));
		const transport: HttpTransport = async () =>
			json(200, { droplets: records });
		await expect(limited.read?.(unpinned, transport)).rejects.toThrow(
			/pages|uniqueness/i,
		);
	});
});
