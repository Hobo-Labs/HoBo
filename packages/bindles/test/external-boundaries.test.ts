import { describe, expect, it } from "vitest";

import { bindle, externalBoundaryViolations } from "../src/index.js";

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

	it("does not treat a self-declared marketplace provider as proof", () => {
		for (const provider of ["vercel", "another-provider", ""]) {
			const app = bindle("shop", (b) => ({
				api: b.api(),
				db: b.external({ managedBy: { provider, via: "marketplace" } }),
			}));
			expect(externalBoundaryViolations(app)).toMatchObject([
				{ resource: "db" },
			]);
		}
	});

	it("has nothing to say about a Bindle with no externals", () => {
		expect(
			externalBoundaryViolations(bindle("plain", (b) => ({ api: b.api() }))),
		).toEqual([]);
	});
});
