/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion */
import { describe, expect, it } from "vitest";

import { attachCampToYard, camp, withResolvers } from "../src/index.js";

describe("camp() — provider-neutral, no bindle ownership", () => {
	it("authors a camp without bindle or provider", () => {
		const prod = camp("prod", {
			envType: "production",
			require: ["private-ingress", "managed-container-substrate"],
			prefer: ["scale-to-zero"],
			labels: { tier: "production" },
		});

		expect(prod.kind).toBe("camp");
		expect(prod.id).toBe("prod");
		expect(prod.envType).toBe("production");
		expect(prod.require).toContain("private-ingress");
		expect(prod.derivedProviderId).toBeUndefined();
		expect((prod as { bindle?: unknown }).bindle).toBeUndefined();
	});

	it("rejects ambiguous or control-bearing logical Camp identities", () => {
		for (const logicalId of [
			"",
			" production",
			"production ",
			"prod\nother",
			"x".repeat(513),
		]) {
			expect(() => camp("prod", { logicalId })).toThrow(/logicalId/);
		}
		expect(camp("prod", { logicalId: "checkout/production" }).logicalId).toBe(
			"checkout/production",
		);
	});

	it("attaches camp to yard and derives provider", () => {
		const dev = camp("dev", { envType: "development" });
		const attached = attachCampToYard(dev, {
			yardId: "azure-prod",
			providerId: "azure",
		});
		expect(attached.id).toBe("azure-prod/dev");
		expect(attached.derivedProviderId).toBe("azure");
		expect(attached.enclosingYardId).toBe("azure-prod");
	});

	it("withResolvers adds provider-local pins after yard attachment", () => {
		const base = camp("prod", { envType: "production" });
		const withPins = withResolvers(base, {
			substrate: "azure.camp.aca-environment/v1",
		});
		expect(withPins.resolverConfig.pins).toEqual([
			{
				slot: "substrate",
				resolverId: "azure.camp.aca-environment/v1",
			},
		]);
	});
});
