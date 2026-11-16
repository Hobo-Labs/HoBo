// ADR-0157: the typed slot-binding record that compiles into Yard binding
// rows. The cases below pin the five refusals that make this a parse boundary
// rather than a shape check, plus the two determinism guarantees an authoring
// surface owes its compile target: the result is frozen, and two authorings of
// the same configuration are deep-equal regardless of key order.

import { describe, expect, it } from "vitest";
import {
	CAPABILITY_SLOTS,
	SLOT_BINDING_CONTRACT,
	SlotBindingError,
	type SlotBindingInput,
	slotBinding,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

function input(overrides: Partial<SlotBindingInput> = {}): SlotBindingInput {
	return {
		slot: "data",
		profile: "data.postgres/v1",
		productId: "aws.rds-postgres/v1",
		...overrides,
	};
}

function codeOf(build: () => JsonValue): string {
	try {
		build();
	} catch (error) {
		if (error instanceof SlotBindingError) return error.code;
		throw error;
	}
	throw new Error("expected slotBinding to refuse");
}

describe("slot vocabulary", () => {
	it("is the closed ten-slot set, frozen", () => {
		expect([...CAPABILITY_SLOTS]).toEqual([
			"web",
			"api",
			"service",
			"data",
			"kv",
			"bucket",
			"queue",
			"topic",
			"secretRef",
			"webhook",
		]);
		expect(Object.isFrozen(CAPABILITY_SLOTS)).toBe(true);
	});

	it.each([...CAPABILITY_SLOTS])("accepts the %s slot", (slot) => {
		expect(slotBinding(input({ slot })).slot).toBe(slot);
	});
});

describe("valid bindings round-trip", () => {
	it("returns the authored configuration under the versioned contract", () => {
		const binding = slotBinding(
			input({
				properties: { engineVersion: "16", multiAz: true, replicas: 2 },
			}),
		);
		expect(binding).toEqual({
			contract: SLOT_BINDING_CONTRACT,
			slot: "data",
			profile: "data.postgres/v1",
			productId: "aws.rds-postgres/v1",
			properties: { engineVersion: "16", multiAz: true, replicas: 2 },
		});
		expect(binding.contract).toBe("hobo.slot-binding/v1");
	});

	it("omits absent constraints rather than carrying undefined", () => {
		const binding = slotBinding(
			input({ productId: undefined, connectivityId: "vpc.private/v1" }),
		);
		expect(Object.keys(binding)).not.toContain("productId");
		expect(binding.connectivityId).toBe("vpc.private/v1");
	});

	it("defaults properties to an empty record, never undefined", () => {
		expect(slotBinding(input()).properties).toEqual({});
	});

	it("accepts a connectivity-only binding", () => {
		const binding = slotBinding(
			input({ productId: undefined, connectivityId: "overlay.tailnet/v1" }),
		);
		expect(binding.productId).toBeUndefined();
		expect(binding.connectivityId).toBe("overlay.tailnet/v1");
	});

	it.each([
		["data.postgres/v1", "family plus one path segment"],
		["kv/v1", "family only, no path segment"],
		["net.traffic-routing.edge/v12", "hyphens and multiple segments"],
	])("accepts profile %s (%s)", (profile) => {
		expect(slotBinding(input({ profile })).profile).toBe(profile);
	});
});

describe("SLOT_BINDING_SLOT_INVALID", () => {
	it.each([
		["database", "an unknown slot name is refused, never mapped"],
		["Web", "slot tokens are case sensitive"],
		["", "empty string is not a slot"],
		[undefined, "an absent slot never defaults"],
		[null, "null is not a slot"],
		[7, "an ordinal is not a slot"],
	])("refuses slot %o (%s)", (slot) => {
		// SAFETY: assertion required at this I/O or test boundary.
		expect(codeOf(() => slotBinding(input({ slot }) as SlotBindingInput))).toBe(
			"SLOT_BINDING_SLOT_INVALID",
		);
	});

	it("refuses a non-object input", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		expect(codeOf(() => slotBinding(null as SlotBindingInput))).toBe(
			"SLOT_BINDING_SLOT_INVALID",
		);
		// SAFETY: assertion required at this I/O or test boundary.
		expect(codeOf(() => slotBinding([] as SlotBindingInput))).toBe(
			"SLOT_BINDING_SLOT_INVALID",
		);
	});
});

describe("SLOT_BINDING_PROFILE_INVALID", () => {
	it.each([
		["data.postgres", "a profile without a version is not pinnable"],
		["data.postgres/v0", "major versions start at 1"],
		["data.postgres/v01", "no leading zeros in the major"],
		["Data.Postgres/v1", "the grammar is lowercase"],
		["data..postgres/v1", "empty path segments are refused"],
		[".postgres/v1", "the family must lead"],
		["data.postgres/v1 ", "no trimming: whitespace is a different token"],
		["data_postgres/v1", "underscores are not in the grammar"],
		["", "empty string is not a profile"],
		[undefined, "an absent profile never defaults"],
		[42, "a number is not a profile"],
	])("refuses profile %o (%s)", (profile) => {
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			codeOf(() => slotBinding(input({ profile }) as SlotBindingInput)),
		).toBe("SLOT_BINDING_PROFILE_INVALID");
	});
});

describe("SLOT_BINDING_EMPTY_CONSTRAINT", () => {
	it.each([
		[{ productId: undefined, connectivityId: undefined }, "neither present"],
		[{ productId: "", connectivityId: "" }, "both empty strings"],
		[{ productId: "   ", connectivityId: undefined }, "blank is not a pin"],
		// SAFETY: assertion required at this I/O or test boundary.
		[{ productId: 1 as string }, "a non-string is not a pin"],
	])("refuses a binding that narrows nothing (%o: %s)", (overrides) => {
		expect(codeOf(() => slotBinding(input(overrides)))).toBe(
			"SLOT_BINDING_EMPTY_CONSTRAINT",
		);
	});

	it("names the slot on the refusal so the author can locate the row", () => {
		try {
			slotBinding(input({ productId: undefined }));
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(SlotBindingError);
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as SlotBindingError).slot).toBe("data");
		}
	});
});

describe("SLOT_BINDING_CREDENTIAL_PROPERTY", () => {
	it.each([
		["password", "the bare word"],
		["dbPassword", "camelCase suffix"],
		["API_KEY", "screening is case-insensitive"],
		["apiKey", "camelCase api key"],
		["private_key", "underscored private key"],
		["privateKey", "camelCase private key"],
		["accessToken", "token"],
		["clientSecret", "secret"],
		["credentialArn", "credential"],
	])("refuses property key %s (%s)", (key) => {
		expect(
			codeOf(() => slotBinding(input({ properties: { [key]: "x" } }))),
		).toBe("SLOT_BINDING_CREDENTIAL_PROPERTY");
	});

	it("screens nested keys too — a nested secret is just as leaked", () => {
		expect(
			codeOf(() =>
				slotBinding(input({ properties: { auth: { token: "abc" } } })),
			),
		).toBe("SLOT_BINDING_CREDENTIAL_PROPERTY");
	});

	it("screens keys inside arrays of objects", () => {
		expect(
			codeOf(() =>
				slotBinding(input({ properties: { users: [{ password: "p" }] } })),
			),
		).toBe("SLOT_BINDING_CREDENTIAL_PROPERTY");
	});

	it("screens on substring, so even a locator-shaped key is refused", () => {
		expect(
			codeOf(() => slotBinding(input({ properties: { secretRefId: "s1" } }))),
		).toBe("SLOT_BINDING_CREDENTIAL_PROPERTY");
	});

	it("admits non-credential keys that merely mention a key or a ref", () => {
		const binding = slotBinding(
			input({ properties: { kmsKeyAlias: "alias/db", vaultRef: "v1" } }),
		);
		expect(binding.properties).toEqual({
			kmsKeyAlias: "alias/db",
			vaultRef: "v1",
		});
	});
});

describe("SLOT_BINDING_PROPERTY_NOT_JSON", () => {
	it.each([
		[{ fn: () => 1 }, "a function has no JSON representation"],
		[{ sym: Symbol("s") }, "a symbol has no JSON representation"],
		[{ missing: undefined }, "undefined has no JSON representation"],
		[{ big: 1n }, "a bigint has no JSON representation"],
		[{ nan: Number.NaN }, "NaN has no JSON representation"],
		[{ inf: Number.POSITIVE_INFINITY }, "Infinity has no JSON representation"],
		[{ when: new Date(0) }, "a class instance is not plain data"],
		[{ set: new Map() }, "a Map is not plain data"],
		[{ nested: { deep: [{ fn: () => 1 }] } }, "refusal reaches nested values"],
	])("refuses properties %o (%s)", (properties) => {
		expect(codeOf(() => slotBinding(input({ properties })))).toBe(
			"SLOT_BINDING_PROPERTY_NOT_JSON",
		);
	});

	it.each([
		[[], "an array is not a property record"],
		[null, "null is not a property record"],
		["a=b", "a string is not a property record"],
	])("refuses a non-object properties bag (%o: %s)", (properties) => {
		expect(
			codeOf(() =>
				slotBinding(
					// SAFETY: assertion required at this I/O or test boundary.
					input({ properties: properties as JsonObject }),
				),
			),
		).toBe("SLOT_BINDING_PROPERTY_NOT_JSON");
	});

	it("refuses a cycle instead of recursing forever", () => {
		const cyclic: JsonObject = { name: "loop" };
		cyclic.self = cyclic;
		expect(codeOf(() => slotBinding(input({ properties: cyclic })))).toBe(
			"SLOT_BINDING_PROPERTY_NOT_JSON",
		);
	});

	it("refuses a cycle reached through an array", () => {
		const arm: unknown[] = [];
		arm.push(arm);
		expect(codeOf(() => slotBinding(input({ properties: { arm } })))).toBe(
			"SLOT_BINDING_PROPERTY_NOT_JSON",
		);
	});

	it("accepts a repeated (non-cyclic) reference to the same object", () => {
		const shared = { region: "eu-west-1" };
		const binding = slotBinding(
			input({ properties: { primary: shared, replica: shared } }),
		);
		expect(binding.properties).toEqual({
			primary: { region: "eu-west-1" },
			replica: { region: "eu-west-1" },
		});
	});
});

describe("determinism", () => {
	it("deep-freezes the record, its properties, and nested values", () => {
		const binding = slotBinding(
			input({ properties: { tuning: { maxConnections: 20 }, zones: ["a"] } }),
		);
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding.properties)).toBe(true);
		expect(Object.isFrozen(binding.properties.tuning)).toBe(true);
		expect(Object.isFrozen(binding.properties.zones)).toBe(true);
	});

	it("sorts property keys so authoring order cannot change the record", () => {
		const forward = slotBinding(
			input({ properties: { alpha: 1, beta: 2, gamma: 3 } }),
		);
		const reversed = slotBinding(
			input({ properties: { gamma: 3, beta: 2, alpha: 1 } }),
		);
		expect(Object.keys(forward.properties)).toEqual(["alpha", "beta", "gamma"]);
		expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
		expect(forward).toEqual(reversed);
	});

	it("sorts nested property keys as well", () => {
		const binding = slotBinding(
			input({ properties: { tuning: { zebra: 1, apple: 2 } } }),
		);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			Object.keys(binding.properties.tuning as JsonObject),
		).toEqual(["apple", "zebra"]);
	});

	it("does not alias the authored property bag", () => {
		const properties: JsonObject = { engineVersion: "16" };
		const binding = slotBinding(input({ properties }));
		properties.engineVersion = "17";
		expect(binding.properties.engineVersion).toBe("16");
	});
});
