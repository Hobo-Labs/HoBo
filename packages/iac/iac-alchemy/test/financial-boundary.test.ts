import { describe, expect, it } from "vitest";
import { boundedFinancialReceipt } from "../src/financial-boundary.js";

describe("bounded financial receipt data", () => {
	it("rejects proxies and accessors anywhere in a receipt without reflecting on them", () => {
		let traps = 0;
		const proxy = new Proxy(
			{ account: "one" },
			{
				ownKeys() {
					traps++;
					throw new Error("proxy trap");
				},
			},
		);
		const accessor = {};
		Object.defineProperty(accessor, "claim", {
			enumerable: true,
			get() {
				traps++;
				return "claim";
			},
		});
		expect(
			boundedFinancialReceipt({ reservation: { providerAccounts: [proxy] } }),
		).toBe(false);
		expect(
			boundedFinancialReceipt({ quote: { entitlementClaims: [accessor] } }),
		).toBe(false);
		expect(traps).toBe(0);
	});

	it("bounds nested arrays, properties, depth, nodes, and text", () => {
		const sparse = Array(2);
		const decorated = Object.assign(["account"], { extra: true });
		interface CyclicEvidence {
			self?: CyclicEvidence;
		}
		const cyclic: CyclicEvidence = {};
		cyclic.self = cyclic;
		type NestedEvidence = string | { next: NestedEvidence };
		let deep: NestedEvidence = "leaf";
		for (let index = 0; index < 34; index++) deep = { next: deep };
		const fields = Object.fromEntries(
			Array.from({ length: 257 }, (_, index) => [`k${index}`, index]),
		);
		const tooManyNodes = Array.from({ length: 17 }, () => Array(1024).fill(1));
		const tooMuchText = Array(257).fill("x".repeat(4096));
		for (const value of [
			Array(1_000_000_000),
			sparse,
			decorated,
			cyclic,
			deep,
			fields,
			tooManyNodes,
			tooMuchText,
			{ $unknown: [] },
		])
			expect(boundedFinancialReceipt(value)).toBe(false);
		expect(
			boundedFinancialReceipt({ $unknown: undefined, accounts: ["one"] }),
		).toBe(true);
	});
});
