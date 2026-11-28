import { describe, expect, it, vi } from "vitest";

import {
	applyStationBrokerUrlOverride,
	isWorkersDevStationUrl,
	LEGACY_DEAD_CORS_RELAY_URL,
	provisionCloudflareStationViaBroker,
	resolveStationBrokerBase,
	sameOriginTemporaryStationApiBase,
} from "./station-broker-client.js";

describe("station-broker-client", () => {
	it("uses same-origin Temporary Accounts API on localhost", () => {
		applyStationBrokerUrlOverride(undefined);
		expect(
			resolveStationBrokerBase({
				pageUrl: "http://127.0.0.1:4323/HoBo/examples/",
				basePath: "/HoBo/",
			}),
		).toBe("http://127.0.0.1:4323/HoBo/api/cf-temp");
		expect(
			sameOriginTemporaryStationApiBase(
				"http://localhost:4321/HoBo/examples/",
				"/HoBo/",
			),
		).toBe("http://localhost:4321/HoBo/api/cf-temp");
	});

	it("ignores the legacy dead CORS relay host", () => {
		expect(
			resolveStationBrokerBase({
				override: LEGACY_DEAD_CORS_RELAY_URL,
				pageUrl: "http://127.0.0.1:4321/HoBo/examples/",
				basePath: "/HoBo/",
			}),
		).toBe("http://127.0.0.1:4321/HoBo/api/cf-temp");
	});

	it("honors an explicit live broker override", () => {
		expect(
			applyStationBrokerUrlOverride("https://relay.example.workers.dev/"),
		).toBe("https://relay.example.workers.dev");
		expect(resolveStationBrokerBase()).toBe(
			"https://relay.example.workers.dev",
		);
		applyStationBrokerUrlOverride(undefined);
	});

	it("accepts only workers.dev station URLs", () => {
		expect(
			isWorkersDevStationUrl("https://hobo-env-station-x.preview.workers.dev"),
		).toBe(true);
		expect(isWorkersDevStationUrl("blob:http://127.0.0.1:4321/abc")).toBe(false);
	});

	it("provisions via broker POST /station", async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({
				ok: true,
				stationId: "station:home:cloudflare",
				scriptName: "hobo-env-station-cloudflare",
				stationUrl: "https://hobo-try-station-demo.preview.workers.dev",
				claimUrl: "https://dash.cloudflare.com/claim/demo",
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				anonymous: true,
				temporary: true,
			}),
		);
		const result = await provisionCloudflareStationViaBroker({
			stationId: "station:home:cloudflare",
			baseUrl: "https://broker.test",
			// SAFETY: vitest mock stands in for fetch at this test boundary.
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(result.stationUrl).toContain(".workers.dev");
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://broker.test/station",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("rejects blob stationUrl from broker", async () => {
		await expect(
			provisionCloudflareStationViaBroker({
				stationId: "x",
				baseUrl: "https://broker.test",
				// SAFETY: inline fetch double returns a broker JSON body.
				fetchImpl: (async () =>
					Response.json({
						ok: true,
						stationId: "x",
						scriptName: "s",
						stationUrl: "blob:http://localhost/1",
						claimUrl: "https://dash.cloudflare.com/claim/x",
						expiresAt: new Date().toISOString(),
						anonymous: true,
						temporary: true,
					})) as typeof fetch,
			}),
		).rejects.toThrow(/non-workers\.dev/);
	});

	it("fails closed on non-local hosts without a broker", () => {
		applyStationBrokerUrlOverride(undefined);
		expect(() =>
			resolveStationBrokerBase({
				pageUrl: "https://tyler-r-kendrick.github.io/HoBo/examples/",
				basePath: "/HoBo/",
			}),
		).toThrow(/No Temporary Accounts broker configured/);
	});
});
