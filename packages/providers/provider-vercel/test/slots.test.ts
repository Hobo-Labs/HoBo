import { SlotBindingError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	blob,
	edgeConfig,
	edgeFunction,
	project,
	VERCEL_BLOB_PRODUCT_ID,
	VERCEL_EDGE_CONFIG_PRODUCT_ID,
	VERCEL_EDGE_FUNCTION_PRODUCT_ID,
	VERCEL_PROJECT_PRODUCT_ID,
	vercelSlots,
} from "../src/index.js";

/** A bag with keys the typed options do not declare, as a caller could pass. */
function untypedBag<T>(json: string): T {
	// SAFETY: fixture JSON is the factory option bag, including undeclared keys
	// that must still reach slotBinding's parse boundary.
	return JSON.parse(json) as T;
}

describe("vercel slot factories", () => {
	it.each([
		[project(), "web", "provider.project/v1", VERCEL_PROJECT_PRODUCT_ID],
		[
			edgeFunction(),
			"service",
			"service.worker/v1",
			VERCEL_EDGE_FUNCTION_PRODUCT_ID,
		],
		[blob(), "bucket", "bucket.object/v1", VERCEL_BLOB_PRODUCT_ID],
		[edgeConfig(), "kv", "kv.key-value/v1", VERCEL_EDGE_CONFIG_PRODUCT_ID],
	])("binds slot %#, declaring what can be allocated", (binding, slot, profile, productId) => {
		expect(binding.slot).toBe(slot);
		expect(binding.profile).toBe(profile);
		expect(binding.productId).toBe(productId);
		expect(binding.contract).toBe("hobo.slot-binding/v1");
	});

	it("takes no arguments and invents no provider settings", () => {
		expect(project().properties).toEqual({});
		expect(edgeFunction().properties).toEqual({});
		expect(blob().properties).toEqual({});
		expect(edgeConfig().properties).toEqual({});
	});

	it("carries declared options into the parsed properties", () => {
		expect(
			project({ framework: "nextjs", rootDirectory: "apps/web" }).properties,
		).toEqual({ framework: "nextjs", rootDirectory: "apps/web" });
		expect(
			edgeFunction({ memoryMb: 1024, regions: ["iad1"] }).properties,
		).toEqual({ memoryMb: 1024, regions: ["iad1"] });
		expect(blob({ access: "private" }).properties).toEqual({
			access: "private",
		});
		expect(edgeConfig({ itemCountLimit: 32 }).properties).toEqual({
			itemCountLimit: 32,
		});
	});

	it("treats an explicit undefined as absent rather than as a value", () => {
		const binding = project({ framework: undefined });
		expect(binding.properties).toEqual({});
		expect(Object.keys(binding.properties)).not.toContain("framework");
	});

	it("forwards an undeclared key instead of silently dropping it", () => {
		const binding = project(
			untypedBag<Parameters<typeof project>[0]>(
				'{"devCommand":"pnpm dev","framework":"nextjs"}',
			),
		);
		expect(binding.properties.devCommand).toBe("pnpm dev");
	});

	it("lets core screen an undeclared credential-shaped key", () => {
		const call = () =>
			blob(
				untypedBag<Parameters<typeof blob>[0]>(
					'{"apiKey":"sk-live-ABCDEFGH1234"}',
				),
			);
		expect(call).toThrow(SlotBindingError);
		try {
			call();
			expect.unreachable("credential-shaped property must be refused");
		} catch (error) {
			if (!(error instanceof SlotBindingError)) throw error;
			expect(error.code).toBe("SLOT_BINDING_CREDENTIAL_PROPERTY");
		}
	});

	it("lets core screen a property value with no JSON representation", () => {
		const call = () => edgeConfig({ itemCountLimit: Number.POSITIVE_INFINITY });
		expect(call).toThrow(SlotBindingError);
		try {
			call();
			expect.unreachable("non-JSON property must be refused");
		} catch (error) {
			if (!(error instanceof SlotBindingError)) throw error;
			expect(error.code).toBe("SLOT_BINDING_PROPERTY_NOT_JSON");
		}
	});

	it("is deterministic and frozen", () => {
		const first = project({ framework: "nextjs" });
		const second = project({ framework: "nextjs" });
		expect(first).toEqual(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.properties)).toBe(true);
	});

	it("exposes the same factories through the frozen group", () => {
		expect(Object.isFrozen(vercelSlots)).toBe(true);
		expect(vercelSlots.project).toBe(project);
		expect(vercelSlots.edgeFunction).toBe(edgeFunction);
		expect(vercelSlots.blob).toBe(blob);
		expect(vercelSlots.edgeConfig).toBe(edgeConfig);
	});
});
