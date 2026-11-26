import { describe, expect, it } from "vitest";

import {
	createExtensionRegistry,
	ExtensionRegistryError,
	parseExtensionPointId,
} from "../src/index.js";

describe("parseExtensionPointId", () => {
	it("accepts hobo.<name>/v<major> ids", () => {
		expect(parseExtensionPointId("hobo.cloud-provider/v1")).toBe(
			"hobo.cloud-provider/v1",
		);
		expect(parseExtensionPointId("hobo.code.harness-spec/v1")).toBe(
			"hobo.code.harness-spec/v1",
		);
	});

	it("rejects unversioned, non-hobo, and empty ids", () => {
		for (const bad of [
			"cloud-provider",
			"hobo.cloud-provider",
			"hobo.cloud-provider/v",
			"acme.thing/v1",
			"hobo./v1",
			"",
			42,
			undefined,
		]) {
			expect(() => parseExtensionPointId(bad)).toThrow(ExtensionRegistryError);
		}
	});
});

describe("createExtensionRegistry", () => {
	it("requires an explicit duplicate policy", () => {
		expect(() =>
			createExtensionRegistry<number>("hobo.example/v1", []),
		).toThrow(/duplicate policy/);
		expect(() =>
			createExtensionRegistry<number>("hobo.example/v1", [], {
				// @ts-expect-error invalid policy is a runtime parse failure too
				duplicates: "merge",
			}),
		).toThrow(ExtensionRegistryError);
	});

	it("throws on duplicate ids under the throw policy, seeds included", () => {
		const registry = createExtensionRegistry<number>(
			"hobo.example/v1",
			[["a", 1]],
			{ duplicates: "throw" },
		);
		registry.register("b", 2);
		expect(() => registry.register("a", 3)).toThrow(/duplicate extension id a/);
		expect(() =>
			createExtensionRegistry<number>(
				"hobo.example/v1",
				[
					["a", 1],
					["a", 2],
				],
				{ duplicates: "throw" },
			),
		).toThrow(/duplicate extension id a/);
	});

	it("documented last-wins under the replace policy", () => {
		const registry = createExtensionRegistry<number>("hobo.example/v1", [], {
			duplicates: "replace",
		});
		registry.register("a", 1);
		registry.register("a", 2);
		expect(registry.get("a")).toBe(2);
		expect(registry.size()).toBe(1);
	});

	it("sealed registries reject registration after construction", () => {
		const registry = createExtensionRegistry<number>(
			"hobo.example/v1",
			[["a", 1]],
			{ duplicates: "throw", sealed: true },
		);
		expect(registry.sealed).toBe(true);
		expect(registry.get("a")).toBe(1);
		expect(() => registry.register("b", 2)).toThrow(/sealed/);
	});

	it("lists deterministically, id-sorted", () => {
		const registry = createExtensionRegistry<number>("hobo.example/v1", [], {
			duplicates: "throw",
		});
		registry.register("zeta", 1);
		registry.register("alpha", 2);
		registry.register("mid", 3);
		expect(registry.list().map((entry) => entry.id)).toEqual([
			"alpha",
			"mid",
			"zeta",
		]);
	});

	it("require is fail-closed", () => {
		const registry = createExtensionRegistry<number>("hobo.example/v1", [], {
			duplicates: "throw",
		});
		expect(registry.get("missing")).toBeUndefined();
		expect(registry.has("missing")).toBe(false);
		expect(() => registry.require("missing")).toThrow(ExtensionRegistryError);
	});
});
