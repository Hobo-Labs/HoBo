
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";

import {
	assertNoProviderSpecificFields,
	bindleScope,
	descriptorFromHandle,
	TOPOLOGY_CONTRACT_VERSION,
} from "../src/topology/scope-bindle.js";

const descriptor = (overrides: JsonObject = {}) => ({
	kind: "data",
	name: "db",
	stableId: "data:db",
	portRef: ["hobo:data"],
	providerAgnostic: true as const,
	...overrides,
});

describe("bindleScope", () => {
	it("builds an empty scope", () => {
		const scope = bindleScope("app", () => {});
		expect(scope).toMatchObject({
			kind: "bindle",
			contract: TOPOLOGY_CONTRACT_VERSION,
			name: "app",
			source: "programmatic",
			configFile: false,
			providerAgnostic: true,
			resources: [],
		});
	});

	it("declares itself programmatic rather than config-driven", () => {
		const scope = bindleScope("app", () => {});
		expect(scope.configFile).toBe(false);
		expect(scope.providerIds).toEqual([]);
	});

	it.each(["", null, undefined, 42])("rejects the name %s", (name) => {
		expect(() => bindleScope(name as string, () => {})).toThrow(TypeError);
	});

	it("rejects a non-function builder", () => {
		expect(() => bindleScope("app", undefined as never)).toThrow(
			/builder must be a function/u,
		);
	});

	it("collects a resource and returns its descriptor to the caller", () => {
		let returned: unknown;
		const scope = bindleScope("app", (b) => {
			returned = b.use(descriptor());
		});
		expect(scope.resources).toHaveLength(1);
		expect(returned).toMatchObject({ stableId: "data:db" });
	});

	it("collects several resources in declaration order", () => {
		const scope = bindleScope("app", (b) => {
			b.use(descriptor({ name: "a", stableId: "data:a" }));
			b.use(descriptor({ name: "b", stableId: "data:b" }));
		});
		expect(scope.resources.map((r) => r.stableId)).toEqual([
			"data:a",
			"data:b",
		]);
	});

	it("rejects two resources with the same stable id", () => {
		expect(() =>
			bindleScope("app", (b) => {
				b.use(descriptor());
				b.use(descriptor());
			}),
		).toThrow(/duplicate Bindle resource data:db/u);
	});

	it("allows the same name under different kinds", () => {
		const scope = bindleScope("app", (b) => {
			b.use(descriptor({ kind: "data", stableId: "data:x", name: "x" }));
			b.use(descriptor({ kind: "service", stableId: "service:x", name: "x" }));
		});
		expect(scope.resources).toHaveLength(2);
	});

	it("accepts a resource that supplies a toDescriptor method", () => {
		const scope = bindleScope("app", (b) => {
			b.use({ toDescriptor: () => descriptor() });
		});
		expect(scope.resources[0]).toMatchObject({ stableId: "data:db" });
	});

	it("rejects a toDescriptor that does not return an object", () => {
		expect(() =>
			bindleScope("app", (b) => {
				b.use({ toDescriptor: () => "nope" as never });
			}),
		).toThrow(/must be descriptor objects/u);
	});

	it("rejects a toDescriptor returning an array", () => {
		expect(() =>
			bindleScope("app", (b) => {
				b.use({ toDescriptor: () => [] as never });
			}),
		).toThrow(/must be descriptor objects/u);
	});

	it.each([
		"kind",
		"name",
		"stableId",
	])("rejects a resource with an empty %s", (field) => {
		expect(() =>
			bindleScope("app", (b) => {
				b.use(descriptor({ [field]: "" }));
			}),
		).toThrow(TypeError);
	});

	it("rejects a non-array portRef, naming the resource", () => {
		expect(() =>
			bindleScope("app", (b) => {
				b.use(descriptor({ portRef: "hobo:data" }));
			}),
		).toThrow(/data:db portRef must be an array/u);
	});

	it("copies portRef rather than aliasing the caller's array", () => {
		const ports = ["hobo:data"];
		const scope = bindleScope("app", (b) => {
			b.use(descriptor({ portRef: ports }));
		});
		expect(() => ports.push("hobo:kv")).not.toThrow();
		expect(scope.resources[0]?.portRef).toEqual(["hobo:data"]);
	});

	it("marks every collected resource provider-agnostic", () => {
		const scope = bindleScope("app", (b) => {
			b.use(descriptor({ providerAgnostic: false }));
		});
		expect(scope.resources[0]?.providerAgnostic).toBe(true);
	});
});

describe("provider-specific fields are refused", () => {
	it.each([
		["provider", { provider: "aws" }],
		["defaultProvider", { defaultProvider: "aws" }],
		["tiers", { tiers: { small: {} } }],
		["bindings", { bindings: [{}] }],
		["providerAnnotations", { providerAnnotations: { x: 1 } }],
		["options.providerOptions", { options: { providerOptions: { x: 1 } } }],
		["annotations.with", { annotations: { with: { x: 1 } } }],
	])("rejects a resource carrying %s", (_label, extra) => {
		expect(() =>
			bindleScope("app", (b) => {
				b.use({ ...descriptor(), ...extra });
			}),
		).toThrow(/belong on Camp mappings/u);
	});

	it("also refuses a descriptor produced by toDescriptor", () => {
		expect(() =>
			bindleScope("app", (b) => {
				b.use({
					toDescriptor: () => ({ ...descriptor(), provider: "aws" }) as never,
				});
			}),
		).toThrow(/belong on Camp mappings/u);
	});

	it("accepts an empty options object", () => {
		expect(() =>
			bindleScope("app", (b) => {
				b.use({ ...descriptor(), options: {} });
			}),
		).not.toThrow();
	});

	it("accepts annotations with no `with` clause", () => {
		expect(() =>
			bindleScope("app", (b) => {
				b.use({ ...descriptor(), annotations: {} });
			}),
		).not.toThrow();
	});

	it("ignores a falsy provider field rather than rejecting it", () => {
		expect(() =>
			bindleScope("app", (b) => {
				b.use({ ...descriptor(), provider: "" });
			}),
		).not.toThrow();
	});
});

describe("assertNoProviderSpecificFields, used directly", () => {
	it("accepts a clean descriptor", () => {
		expect(() => assertNoProviderSpecificFields(descriptor())).not.toThrow();
	});

	it.each([
		null,
		undefined,
		"string",
		42,
	])("ignores the non-object %s", (value) => {
		expect(() => assertNoProviderSpecificFields(value as never)).not.toThrow();
	});

	it("rejects a provider field", () => {
		expect(() =>
			assertNoProviderSpecificFields({ ...descriptor(), provider: "gcp" }),
		).toThrow(/belong on Camp mappings/u);
	});
});

describe("descriptorFromHandle", () => {
	it("renames the generic resource kind to data", () => {
		expect(descriptorFromHandle({ kind: "resource", name: "db" }).kind).toBe(
			"data",
		);
	});

	it("keeps a specific kind", () => {
		expect(descriptorFromHandle({ kind: "service", name: "api" }).kind).toBe(
			"service",
		);
	});

	it("derives the stable id from kind and name", () => {
		expect(
			descriptorFromHandle({ kind: "service", name: "api" }).stableId,
		).toBe("service:api");
	});

	it("uses the renamed kind in the stable id, not the original", () => {
		expect(
			descriptorFromHandle({ kind: "resource", name: "db" }).stableId,
		).toBe("data:db");
	});

	it.each([
		"service",
		"container",
	])("defaults the %s port to wasi:http", (kind) => {
		expect(descriptorFromHandle({ kind, name: "x" }).portRef).toEqual([
			"wasi:http",
		]);
	});

	it("defaults any other kind to hobo:data", () => {
		expect(descriptorFromHandle({ kind: "data", name: "db" }).portRef).toEqual([
			"hobo:data",
		]);
	});

	it("prefers an explicit port over the default", () => {
		expect(
			descriptorFromHandle({ kind: "service", name: "api", port: "hobo:kv" })
				.portRef,
		).toEqual(["hobo:kv"]);
	});

	it("marks the descriptor provider-agnostic", () => {
		expect(
			descriptorFromHandle({ kind: "data", name: "db" }).providerAgnostic,
		).toBe(true);
	});
});

describe("immutability", () => {
	it("freezes the scope, since a Bindle is hashed and deployed", () => {
		const scope = bindleScope("app", (b) => {
			b.use(descriptor());
		});
		expect(Object.isFrozen(scope)).toBe(true);
	});

	it("freezes nested resources and their port arrays", () => {
		const scope = bindleScope("app", (b) => {
			b.use(descriptor());
		});
		expect(Object.isFrozen(scope.resources)).toBe(true);
		expect(Object.isFrozen(scope.resources[0])).toBe(true);
		expect(Object.isFrozen(scope.resources[0]?.portRef)).toBe(true);
	});

	it("freezes a descriptor built from a handle", () => {
		expect(
			Object.isFrozen(descriptorFromHandle({ kind: "data", name: "db" })),
		).toBe(true);
	});

	it("freezes the collector, so a builder cannot swap `use`", () => {
		bindleScope("app", (b) => {
			expect(Object.isFrozen(b)).toBe(true);
		});
	});
});
