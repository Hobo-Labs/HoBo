import {
	type HttpTransport,
	parseResolveRequest,
	type TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createHetznerProvider,
	HETZNER_CLOUD_SERVER_PRODUCT_ID,
	hetznerResolvers,
} from "../src/index.js";
import { type JsonValue, parseJsonObject } from "../src/json.js";

const resolver = hetznerResolvers({
	resolveCredential: async () => "fixture-access",
}).find((item) => item.productId === HETZNER_CLOUD_SERVER_PRODUCT_ID);
if (!resolver) throw new Error("server resolver missing");
const request = parseResolveRequest({
	ref: {
		slot: "service",
		productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
		logicalId: "api",
		physicalId: "17",
	},
	desired: { name: "api", location: "fsn1" },
	credentialRef: "env://HCLOUD_TOKEN",
});
const json = (status: number, value: JsonValue): TransportResponse => ({
	status,
	headers: {},
	body: JSON.stringify(value),
});

describe("hosting identity and readiness", () => {
	it("does not create after an unparseable name discovery response", async () => {
		const unpinned = parseResolveRequest({
			...request,
			ref: {
				slot: "service",
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				logicalId: "api",
			},
		});
		const calls: string[] = [];
		const transport: HttpTransport = async (call) => {
			calls.push(call.method);
			return json(200, { servers: [null] });
		};
		await expect(resolver.reconcile(unpinned, transport)).rejects.toThrow(
			/incomplete collection/i,
		);
		expect(calls).toEqual(["GET"]);
	});
	it("round-trips full artifact and owner hashes through bounded native labels", async () => {
		const artifactDigest = `sha256:${"a".repeat(64)}`,
			ownershipRef = `sha256:${"b".repeat(64)}`;
		const input = parseResolveRequest({
			...request,
			ref: {
				slot: "service",
				productId: HETZNER_CLOUD_SERVER_PRODUCT_ID,
				logicalId: "api",
			},
			desired: {
				...request.desired,
				artifactDigest,
				ownershipRef,
				serverType: "cx22",
				image: "ubuntu-24.04",
			},
		});
		let labels: JsonValue = {};
		const transport: HttpTransport = async (call) => {
			if (call.method === "POST") {
				labels = parseJsonObject(call.body ?? "{}").labels ?? {};
				return json(201, {
					server: { id: 17, name: "api", status: "running", labels },
				});
			}
			if (new URL(call.url).pathname.endsWith("/17"))
				return json(200, {
					server: { id: 17, name: "api", status: "running", labels },
				});
			return json(200, { servers: [] });
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
			operationConfirmed: true,
		});
		labels = {};
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
	it("keeps static catalog rates separate from verified billing evidence", () => {
		for (const capability of createHetznerProvider().capabilities)
			expect(
				capability.estimateCost({ port: capability.port }).pricingStatus,
			).toBe("estimate");
	});
	it("pins observation and deletion to the original physical resource", async () => {
		const calls: string[] = [];
		const transport: HttpTransport = async (call) => {
			const path = new URL(call.url).pathname;
			calls.push(`${call.method} ${path}`);
			if (call.method === "DELETE")
				return { status: 204, headers: {}, body: "" };
			if (path === "/v1/servers/17")
				return json(200, {
					server: { id: 17, name: "renamed", status: "running" },
				});
			return json(200, {
				servers: [{ id: 18, name: "api", status: "running" }],
			});
		};
		expect((await resolver.read?.(request, transport))?.physicalId).toBe("17");
		await resolver.delete(request, transport);
		expect(calls).toContain("DELETE /v1/servers/17");
		expect(calls).not.toContain("DELETE /v1/servers/18");
		expect((await resolver.read?.(request, transport))?.physicalId).toBe("17");
	});
	it("does not replace a missing pinned server by creating another", async () => {
		const calls: string[] = [];
		const transport: HttpTransport = async (call) => {
			calls.push(call.method);
			if (call.method === "POST")
				return json(201, { server: { id: 18, name: "api" } });
			return new URL(call.url).pathname.endsWith("/17")
				? json(404, {})
				: json(200, { servers: [] });
		};
		await expect(resolver.reconcile(request, transport)).rejects.toThrow(
			/physical|pinned/i,
		);
		expect(calls).not.toContain("POST");
	});
	it("rejects mismatched identity on a scoped read", async () => {
		const transport: HttpTransport = async () =>
			json(200, {
				server: { id: 18, name: "api" },
				servers: [{ id: 18, name: "api" }],
			});
		await expect(resolver.read?.(request, transport)).rejects.toThrow(
			/identity|physical/i,
		);
	});
	it.each([
		"starting",
		"running",
		"unknown",
	])("exposes confirmed readiness only when running: %s", async (status) => {
		const transport: HttpTransport = async () =>
			json(200, {
				server: { id: 17, name: "api", status },
				servers: [{ id: 17, name: "api", status }],
			});
		const result = await resolver.read?.(request, transport);
		expect(result?.outputs.ready).toBe(status === "running");
		expect(result?.outputs.operationConfirmed).toBe(status === "running");
	});
});
