import { describe, expect, it } from "vitest";

import { shipOpenSaasViaTemporaryAccounts } from "./opensaas-temporary-ship.js";

describe("shipOpenSaasViaTemporaryAccounts", () => {
	it("requires Neon claimable db fields from Temporary ship API", async () => {
		const result = await shipOpenSaasViaTemporaryAccounts({
			stationId: "st-1",
			pageUrl: "http://127.0.0.1:4321/HoBo/examples/",
			root: "examples/wasp-opensaas/app",
			// SAFETY: inline fetch double returns Temporary Accounts JSON.
			fetchImpl: (async () =>
				new Response(
					JSON.stringify({
						ok: true,
						clientUrl: "https://hobo-opensaas-client.workers.dev",
						serverUrl: "https://hobo-opensaas-srv.openpouch.sh",
						claimUrl: "https://dash.cloudflare.com/claim/x",
						expiresAt: "2026-08-10T00:00:00.000Z",
						databaseMode: "neon-claimable",
						databaseClaimUrl: "https://neon.new/claim/abc",
						databaseMocked: false,
						serverMode: "openpouch-anon",
						serverMocked: false,
						anonymous: true,
						temporary: true,
					}),
					{ status: 200 },
				)) as typeof fetch,
		});
		expect(result.databaseMode).toBe("neon-claimable");
		expect(result.databaseClaimUrl).toContain("neon.new/claim");
		expect(result.databaseMocked).toBe(false);
		expect(result.serverMode).toBe("openpouch-anon");
		expect(result.serverUrl).toBe("https://hobo-opensaas-srv.openpouch.sh");
		expect(result.clientUrl).toBe(
			"https://hobo-opensaas-client.workers.dev",
		);
		expect(result.anonymous).toBe(true);
	});

	it("fail-closed when Neon db fields missing", async () => {
		await expect(
			shipOpenSaasViaTemporaryAccounts({
				stationId: "st-1",
				pageUrl: "http://127.0.0.1:4321/HoBo/examples/",
				root: "examples/wasp-opensaas/app",
				// SAFETY: inline fetch double returns Temporary Accounts JSON.
				fetchImpl: (async () =>
					new Response(
						JSON.stringify({
							ok: true,
							clientUrl: "https://hobo-opensaas.workers.dev",
							serverUrl: "https://hobo-opensaas.workers.dev",
							claimUrl: "https://dash.cloudflare.com/claim/x",
							expiresAt: "2026-08-10T00:00:00.000Z",
							databaseMode: "neon-claimable",
							databaseClaimUrl: "https://neon.new/claim/abc",
						}),
						{ status: 200 },
				)) as typeof fetch,
			}),
		).rejects.toThrow(/anon server mode/i);
	});

	it("accepts cloudflare-temp-neon server fallback mode", async () => {
		const result = await shipOpenSaasViaTemporaryAccounts({
			stationId: "st-1",
			pageUrl: "http://127.0.0.1:4321/HoBo/examples/",
			root: "examples/wasp-opensaas/app",
			// SAFETY: inline fetch double returns Temporary Accounts JSON.
			fetchImpl: (async () =>
				new Response(
					JSON.stringify({
						ok: true,
						clientUrl: "https://hobo-opensaas-client.workers.dev",
						serverUrl: "https://hobo-opensaas-api.aback-pangolin.workers.dev",
						claimUrl: "https://dash.cloudflare.com/claim/x",
						expiresAt: "2026-08-10T00:00:00.000Z",
						databaseMode: "neon-claimable",
						databaseClaimUrl: "https://neon.new/claim/abc",
						databaseMocked: false,
						serverMode: "cloudflare-temp-neon",
						serverMocked: false,
						anonymous: true,
						temporary: true,
					}),
					{ status: 200 },
				)) as typeof fetch,
		});
		expect(result.serverMode).toBe("cloudflare-temp-neon");
		expect(result.serverUrl).toContain(".workers.dev");
	});
});
