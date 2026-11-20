import { State } from "alchemy/State";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	safeAlchemyState,
	uniqueAlchemyFqns,
	verifyAlchemyStateIdentities,
} from "../src/state-identity.js";

describe("Alchemy persisted identity arrays", () => {
	it("fails closed on an accessor or proxy in the legacy output record", async () => {
		let traps = 0;
		let lists = 0;
		const accessor = Object.defineProperty({}, "fqn", {
			get() {
				traps++;
				throw new Error("getter");
			},
		});
		const proxy = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("proxy");
				},
			},
		);
		for (const output of [accessor, proxy]) {
			const state = {
				getOutput: () => Effect.succeed(output),
				list: () => {
					lists++;
					return Effect.succeed([]);
				},
			};
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture supplies the exact state methods exercised before the scan.
			const plan = {
				context: Context.make(State, state as never),
				stack: { name: "App", stage: "test" },
			} as never;
			expect(await Effect.runPromise(verifyAlchemyStateIdentities(plan))).toBe(
				false,
			);
		}
		expect(traps).toBe(0);
		expect(lists).toBe(0);
	});

	it("rejects proxied state and references before reflection", () => {
		let traps = 0;
		const state = new Proxy(
			{ fqn: "widget", downstream: [] },
			{
				ownKeys() {
					traps++;
					throw new Error("trap");
				},
			},
		);
		const downstream = new Proxy(["a"], {
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("trap");
			},
		});
		const revoked = Proxy.revocable(["a"], {});
		revoked.revoke();
		expect(safeAlchemyState(state, "widget")).toBe(false);
		expect(safeAlchemyState({ fqn: "widget", downstream }, "widget")).toBe(
			false,
		);
		expect(uniqueAlchemyFqns(revoked.proxy)).toBe(false);
		expect(traps).toBe(0);
	});

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
