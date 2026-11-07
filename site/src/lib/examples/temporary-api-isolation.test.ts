import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryStationMiddleware } from "../../../scripts/vite-temporary-station-api.mts";
const keys = [
	"CLOUDFLARE_API_TOKEN",
	"CLOUDFLARE_API_KEY",
	"CF_API_TOKEN",
	"CLOUDFLARE_ACCOUNT_ID",
	"VERCEL_TOKEN",
	"VERCEL_OIDC_TOKEN",
	"NOW_TOKEN",
	"NETLIFY_AUTH_TOKEN",
	"NETLIFY_ACCESS_TOKEN",
	"NETLIFY_TOKEN",
	"LAKEBED_TOKEN",
	"LAKEBED_TOKEN_API",
	"HOBO_LAKEBED_TEMP_MOCK",
	"HOBO_NETLIFY_TEMP_MOCK",
	"HOBO_VERCEL_DROP_MOCK",
];
const saved = new Map(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
	for (const key of keys) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
async function withApi(run: (base: string) => Promise<void>) {
	const middleware = temporaryStationMiddleware();
	const server = createServer((req, res) => {
		middleware(req, res, () => {
			res.statusCode = 404;
			res.end();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		if (address === null) throw new Error("missing test listener");
		// SAFETY: listen uses port 0 and a literal IPv4 host, so Node returns AddressInfo rather than a Unix socket path.
		const endpoint = address as AddressInfo;
		await run(`http://127.0.0.1:${endpoint.port}`);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}
describe("temporary API request isolation", () => {
	it("concurrent anonymous and refused requests preserve every ambient account credential", async () => {
		for (const key of keys)
			process.env[key] = key.startsWith("HOBO_") ? "1" : `sentinel-${key}`;
		await withApi(async (base) => {
			const results = await Promise.all(
				[
					"/api/cf-temp/opensaas",
					"/api/lakebed-temp/station",
					"/api/provider-temp/netlify/station",
					"/api/vercel-temp/station",
				].map((route) =>
					fetch(base + route, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ stationId: "scope-test" }),
					}),
				),
			);
			expect(results.map((r) => r.status)).toEqual([400, 200, 200, 200]);
			for (const key of keys)
				expect(process.env[key]).toBe(
					key.startsWith("HOBO_") ? "1" : `sentinel-${key}`,
				);
		});
	});
	it("real Vercel anonymous health reports unavailable and provision refuses without mutating the environment", async () => {
		delete process.env.HOBO_VERCEL_DROP_MOCK;
		process.env.VERCEL_TOKEN = "sentinel-account-token";
		await withApi(async (base) => {
			const health = await fetch(base + "/api/vercel-temp");
			expect(await health.json()).toMatchObject({
				available: false,
				anonymous: false,
				temporary: false,
				mock: false,
			});
			const response = await fetch(base + "/api/vercel-temp/station", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(response.status).toBe(501);
			expect(await response.json()).toMatchObject({
				ok: false,
				error: "anonymous-api-unavailable",
			});
			expect(process.env.VERCEL_TOKEN).toBe("sentinel-account-token");
		});
	});
	it("refuses malformed JSON and credential-bearing anonymous requests before provisioning", async () => {
		process.env.HOBO_NETLIFY_TEMP_MOCK = "1";
		await withApi(async (base) => {
			for (const body of [
				"{invalid",
				JSON.stringify({
					stationId: "invalid",
					apiToken: "must-never-be-forwarded",
				}),
			]) {
				const response = await fetch(
					base + "/api/provider-temp/netlify/station",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
					},
				);
				expect(response.status).toBe(400);
				expect(await response.text()).not.toContain("must-never-be-forwarded");
			}
		});
	});
});
