/**
 * The tenant and environment isolation registries take their overlays as
 * parameters (L14, ledger §8.3): they never construct a Tailscale or NetBird
 * adapter themselves, so the host decides which overlay, joined with which
 * enrollment credential, each plane uses.
 */
import type { OverlayNetwork } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createEnvNetworkIsolationRegistry,
	createTenantIsolationRegistry,
	tenantFromSlug,
} from "../src/index.js";

function overlay(name: string): OverlayNetwork {
	return {
		provider: "tailscale",
		async join() {
			throw new Error(`${name} is not joined in this test`);
		},
		status: async () => null,
		async leave() {},
		tenantTags: () => [name],
	};
}

describe("createTenantIsolationRegistry(overlays)", () => {
	it("hands soft tenants the shared overlay and hard tenants their own", () => {
		const shared = overlay("shared");
		const own = new Map<string, OverlayNetwork>();
		const registry = createTenantIsolationRegistry({
			shared,
			forTenant: (tenant) => {
				const made = overlay(tenant.slug);
				own.set(tenant.slug, made);
				return made;
			},
		});
		expect(registry.registerTenant(tenantFromSlug("a", "soft")).overlay).toBe(
			shared,
		);
		expect(
			registry.registerTenant(tenantFromSlug("b", "hard-overlay")).overlay,
		).toBe(own.get("b"));
	});

	it("refuses a hard tenant when no per-tenant overlay is given", () => {
		const registry = createTenantIsolationRegistry({
			shared: overlay("shared"),
		});
		expect(() =>
			registry.registerTenant(tenantFromSlug("b", "hard-control-plane")),
		).toThrow(/needs its own overlay/u);
	});
});

describe("createEnvNetworkIsolationRegistry(overlays)", () => {
	it("hands soft classes the shared overlay and hard classes their own", () => {
		const shared = overlay("shared");
		const production = overlay("production");
		const registry = createEnvNetworkIsolationRegistry({
			shared,
			forClass: (cls) => (cls === "production" ? production : shared),
		});
		expect(
			registry.registerClass("development", { tier: "soft" }).overlay,
		).toBe(shared);
		expect(
			registry.registerClass("production", { tier: "hard-overlay" }).overlay,
		).toBe(production);
	});

	it("refuses a hard class when no per-class overlay is given", () => {
		const registry = createEnvNetworkIsolationRegistry({
			shared: overlay("shared"),
		});
		expect(() =>
			registry.registerClass("production", { tier: "hard-overlay" }),
		).toThrow(/needs its own overlay/u);
	});
});
