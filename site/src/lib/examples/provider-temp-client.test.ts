import { describe, expect, it, vi } from "vitest";
import {
	PROVIDER_TEMP_API_MISSING,
	PROVIDER_TEMP_API_VERSION,
	assertProviderTempApiReady,
	provisionProviderTempStation,
	sameOriginProviderTempApiBase,
} from "./provider-temp-client.js";

describe("provider-temp-client", () => {
	it("builds same-origin provider-temp base under /HoBo", () => {
		expect(
			sameOriginProviderTempApiBase(
				"http://127.0.0.1:4321/HoBo/examples/",
				"netlify",
			),
		).toBe("http://127.0.0.1:4321/HoBo/api/provider-temp/netlify");
	});

	it("fails closed when health returns HTML (stale/static site)", async () => {
		const fetchImpl = vi.fn(async () =>
			new Response("<!DOCTYPE html><html>", {
				status: 404,
				headers: { "content-type": "text/html" },
			}),
		);
		await expect(
			assertProviderTempApiReady({
				providerId: "netlify",
				pageUrl: "http://127.0.0.1:4321/HoBo/examples/",
				// SAFETY: vitest mock stands in for fetch at this test boundary.
				fetchImpl: fetchImpl as typeof fetch,
			}),
		).rejects.toThrow(PROVIDER_TEMP_API_MISSING);
	});

	it("provisions after health + station JSON", async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo) => {
			const url = String(input);
			if (url.endsWith("/netlify") && !url.includes("/station")) {
				return new Response(
					JSON.stringify({
						ok: true,
						apiVersion: PROVIDER_TEMP_API_VERSION,
						provider: "netlify",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					ok: true,
					apiVersion: PROVIDER_TEMP_API_VERSION,
					stationId: "st-1",
					stationUrl: "https://st-1.netlify.app",
					claimUrl: "https://app.netlify.com/access/claim/st-1",
					expiresAt: "2099-01-01T00:00:00.000Z",
					anonymous: true,
					temporary: true,
					providerId: "netlify",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const result = await provisionProviderTempStation({
			providerId: "netlify",
			stationId: "st-1",
			pageUrl: "http://127.0.0.1:4321/HoBo/examples/",
			// SAFETY: vitest mock stands in for fetch at this test boundary.
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(result.stationUrl).toContain("netlify.app");
		expect(result.claimUrl).toContain("claim");
	});
});
