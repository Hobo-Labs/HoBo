import { describe, expect, it } from "vitest";

import {
	ANON_CONVEX_BACKEND_REJECTIONS,
	CONVEX_BACKEND_OCI_IMAGE,
	CONVEX_LOCAL_BACKEND_LINUX_X64_BIN_BYTES,
	ConvexAnonBackendError,
	formatAnonConvexBackendUnavailableMessage,
	OPENPOUCH_ANON_MEMORY_MAX_BYTES,
	provisionConvexBackendAnonymous,
} from "../src/ephemeral-anon.js";

describe("anon Temporary Convex backend (fail-closed live)", () => {
	it("rejection matrix covers Instanode + OpenPouch memory evidence", () => {
		const hosts = ANON_CONVEX_BACKEND_REJECTIONS.map((r) => r.host);
		expect(hosts).toContain("instanode");
		expect(hosts).toContain("openpouch-anon");
		expect(hosts).toContain("cloudflare-temporary-containers");
		expect(hosts).toContain("clawdship");
		expect(hosts).toContain("zerodeploy");
		expect(OPENPOUCH_ANON_MEMORY_MAX_BYTES).toBe(256 * 1024 * 1024);
		expect(CONVEX_LOCAL_BACKEND_LINUX_X64_BIN_BYTES).toBeGreaterThan(
			OPENPOUCH_ANON_MEMORY_MAX_BYTES * 0.7,
		);
		expect(formatAnonConvexBackendUnavailableMessage()).toMatch(
			/zero project API keys/iu,
		);
	});

	it("mock returns Temporary-shaped URL — not localhost / not convex.cloud", async () => {
		const result = await provisionConvexBackendAnonymous({ mock: true });
		expect(result.mode).toBe("anon-mock-temporary");
		expect(result.anonymous).toBe(true);
		expect(result.temporary).toBe(true);
		expect(result.unavailableLive).toBe(true);
		expect(result.backendUrl).toMatch(
			/^https:\/\/backend-.+\.anon\.hobo\.test$/u,
		);
		expect(result.backendUrl).not.toMatch(/127\.0\.0\.1|localhost/iu);
		expect(result.backendUrl).not.toMatch(/\.convex\.cloud/iu);
		expect(result.image).toBe(CONVEX_BACKEND_OCI_IMAGE);
		expect(result.claimUrl).toContain("claim");
	});

	it("live path fails closed — no credential fallback", async () => {
		await expect(
			provisionConvexBackendAnonymous({ mock: false }),
		).rejects.toBeInstanceOf(ConvexAnonBackendError);

		try {
			await provisionConvexBackendAnonymous({ forceLive: true, mock: true });
			expect.unreachable("should throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ConvexAnonBackendError);
			if (!(error instanceof ConvexAnonBackendError)) return;
			const err = error;
			expect(err.rejections.some((r) => r.host === "instanode")).toBe(true);
			expect(err.rejections.some((r) => r.host === "openpouch-anon")).toBe(
				true,
			);
			expect(err.message).not.toMatch(/E2B_API_KEY\s*=/u);
		}
	});
});
