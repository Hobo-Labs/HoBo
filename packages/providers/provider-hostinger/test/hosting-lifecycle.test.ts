import {
	type HttpTransport,
	parseResolveRequest,
	type TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createHostingerProvider,
	HOSTINGER_VPS_PRODUCT_ID,
	hostingerResolvers,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

const resolver = hostingerResolvers({
	resolveCredential: async () => "fixture-access",
}).find((item) => item.productId === HOSTINGER_VPS_PRODUCT_ID);
if (!resolver) throw new Error("VPS resolver missing");
const request = parseResolveRequest({
	ref: {
		slot: "service",
		productId: HOSTINGER_VPS_PRODUCT_ID,
		logicalId: "api",
		physicalId: "17",
	},
	desired: { name: "api" },
	credentialRef: "env://HOSTINGER_API_TOKEN",
});
const json = (status: number, value: JsonValue): TransportResponse => ({
	status,
	headers: {},
	body: JSON.stringify(value),
});

describe("purchased hosting identity and readiness", () => {
	it("does not substitute an incomplete paginated list for authoritative absence", async () => {
		const unpinned = parseResolveRequest({
			...request,
			ref: {
				slot: "service",
				productId: HOSTINGER_VPS_PRODUCT_ID,
				logicalId: "api",
			},
		});
		const transport: HttpTransport = async () =>
			json(200, {
				data: [],
				links: {
					next: "https://developers.hostinger.com/api/vps/v1/virtual-machines?page=2",
				},
			});
		await expect(resolver.read?.(unpinned, transport)).rejects.toThrow(
			/partial listing/i,
		);
	});
	it("does not turn an unsupported billing cancellation into retirement", async () => {
		const calls: string[] = [];
		const transport: HttpTransport = async (call) => {
			calls.push(call.method);
			return json(200, { id: 17, hostname: "api", state: "running" });
		};
		await expect(resolver.delete(request, transport)).rejects.toThrow(
			/billing|paid plan/i,
		);
		expect((await resolver.read?.(request, transport))?.physicalId).toBe("17");
		expect(calls.every((method) => method === "GET")).toBe(true);
	});
	it("does not certify an included database as an independently free hosting plan", () => {
		const provider = createHostingerProvider();
		const database = provider.capabilities.find(
			(item) => item.port === "database",
		);
		if (!database) throw new Error("database capability missing");
		expect(database.estimateCost({ port: "database" }).pricingStatus).toBe(
			"unknown",
		);
	});
	it("reads a renamed purchased VPS by its physical identity", async () => {
		const calls: string[] = [];
		const transport: HttpTransport = async (call) => {
			const path = new URL(call.url).pathname;
			calls.push(path);
			if (path.endsWith("/17"))
				return json(200, { id: 17, hostname: "renamed", state: "running" });
			return json(200, [{ id: 18, hostname: "api", state: "running" }]);
		};
		expect((await resolver.read?.(request, transport))?.physicalId).toBe("17");
		expect(calls).toEqual(["/api/vps/v1/virtual-machines/17"]);
	});
	it("does not adopt a replacement name after a pinned VPS disappears", async () => {
		const transport: HttpTransport = async (call) =>
			new URL(call.url).pathname.endsWith("/17")
				? json(404, {})
				: json(200, [{ id: 18, hostname: "api", state: "running" }]);
		expect(await resolver.read?.(request, transport)).toBeUndefined();
		await expect(resolver.reconcile(request, transport)).rejects.toThrow(
			/physical|pinned/i,
		);
	});
	it("rejects the wrong resource on an exact-ID response", async () => {
		const transport: HttpTransport = async () =>
			json(200, {
				id: 18,
				hostname: "api",
				state: "running",
				data: [{ id: 18, hostname: "api", state: "running" }],
			});
		await expect(resolver.read?.(request, transport)).rejects.toThrow(
			/identity|physical/i,
		);
	});
	it.each([
		"installing",
		"running",
		"unknown",
	])("requires positive running state before confirmation: %s", async (state) => {
		const transport: HttpTransport = async (call) =>
			new URL(call.url).pathname.endsWith("/17")
				? json(200, { id: 17, hostname: "api", state })
				: json(200, [{ id: 17, hostname: "api", state }]);
		const result = await resolver.read?.(request, transport);
		expect(result?.outputs.ready).toBe(state === "running");
		expect(result?.outputs.operationConfirmed).toBe(state === "running");
	});
});
