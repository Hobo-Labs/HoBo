/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: assertions inspect known Camp test fixtures. */
import { describe, expect, it } from "vitest";

import {
	attachCampToYard,
	CAMP_BINDLE_OWNERSHIP_FORBIDDEN,
	CAMP_MIGRATION_CODE,
	camp,
	providerSelection,
	withResolvers,
} from "../src/index.js";

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

	it("rejects bindle ownership on camp", () => {
		expect(() =>
			camp("dev", {
				bindle: { kind: "bindle" },
			}),
		).toThrow(/must not own a Bindle/);
		try {
			camp("dev", { bindle: { kind: "bindle" } });
		} catch (error) {
			expect((error as { code?: string }).code).toBe(
				CAMP_BINDLE_OWNERSHIP_FORBIDDEN,
			);
		}
	});

	it("rejects provider selection on camp authoring", () => {
		expect(() =>
			camp("dev", {
				defaultProvider: providerSelection("aws"),
			}),
		).toThrow(/must not select a cloud provider/);
		try {
			camp("dev", { defaultProvider: providerSelection("local") });
		} catch (error) {
			expect((error as { code?: string }).code).toBe(CAMP_MIGRATION_CODE);
		}
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
