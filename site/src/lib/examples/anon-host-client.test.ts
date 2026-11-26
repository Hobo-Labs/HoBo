import { describe, expect, it } from "vitest";
import {
	isAnonSameOriginProvider,
	isBlobUrl,
	isHttpStationUrl,
	provisionAnonStationViaSameOrigin,
	shipOpenSaasViaSameOriginAnon,
} from "./anon-host-client.js";

describe("anon-host-client", () => {
	it("no longer stands in Temporary Accounts via anon hosts", () => {
		// Real temp paths: cf-temp / lakebed-temp / provider-temp.
		// Railway/Vercel fail closed — never claim anon HTML is Temporary Accounts.
		expect(isAnonSameOriginProvider("railway")).toBe(false);
		expect(isAnonSameOriginProvider("browser-wasm")).toBe(false);
		expect(isAnonSameOriginProvider("cloudflare")).toBe(false);
		expect(isAnonSameOriginProvider("lakebed")).toBe(false);
	});

	it("rejects blob URLs", () => {
		expect(isBlobUrl("blob:http://127.0.0.1/abc")).toBe(true);
		expect(isHttpStationUrl("blob:http://127.0.0.1/abc")).toBe(false);
		expect(isHttpStationUrl("http://127.0.0.1:4321/HoBo/api/anon/host/x/")).toBe(
			true,
		);
	});

	it("provisions station via POST /api/anon/:provider/station", async () => {
		const result = await provisionAnonStationViaSameOrigin({
			providerId: "railway",
			stationId: "station:test:railway",
			pageUrl: "http://127.0.0.1:4321/HoBo/examples/",
			fetchImpl: async (input) => {
				expect(String(input)).toBe(
					"http://127.0.0.1:4321/HoBo/api/anon/railway/station",
				);
				return new Response(
					JSON.stringify({
						ok: true,
						stationId: "station:test:railway",
						stationUrl:
							"http://127.0.0.1:4321/HoBo/api/anon/host/railway-station-test-railway/",
						endpointUrl:
							"http://127.0.0.1:4321/HoBo/api/anon/host/railway-station-test-railway/",
						claimUrl:
							"http://127.0.0.1:4321/HoBo/api/anon/host/railway-station-test-railway/#claim",
						expiresAt: "2099-01-01T00:00:00.000Z",
						anonymous: true,
						temporary: true,
						hostKind: "same-origin-agent",
						providerId: "railway",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		});
		expect(result.endpointUrl).toContain("/api/anon/host/");
		expect(isBlobUrl(result.endpointUrl)).toBe(false);
	});

	it("refuses blob: stationUrl from broker", async () => {
		await expect(
			provisionAnonStationViaSameOrigin({
				providerId: "vercel",
				stationId: "s1",
				pageUrl: "http://127.0.0.1:4321/HoBo/examples/",
				fetchImpl: async () =>
					new Response(
						JSON.stringify({
							ok: true,
							stationId: "s1",
							stationUrl: "blob:http://127.0.0.1/x",
							endpointUrl: "blob:http://127.0.0.1/x",
							claimUrl: "blob:http://127.0.0.1/x#c",
							expiresAt: "2099-01-01T00:00:00.000Z",
							anonymous: true,
							temporary: true,
							hostKind: "same-origin-agent",
							providerId: "vercel",
						}),
						{ status: 200 },
					),
			}),
		).rejects.toThrow(/blob/);
	});

	it("ships OpenSaaS via POST /api/anon/:provider/opensaas", async () => {
		const result = await shipOpenSaasViaSameOriginAnon({
			providerId: "netlify",
			stationId: "s1",
			pageUrl: "http://127.0.0.1:4321/HoBo/examples/",
			fetchImpl: async (input) => {
				expect(String(input)).toContain("/api/anon/netlify/opensaas");
				return new Response(
					JSON.stringify({
						ok: true,
						exampleId: "opensaas",
						clientUrl:
							"http://127.0.0.1:4321/HoBo/api/anon/host/netlify-opensaas-s1/",
						serverUrl:
							"http://127.0.0.1:4321/HoBo/api/anon/host/netlify-opensaas-s1/",
						claimUrl:
							"http://127.0.0.1:4321/HoBo/api/anon/host/netlify-opensaas-s1/#claim",
						expiresAt: "2099-01-01T00:00:00.000Z",
						anonymous: true,
						temporary: true,
						hostKind: "same-origin-agent",
						providerId: "netlify",
					}),
					{ status: 200 },
				);
			},
		});
		expect(result.clientUrl).toContain("/api/anon/host/");
	});
});
