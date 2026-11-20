import { types } from "node:util";
import { describe, expect, it } from "vitest";
import {
	boundedFinancialReceipt,
	validFinancialMetadata,
} from "../src/financial-boundary.js";

describe("bounded financial receipt data", () => {
	it("does not use a replaced descriptor reader to accept an accessor", () => {
		const budget = { evaluation: "denied", reservation: "not-created" };
		let reads = 0;
		let substitutions = 0;
		const receipt = Object.defineProperty({ status: "denied" }, "budget", {
			enumerable: true,
			get() {
				reads++;
				return budget;
			},
		});
		const original = Object.getOwnPropertyDescriptor;
		let bounded = true;
		let valid = true;
		try {
			Object.getOwnPropertyDescriptor = (input, key) => {
				if (input === receipt && key === "budget") {
					substitutions++;
					return { value: budget, enumerable: true, configurable: true };
				}
				return original(input, key);
			};
			bounded = boundedFinancialReceipt(receipt);
			valid = validFinancialMetadata(receipt, "tenant");
		} finally {
			Object.getOwnPropertyDescriptor = original;
		}
		expect(bounded).toBe(false);
		expect(valid).toBe(false);
		expect(reads).toBe(0);
		expect(substitutions).toBe(0);
	});

	it("rejects an accessor even if its descriptor inherits a forged value", () => {
		let traps = 0;
		const budget = { evaluation: "denied", reservation: "not-created" };
		const receipt = Object.defineProperty({ status: "denied" }, "budget", {
			enumerable: true,
			get() {
				traps++;
				return budget;
			},
		});
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		let bounded = true;
		let valid = true;
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					traps++;
					return budget;
				},
			});
			bounded = boundedFinancialReceipt(receipt);
			valid = validFinancialMetadata(receipt, "tenant");
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", previous);
		}
		expect(bounded).toBe(false);
		expect(valid).toBe(false);
		expect(traps).toBe(0);
	});

	it("uses its original proxy predicate for receipt inspection", () => {
		let traps = 0;
		const receipt = new Proxy(
			{},
			{
				getPrototypeOf() {
					traps++;
					throw new Error("proxy trap");
				},
			},
		);
		const previous = types.isProxy;
		let accepted = true;
		try {
			Reflect.set(types, "isProxy", () => false);
			accepted = boundedFinancialReceipt(receipt);
		} finally {
			Reflect.set(types, "isProxy", previous);
		}
		expect(accepted).toBe(false);
		expect(traps).toBe(0);
	});
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
