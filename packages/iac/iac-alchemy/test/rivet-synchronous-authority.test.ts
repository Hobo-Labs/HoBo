import { types } from "node:util";
import { expect, it } from "vitest";
import { isRivetAsyncResult } from "../src/rivet-synchronous-authority.js";

it("does not re-assimilate a fulfilled Promise's result", async () => {
	const value = {};
	const promise = Promise.resolve(value);
	let traps = 0;
	// oxlint-disable-next-line unicorn/no-thenable -- SAFETY: this fixture tests an invalid asynchronous result.
	const thenKey = "then";
	Object.defineProperty(value, thenKey, {
		get() {
			traps++;
			return undefined;
		},
	});
	expect(isRivetAsyncResult(promise)).toBe(true);
	await Promise.resolve();
	await Promise.resolve();
	expect(traps).toBe(0);
});

it("rejects changed native Promise descriptors without reading polluted descriptor prototypes", () => {
	const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
	const constructorDescriptor = Object.getOwnPropertyDescriptor(
		Promise.prototype,
		"constructor",
	);
	const inheritedGet = Object.getOwnPropertyDescriptor(Object.prototype, "get");
	const inheritedValue = Object.getOwnPropertyDescriptor(
		Object.prototype,
		"value",
	);
	if (!species || !constructorDescriptor || inheritedGet || inheritedValue)
		throw new Error("unexpected test intrinsics");
	const first = Promise.resolve(true);
	const second = Promise.resolve(true);
	let traps = 0;
	let rejectedSpecies = false;
	let rejectedConstructor = false;
	try {
		Object.defineProperty(Promise, Symbol.species, {
			value: Promise,
			configurable: true,
		});
		Object.defineProperty(Object.prototype, "get", {
			configurable: true,
			get() {
				traps++;
				throw new Error("inherited get");
			},
		});
		rejectedSpecies = isRivetAsyncResult(first);
		Reflect.deleteProperty(Object.prototype, "get");
		Object.defineProperty(Promise, Symbol.species, species);

		Object.defineProperty(Promise.prototype, "constructor", {
			configurable: true,
			get() {
				traps++;
				throw new Error("constructor getter");
			},
		});
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get() {
				traps++;
				throw new Error("inherited value");
			},
		});
		rejectedConstructor = isRivetAsyncResult(second);
	} finally {
		Reflect.deleteProperty(Object.prototype, "get");
		Reflect.deleteProperty(Object.prototype, "value");
		Object.defineProperty(Promise, Symbol.species, species);
		Object.defineProperty(
			Promise.prototype,
			"constructor",
			constructorDescriptor,
		);
	}
	expect(rejectedSpecies).toBe(true);
	expect(rejectedConstructor).toBe(true);
	expect(traps).toBe(0);
});

it("uses captured native Promise and Proxy predicates", () => {
	const proxyPredicate = Object.getOwnPropertyDescriptor(types, "isProxy");
	const promisePredicate = Object.getOwnPropertyDescriptor(types, "isPromise");
	if (!proxyPredicate || !promisePredicate)
		throw new Error("missing predicates");
	const promise = Promise.resolve(true);
	let traps = 0;
	const proxy = new Proxy(promise, {
		get() {
			traps++;
			throw new Error("proxy trap");
		},
	});
	let nativeResult = false;
	let proxyResult = false;
	try {
		Object.defineProperty(types, "isProxy", {
			value() {
				traps++;
				throw new Error("overridden proxy predicate");
			},
			configurable: true,
		});
		Object.defineProperty(types, "isPromise", {
			value() {
				traps++;
				throw new Error("overridden promise predicate");
			},
			configurable: true,
		});
		nativeResult = isRivetAsyncResult(promise);
		proxyResult = isRivetAsyncResult(proxy);
	} finally {
		Object.defineProperty(types, "isProxy", proxyPredicate);
		Object.defineProperty(types, "isPromise", promisePredicate);
	}
	expect(nativeResult).toBe(true);
	expect(proxyResult).toBe(true);
	expect(traps).toBe(0);
});
