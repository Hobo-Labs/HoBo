import { describe, expect, it } from "vitest";
import { safeAlchemyState, uniqueAlchemyFqns } from "../src/state-identity.js";

describe("Alchemy persisted identity arrays", () => {
	it("accepts dense bounded references and rejects case-folded collisions", () => {
		expect(
			safeAlchemyState({ fqn: "widget", downstream: ["a", "b"] }, "widget"),
		).toBe(true);
		expect(uniqueAlchemyFqns(["a", "b"])).toBe(true);
		expect(uniqueAlchemyFqns(["a", "A"])).toBe(false);
	});

	it("rejects sparse, decorated, and accessor-backed state without calling accessors", () => {
		const sparse: string[] = [];
		sparse.length = 1;
		const decorated = Object.assign(["a"], { extra: "b" });
		let calls = 0;
		const accessor = ["a"];
		Object.defineProperty(accessor, "0", {
			get: () => {
				calls++;
				return "a";
			},
		});
		for (const downstream of [sparse, decorated, accessor]) {
			expect(safeAlchemyState({ fqn: "widget", downstream }, "widget")).toBe(
				false,
			);
			expect(uniqueAlchemyFqns(downstream)).toBe(false);
		}
		expect(calls).toBe(0);
	});

	it("rejects oversized and malformed references before provider effects", () => {
		let enumerations = 0;
		const oversized = new Proxy(Array(1025).fill("a"), {
			ownKeys(target) {
				enumerations++;
				return Reflect.ownKeys(target);
			},
		});
		expect(
			safeAlchemyState({ fqn: "widget", downstream: oversized }, "widget"),
		).toBe(false);
		expect(enumerations).toBe(0);
		expect(
			safeAlchemyState({ fqn: "widget", downstream: ["a__b"] }, "widget"),
		).toBe(false);
	});
});
