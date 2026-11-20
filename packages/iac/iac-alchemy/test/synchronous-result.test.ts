/* oxlint-disable unicorn/no-thenable -- SAFETY: the tests deliberately construct hostile thenables. */
import { describe, expect, it } from "vitest";
import {
	acceptSynchronousTrue,
	observeUnexpectedSynchronousResult,
} from "../src/synchronous-result.js";

describe("synchronous authority results", () => {
	it("does not inspect or forward a fulfilled native Promise's value", async () => {
		const value = {};
		const fulfilled = Promise.resolve(value);
		let traps = 0;
		// biome-ignore lint/suspicious/noThenProperty: deliberately hostile fulfilled value.
		Object.defineProperty(value, "then", {
			get() {
				traps++;
				throw new Error("then getter");
			},
		});
		expect(acceptSynchronousTrue(fulfilled)).toBe(false);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(traps).toBe(0);
	});

	it("does not read inherited descriptor getters during native Promise observation", async () => {
		const rejected = Promise.reject(new Error("host verifier failed"));
		const previousGet = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"get",
		);
		const previousValue = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"value",
		);
		let traps = 0;
		let accepted = true;
		try {
			Object.defineProperty(Object.prototype, "get", {
				configurable: true,
				get() {
					traps++;
					throw new Error("inherited get");
				},
			});
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					traps++;
					throw new Error("inherited value");
				},
			});
			accepted = acceptSynchronousTrue(rejected);
		} finally {
			if (previousValue === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", previousValue);
			if (previousGet === undefined)
				Reflect.deleteProperty(Object.prototype, "get");
			else Object.defineProperty(Object.prototype, "get", previousGet);
		}
		expect(accepted).toBe(false);
		expect(traps).toBe(0);
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("refuses and observes a rejected native promise, using the captured intrinsic", async () => {
		const rejected = Promise.reject(new Error("host verifier failed"));
		const original = Reflect.apply;
		let traps = 0;
		let accepted = true;
		Reflect.apply = () => {
			traps++;
			throw new Error("replaced");
		};
		try {
			accepted = acceptSynchronousTrue(rejected);
		} finally {
			Reflect.apply = original;
		}
		expect(accepted).toBe(false);
		expect(traps).toBe(0);
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("never reads arbitrary thenables, proxies, subclasses, or constructor accessors", async () => {
		let traps = 0;
		const hostile = new Proxy(
			{},
			{
				get() {
					traps++;
					throw new Error("get");
				},
			},
		);
		class Subclass extends Promise<boolean> {
			static get [Symbol.species]() {
				traps++;
				throw new Error("species");
			}
		}
		const subclass = new Subclass((resolve) => resolve(false));
		const native = Promise.reject(new Error("already handled by host"));
		const handled = native.catch(() => undefined);
		Object.defineProperty(native, "constructor", {
			get() {
				traps++;
				throw new Error("constructor");
			},
		});
		for (const value of [hostile, subclass, native])
			observeUnexpectedSynchronousResult(value);
		await handled;
		expect(traps).toBe(0);
	});
});
