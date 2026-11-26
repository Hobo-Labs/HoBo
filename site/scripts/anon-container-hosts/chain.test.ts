import { describe, expect, it } from "vitest";

import { runAnonHostChain } from "./chain.mts";
import { isRateLimitMessage } from "./cooldown.mts";

describe("anon-container-hosts chain", () => {
	it("detects rate-limit strings", () => {
		expect(isRateLimitMessage("HTTP 429")).toBe(true);
		expect(isRateLimitMessage("quota exhausted")).toBe(true);
		expect(isRateLimitMessage("timeout")).toBe(false);
	});

	it("mock openpouch-http succeeds first in node-dynamic chain", async () => {
		const result = await runAnonHostChain({
			workDir: "/tmp",
			chainKind: "node-dynamic",
			mock: true,
			hosts: ["openpouch-http", "clawdship"],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.host).toBe("openpouch-http");
			expect(result.mocked).toBe(true);
			expect(result.url).toContain("openpouch.sh");
		}
	});

	it("mock clawdship succeeds when listed first", async () => {
		const result = await runAnonHostChain({
			workDir: "/tmp",
			chainKind: "docker-source",
			mock: true,
			hosts: ["clawdship"],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.host).toBe("clawdship");
			expect(result.url).toContain("clawdship.dev");
		}
	});

	it("mock zerodeploy succeeds for static-shaped host id", async () => {
		const result = await runAnonHostChain({
			workDir: "/tmp",
			chainKind: "node-dynamic",
			mock: true,
			hosts: ["zerodeploy"],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.host).toBe("zerodeploy");
			expect(result.detail).toMatch(/static/i);
		}
	});
});
