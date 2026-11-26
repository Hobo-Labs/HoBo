import { parseSecretRef, SecretValue } from "@hobo/bindings";
import { describe, expect, it } from "vitest";
import { createNetlifyClient } from "../src/client.js";
import { createNetlifyProvider } from "../src/provider.js";
import { createFetchTransport } from "../src/transport.js";

describe("Netlify production boundary", () => {
	it("does not treat static zero hints as verified zero-cost hosting", () => {
		for (const capability of createNetlifyProvider().capabilities)
			expect(
				capability.estimateCost({ port: capability.port }).pricingStatus,
			).toBe("unknown");
	});
	it("rejects a response for a different site before reporting access or ownership", async () => {
		const tokenRef = parseSecretRef("hobo-secret://netlify/account");
		const client = createNetlifyClient({
			transport: {
				request: async () => ({
					status: 200,
					headers: {},
					body: JSON.stringify({ id: "foreign", account_id: "account" }),
				}),
			},
			resolver: { resolve: async (ref) => new SecretValue(ref, "material") },
		});
		await expect(
			client.readSite({ siteId: "expected", tokenRef }),
		).rejects.toThrow(/different site/);
		await expect(
			client.probeSiteAccess({ siteId: "expected", tokenRef }),
		).rejects.toThrow(/different site/);
	});
	it("bounds a stalled body and keeps its mutation outcome ambiguous", async () => {
		let cancelled = false;
		const transport = createFetchTransport({
			fetchImpl: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		await expect(
			transport.request({
				method: "POST",
				url: "https://api.netlify.com/api/v1/sites",
				headers: {},
				timeoutMs: 5,
				maxResponseBytes: 32,
			}),
		).rejects.toMatchObject({ code: "PROVIDER_OPERATION_AMBIGUOUS" });
		expect(cancelled).toBe(true);
	});
});
