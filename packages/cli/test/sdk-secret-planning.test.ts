import { bindle, collectBindleManifest } from "@hobo/bindles";
import { data } from "@hobo/bindles/wiring";
import {
	plan,
	type PlannerRegistry,
	type ResourceDefinition,
} from "@hobo/cloud";
import { describe, expect, it } from "vitest";
import { targetFromBindleDefinition } from "../src/cloud/loader.js";

/** A test-only capability contract; it is not a provider authorization. */
function definition(id: string, features: string[]): ResourceDefinition {
	return {
		id,
		providerId: id,
		port: "secretRef",
		features,
		regions: ["global"],
		specificity: 1,
		priority: 0,
		cost: { sku: id, unit: "hour", marginalPrice: "1" },
		satisfies(request) {
			if (request.port !== "secretRef") return { kind: "none" };
			const missing = (request.features ?? []).filter(
				(feature) => !features.includes(feature),
			);
			return missing.length ? { kind: "partial", missing } : { kind: "full" };
		},
	};
}

function registry(...definitions: ResourceDefinition[]): PlannerRegistry {
	return {
		catalogHash: "secret-test",
		definitions: () => definitions,
		providers: () => definitions.map((item) => item.providerId),
	};
}

describe("SDK secret planning", () => {
	it("preserves the requested read operation and selects a read-only capability", () => {
		const app = bindle("secret-test", (b) => ({
			config: b.secret().allow("access"),
			cache: b.kv().allow("get"),
		}));
		const collected = collectBindleManifest(targetFromBindleDefinition(app));
		expect(collected.manifest.value.resources.config).toMatchObject({
			paradigm: "secret",
			allow: ["access"],
		});
		expect(collected.manifest.value.resources.cache?.allow).toBeUndefined();

		const readOnlyApp = bindle("secret-test", (b) => ({
			config: b.secret().allow("access"),
		}));
		const manifest = collectBindleManifest(
			targetFromBindleDefinition(readOnlyApp),
		).manifest;
		const result = plan(
			manifest,
			{ deploymentId: "secret-test" },
			registry(definition("read-only", ["access"])),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.plan.resources[0]).toMatchObject({
			name: "config",
			port: "secretRef",
			provider: "read-only",
		});
	});

	it("rejects a read-only capability for a write request and selects a write-capable one", () => {
		const app = bindle("secret-test", (b) => ({
			config: b.secret().allow("put", "access"),
		}));
		const manifest = collectBindleManifest(
			targetFromBindleDefinition(app),
		).manifest;
		const readOnly = definition("read-only", ["access"]);
		const refused = plan(
			manifest,
			{ deploymentId: "secret-test" },
			registry(readOnly),
		);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("expected write capability refusal");
		expect(refused.remediations[0]).toMatchObject({
			code: "capability.required-not-satisfied",
			requiredPort: "secretRef",
			requiredFeatures: ["access", "put"],
			missing: ["put"],
		});
		const accepted = plan(
			manifest,
			{ deploymentId: "secret-test" },
			registry(readOnly, definition("write-capable", ["access", "put"])),
		);
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) throw new Error(accepted.reason);
		expect(accepted.plan.resources[0]?.provider).toBe("write-capable");
	});

	it("hashes the operation set deterministically and changes the hash when permission changes", () => {
		const first = bindle("secret-test", (b) => ({
			config: b.secret().allow("put", "access", "put"),
		}));
		const reordered = bindle("secret-test", (b) => ({
			config: b.secret().allow("access", "put"),
		}));
		const readOnly = bindle("secret-test", (b) => ({
			config: b.secret().allow("access"),
		}));
		const collect = (app: typeof first) =>
			collectBindleManifest(targetFromBindleDefinition(app));
		expect(collect(first).manifest.value.resources.config?.allow).toEqual([
			"access",
			"put",
		]);
		expect(collect(first).manifestHash).toBe(collect(reordered).manifestHash);
		expect(collect(first).manifestHash).not.toBe(
			collect(readOnly).manifestHash,
		);
	});

	it("snapshots allowed operations so subsequent caller mutation cannot change the manifest", () => {
		const allow = ["put", "access"];
		const handle = data("config", { paradigm: "secret", allow });
		allow.push("invented");
		expect(handle.manifest().allow).toEqual(["access", "put"]);
		const first = handle.manifest();
		expect(first.allow).toEqual(["access", "put"]);
		expect(handle.manifest().allow).not.toBe(first.allow);
	});
});
