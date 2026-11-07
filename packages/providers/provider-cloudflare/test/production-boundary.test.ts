import type { HttpTransport, ResolveRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	CLOUDFLARE_R2_PRODUCT_ID,
	cloudflareResolvers,
	createCloudflareProvider,
} from "../src/index.js";

const request: ResolveRequest = {
	ref: {
		slot: "bucket",
		productId: CLOUDFLARE_R2_PRODUCT_ID,
		logicalId: "example",
	},
	desired: {},
	credentialRef: "env://CLOUDFLARE_API_TOKEN",
};
function resolver() {
	const value = cloudflareResolvers({
		accountId: "account",
		resolveCredential: async () => "scoped-material",
	}).find((candidate) => candidate.productId === CLOUDFLARE_R2_PRODUCT_ID);
	if (!value) throw new Error("R2 resolver not registered");
	return value;
}

describe("Cloudflare production resolver boundary", () => {
	it("applies its response/redirect guard even when called without an outer guard", async () => {
		const transport: HttpTransport = async () => ({
			status: 302,
			headers: { location: "https://attacker.test" },
			body: "",
		});
		await expect(resolver().read?.(request, transport)).rejects.toMatchObject({
			code: "TRANSPORT_REDIRECT_REFUSED",
		});
	});
	it("refuses an oversized provider response at the resolver boundary", async () => {
		const transport: HttpTransport = async () => ({
			status: 200,
			headers: {},
			body: "x".repeat(524289),
		});
		await expect(resolver().read?.(request, transport)).rejects.toMatchObject({
			code: "TRANSPORT_BODY_TOO_LARGE",
		});
	});
	it("parses incoming records before any provider call", async () => {
		let calls = 0;
		const transport: HttpTransport = async () => {
			calls++;
			return { status: 200, headers: {}, body: "{}" };
		};
		await expect(
			resolver().read?.(
				{ ...request, desired: { apiToken: "must-never-reach-the-provider" } },
				transport,
			),
		).rejects.toThrow();
		expect(calls).toBe(0);
	});
	it("does not treat static zero hints as verified zero-cost hosting", () => {
		for (const capability of createCloudflareProvider().capabilities)
			expect(
				capability.estimateCost({ port: capability.port }).pricingStatus,
			).toBe("unknown");
	});
});
