import { describe, expect, it, vi } from "vitest";
import {
	isLakebedStationUrl,
	provisionLakebedStationViaBroker,
	sameOriginLakebedTempApiBase,
} from "./lakebed-broker-client.js";

describe("lakebed broker client", () => {
	it("builds same-origin lakebed-temp base", () => {
		expect(
			sameOriginLakebedTempApiBase("http://127.0.0.1:4321/HoBo/examples/", "/HoBo/"),
		).toBe("http://127.0.0.1:4321/HoBo/api/lakebed-temp");
	});

	it("accepts only Lakebed station hosts", () => {
		expect(isLakebedStationUrl("https://abc.lakebed.app")).toBe(true);
		expect(isLakebedStationUrl("http://127.0.0.1:4321/api/anon/host/x")).toBe(
			false,
		);
	});

	it("provisions via mocked fetch and refuses credential leaks", async () => {
		const fetchImpl = vi.fn(async () =>
			new Response(
				JSON.stringify({
					ok: true,
					stationId: "st-1",
					stationUrl: "https://st1.lakebed.app",
					claimUrl: "https://lakebed.dev/claim/st1",
					expiresAt: new Date().toISOString(),
					anonymous: true,
					temporary: true,
					providerId: "lakebed",
				}),
				{ status: 200 },
			),
		);
		const result = await provisionLakebedStationViaBroker({
			stationId: "st-1",
			pageUrl: "http://localhost:4321/HoBo/examples/",
			// SAFETY: vitest mock stands in for fetch at this test boundary.
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(result.stationUrl).toContain("lakebed.app");
		expect(fetchImpl).toHaveBeenCalled();
	});
});
