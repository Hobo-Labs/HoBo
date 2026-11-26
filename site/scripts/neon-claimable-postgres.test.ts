import { describe, expect, it } from "vitest";

import {
	NEON_CLAIMABLE_API,
	NeonClaimablePostgresError,
	provisionNeonClaimablePostgres,
} from "./neon-claimable-postgres.mts";

describe("Neon claimable Postgres (anon Temporary)", () => {
	it("mock returns Temporary postgres URL — no API key surface", async () => {
		const result = await provisionNeonClaimablePostgres({ mock: true });
		expect(result.mode).toBe("neon-claimable");
		expect(result.anonymous).toBe(true);
		expect(result.temporary).toBe(true);
		expect(result.realizesBindle).toBe("db");
		expect(result.databaseUrl).toMatch(/^postgresql:\/\//u);
		expect(result.databaseUrl).not.toMatch(/127\.0\.0\.1|localhost/iu);
		expect(result.claimUrl).toContain("neon.new/claim");
		expect(NEON_CLAIMABLE_API).toBe("https://neon.new/api/v1/database");
	});

	it("live path POSTs with no Authorization header", async () => {
		const authHeaders: string[] = [];
		const result = await provisionNeonClaimablePostgres({
			ref: "hobo-test",
			// SAFETY: fetch double records Authorization headers and returns Neon JSON.
			fetchImpl: (async (_url, init) => {
				const headers = new Headers(init?.headers);
				if (headers.has("Authorization") || headers.has("authorization")) {
					authHeaders.push(String(headers.get("Authorization")));
				}
				return new Response(
					JSON.stringify({
						status: "UNCLAIMED",
						connection_string:
							"postgresql://u:p@ep-test.us-east-2.aws.neon.tech/neondb?sslmode=require",
						claim_url: "https://neon.new/claim/test-1",
						expires_at: "2026-08-10T00:00:00.000Z",
						neon_project_id: "proj-test",
					}),
					{ status: 200 },
				);
			}) as typeof fetch,
		});
		expect(authHeaders).toEqual([]);
		expect(result.mocked).toBe(false);
		expect(result.databaseUrl).toContain("neon.tech");
		expect(result.claimUrl).toBe("https://neon.new/claim/test-1");
	});

	it("fail-closed when API errors", async () => {
		await expect(
			provisionNeonClaimablePostgres({
				// SAFETY: fetch double returns a 503 Neon error body.
				fetchImpl: (async () =>
					new Response("nope", { status: 503 })) as typeof fetch,
			}),
		).rejects.toBeInstanceOf(NeonClaimablePostgresError);
	});
});
