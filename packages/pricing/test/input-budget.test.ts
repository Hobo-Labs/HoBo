import { describe, expect, it } from "vitest";
import { areBoundedPricingInputs, isBoundedPricingInput } from "../src/json.js";

describe("aggregate pricing input bounds", () => {
	it("charges repeated aliases for their complete string contents", () => {
		const shared = Array(600).fill("x".repeat(4096));
		expect(isBoundedPricingInput(shared)).toBe(true);
		expect(areBoundedPricingInputs([shared])).toBe(true);
		expect(areBoundedPricingInputs([shared, shared])).toBe(false);
	});

	it("charges repeated aliases for every visited node", () => {
		const shared = Array(1000).fill(Array(8).fill(0));
		expect(isBoundedPricingInput(shared)).toBe(true);
		expect(areBoundedPricingInputs(Array(10).fill(shared))).toBe(true);
		expect(areBoundedPricingInputs(Array(12).fill(shared))).toBe(false);
	});

	it("rejects nested and revoked proxies before any trap runs", () => {
		let traps = 0;
		const proxy = new Proxy(
			{},
			{
				ownKeys: () => {
					traps++;
					return [];
				},
			},
		);
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		expect(areBoundedPricingInputs([{ model: proxy }])).toBe(false);
		expect(areBoundedPricingInputs([{ model: revoked.proxy }])).toBe(false);
		expect(traps).toBe(0);
	});
});
