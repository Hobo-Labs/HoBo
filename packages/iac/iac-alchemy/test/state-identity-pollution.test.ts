import { InMemoryService } from "alchemy/State";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { guardAlchemyState, safeAlchemyState } from "../src/state-identity.js";

it("does not infer missing row identities or update status from descriptor-map prototypes", () => {
	const incomplete = { unrelated: true };
	const updatingWithoutStatus = {
		fqn: "widget",
		downstream: [],
		old: { props: {}, bindings: [], attr: {} },
	};
	const valid = { fqn: "widget", downstream: [] };
	const inherited = {
		fqn: { value: "widget" },
		downstream: { value: [] },
		status: { value: "updating" },
		old: { value: { fqn: "other", downstream: [] } },
	};
	let result: boolean[] = [];
	try {
		for (const [key, value] of Object.entries(inherited))
			Object.defineProperty(Object.prototype, key, {
				configurable: true,
				value,
			});
		result = [
			safeAlchemyState(incomplete, "widget"),
			safeAlchemyState(updatingWithoutStatus, "widget"),
			safeAlchemyState(valid, "widget"),
		];
	} finally {
		for (const key of Object.keys(inherited))
			Reflect.deleteProperty(Object.prototype, key);
	}
	expect(result).toEqual([false, false, true]);
});

it("rejects accessor-backed scope requests without consulting inherited descriptor values", async () => {
	const scope = { stack: "App", stage: "test" };
	const state = guardAlchemyState(
		await Effect.runPromise(InMemoryService()),
		scope,
	);
	let traps = 0;
	const request = {
		get stack() {
			traps++;
			return "App";
		},
		stage: "test",
	};
	let attempt: ReturnType<typeof state.list>;
	try {
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get() {
				traps++;
				return "App";
			},
		});
		attempt = state.list(request);
	} finally {
		Reflect.deleteProperty(Object.prototype, "value");
	}
	await expect(Effect.runPromise(attempt)).rejects.toThrow(
		"STATE_IDENTITY_UNVERIFIED",
	);
	expect(traps).toBe(0);
});
