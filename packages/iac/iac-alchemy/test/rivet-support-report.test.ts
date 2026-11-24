import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { describeRivetPrimitiveSupport } from "../src/rivet-catalog.js";

it.each([
	"map",
	"join",
	"unshift",
	"iterator",
] as const)("retains Rivet capability reasons when Array %s changes", (method) => {
	const catalog = [
		{ factory: "topic", allowVerbs: ["publish", "subscribe"] },
		{ factory: "future-kind", allowVerbs: [] },
	];
	const mappers = {
		topic: {
			resourceTypes: ["Rivet.DurableObject"],
			operations: ["publish"],
			annotations: [],
			bindsEntrypoint: false,
			limitations: ["Custom publisher only."],
			build: () => Effect.die("support reporting must not build"),
		},
	};
	const nativeMap = Array.prototype.map;
	const nativeJoin = Array.prototype.join;
	const nativeUnshift = Array.prototype.unshift;
	const nativeIterator = Array.prototype[Symbol.iterator];
	let report: ReturnType<typeof describeRivetPrimitiveSupport> | undefined;
	try {
		if (method === "map")
			Reflect.set(
				Array.prototype,
				"map",
				// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve arbitrary native callbacks in this test.
				function (this: { kind?: string }[], callback: unknown) {
					if (this[0]?.kind === "topic") return [];
					// oxlint-disable-next-line anti-slop/no-reflect-apply -- Delegate unrelated native calls unchanged.
					return Reflect.apply(nativeMap, this, [callback]);
				},
			);
		if (method === "join")
			Reflect.set(
				Array.prototype,
				"join",
				function (this: string[], separator: string) {
					if (this[0] === "subscribe") return "hidden";
					// oxlint-disable-next-line anti-slop/no-reflect-apply -- Delegate unrelated native calls unchanged.
					return Reflect.apply(nativeJoin, this, [separator]);
				},
			);
		if (method === "unshift")
			Reflect.set(
				Array.prototype,
				"unshift",
				function (this: string[], ...values: string[]) {
					if (this[0] === "Custom publisher only.") return this.length;
					// oxlint-disable-next-line anti-slop/no-reflect-apply -- Delegate unrelated native calls unchanged.
					return Reflect.apply(nativeUnshift, this, values);
				},
			);
		if (method === "iterator")
			Reflect.set(Array.prototype, Symbol.iterator, function (this: string[]) {
				if (this[0] === "Custom publisher only.") return (function* () {})();
				// oxlint-disable-next-line anti-slop/no-reflect-apply -- Delegate unrelated native calls unchanged.
				return Reflect.apply(nativeIterator, this, []);
			});
		report = describeRivetPrimitiveSupport(catalog, mappers);
	} finally {
		Reflect.set(Array.prototype, "map", nativeMap);
		Reflect.set(Array.prototype, "join", nativeJoin);
		Reflect.set(Array.prototype, "unshift", nativeUnshift);
		Reflect.set(Array.prototype, Symbol.iterator, nativeIterator);
	}
	expect(report).toHaveLength(2);
	expect(report?.[0]).toMatchObject({
		kind: "topic",
		status: "partial",
		supportedOperations: ["publish"],
		unsupportedOperations: ["subscribe"],
		limitations: ["Custom publisher only."],
		reason: "Unsupported operations: subscribe. Custom publisher only.",
	});
	expect(report?.[1]).toMatchObject({
		kind: "future-kind",
		status: "unsupported",
		reason: "No Rivet Bindle mapping is implemented for this primitive.",
	});
});

it("writes Rivet support rows as dense own data", () => {
	const catalog = [{ factory: "future-kind", allowVerbs: [] }];
	const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
	let calls = 0;
	let report: ReturnType<typeof describeRivetPrimitiveSupport> | undefined;
	try {
		Object.defineProperty(Array.prototype, "0", {
			configurable: true,
			set() {
				calls++;
			},
		});
		report = describeRivetPrimitiveSupport(catalog, {});
	} finally {
		if (previous) Object.defineProperty(Array.prototype, "0", previous);
		else Reflect.deleteProperty(Array.prototype, "0");
	}
	expect(calls).toBe(0);
	expect(Object.getOwnPropertyDescriptor(report, "0")?.value.kind).toBe(
		"future-kind",
	);
});
