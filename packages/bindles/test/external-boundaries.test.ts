import { describe, expect, it } from "vitest";

import { bindle, externalBoundaryViolations } from "../src/index.js";

// A Yard holds nothing external: a Bindle's b.external() is refused at
// placement unless the provider runs it for us (Marketplace).

describe("externalBoundaryViolations", () => {
	it("refuses an external another vendor runs, naming the junction remediation", () => {
		const app = bindle("shop", (b) => ({
			api: b.api(),
			auth: b.external({ endpoints: { issuer: "https://auth.example.com" } }),
		}));
		const violations = externalBoundaryViolations(app);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({ resource: "auth" });
		expect(violations[0]?.remediation).toMatch(/its own|junction/);
	});

	it("keeps a service the provider runs on our behalf", () => {
		const app = bindle("shop", (b) => ({
			api: b.api(),
			db: b.external({ managedBy: { provider: "vercel", via: "marketplace" } }),
		}));
		expect(externalBoundaryViolations(app)).toEqual([]);
	});

	it("has nothing to say about a Bindle with no externals", () => {
		expect(
			externalBoundaryViolations(bindle("plain", (b) => ({ api: b.api() }))),
		).toEqual([]);
	});
});
