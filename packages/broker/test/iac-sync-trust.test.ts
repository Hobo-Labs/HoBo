/* oxlint-disable unicorn/no-thenable, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: deliberately malformed trust results and receivers exercise the boundary. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("denies rejected native Promise trust results without an unhandled rejection", () => {
	const code = `
import { captureIacUnpricedScopeTrust, captureIacPricedSettlementTrust } from './packages/broker/src/budget-authority.ts';
const failure = () => Promise.reject(new Error('verifier failed'));
const scope = captureIacUnpricedScopeTrust({ verify: failure, isCurrent: failure, settlement: failure });
const priced = captureIacPricedSettlementTrust({ verify: failure });
if (scope.verify({}) !== false || scope.isCurrent({}) !== false || scope.settlement({}) !== false || priced.verify({}) !== false)
  throw new Error('non-boolean verifier result accepted');
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write('handled');
`;
	const output = execFileSync(
		process.execPath,
		[
			"--unhandled-rejections=strict",
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			code,
		],
		{
			cwd: fileURLToPath(new URL("../../../", import.meta.url)),
			timeout: 15_000,
			encoding: "utf8",
		},
	);
	expect(output).toBe("handled");
});

it("does not assimilate a fulfilled verifier result's later then getter", async () => {
	const { captureIacUnpricedScopeTrust } = await import(
		"../src/budget-authority.js"
	);
	const value = {};
	const fulfilled = Promise.resolve(value);
	let traps = 0;
	// biome-ignore lint/suspicious/noThenProperty: the hostile fulfilled value is the regression case.
	Object.defineProperty(value, "then", {
		get() {
			traps++;
			throw new Error("then trap");
		},
	});
	const trust = captureIacUnpricedScopeTrust({
		verify: () => fulfilled,
		isCurrent: () => false,
		settlement: () => false,
	} as never);
	expect(trust?.verify({} as never)).toBe(false);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(traps).toBe(0);
});

it("captures trust callbacks without consulting an overridden bind", async () => {
	const { captureIacUnpricedScopeTrust, captureIacPricedSettlementTrust } =
		await import("../src/budget-authority.js");
	let traps = 0;
	const callback = function (this: object) {
		expect(this).not.toBe(scope);
		expect(Object.isFrozen(this)).toBe(true);
		return false;
	};
	Object.defineProperty(callback, "bind", {
		get() {
			traps++;
			return () => () => true;
		},
	});
	const scope = { verify: callback, isCurrent: callback, settlement: callback };
	const captured = captureIacUnpricedScopeTrust(scope as never);
	expect(captured?.verify({} as never)).toBe(false);
	expect(captured?.isCurrent({} as never)).toBe(false);
	expect(captured?.settlement({} as never)).toBe(false);
	const pricedCallback = function (this: object) {
		expect(this).not.toBe(priced);
		expect(Object.isFrozen(this)).toBe(true);
		return false;
	};
	Object.defineProperty(pricedCallback, "bind", {
		get() {
			traps++;
			return () => () => true;
		},
	});
	const priced = { verify: pricedCallback };
	expect(
		captureIacPricedSettlementTrust(priced as never)?.verify({} as never),
	).toBe(false);
	expect(traps).toBe(0);
});

it("keeps callback-to-callback lookups on the captured immutable receiver", async () => {
	const { captureIacUnpricedScopeTrust } = await import(
		"../src/budget-authority.js"
	);
	const trust = {
		verify() {
			return this.isCurrent();
		},
		isCurrent() {
			return false;
		},
		settlement() {
			return false;
		},
	};
	const captured = captureIacUnpricedScopeTrust(trust as never);
	trust.isCurrent = () => true;
	expect(captured?.verify({} as never)).toBe(false);
	expect(Object.isFrozen(captured)).toBe(true);
});

it("refuses uninspectable thenables and exotic promises without invoking their hooks", async () => {
	const { captureIacUnpricedScopeTrust } = await import(
		"../src/budget-authority.js"
	);
	let traps = 0;
	// biome-ignore lint/suspicious/noThenProperty: this adversarial thenable must not be assimilated.
	const thenable = Object.defineProperty({}, "then", {
		get() {
			traps++;
			throw new Error("trap");
		},
	});
	const proxy = new Proxy(
		{},
		{
			get() {
				traps++;
				throw new Error("trap");
			},
			getPrototypeOf() {
				traps++;
				throw new Error("trap");
			},
		},
	);
	class ForeignSubclass extends Promise<boolean> {}
	const native = Promise.resolve(true);
	Object.defineProperty(native, "constructor", {
		get() {
			traps++;
			throw new Error("trap");
		},
	});
	const foreign = runInNewContext("Promise.resolve(true)");
	for (const value of [
		thenable,
		proxy,
		ForeignSubclass.resolve(true),
		native,
		foreign,
	]) {
		const trust = captureIacUnpricedScopeTrust({
			verify: () => value,
			isCurrent: () => false,
			settlement: () => false,
		} as never);
		expect(trust?.verify({} as never)).toBe(false);
	}
	const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
	if (!original) throw new Error("missing Promise species");
	try {
		Object.defineProperty(Promise, Symbol.species, {
			configurable: true,
			get() {
				traps++;
				throw new Error("trap");
			},
		});
		const trust = captureIacUnpricedScopeTrust({
			verify: () => Promise.resolve(true),
			isCurrent: () => false,
			settlement: () => false,
		} as never);
		expect(trust?.verify({} as never)).toBe(false);
	} finally {
		Object.defineProperty(Promise, Symbol.species, original);
	}
	expect(traps).toBe(0);
});

it.each([
	"species",
	"constructor",
] as const)("rejects a modified Promise %s without inherited descriptor accessors", async (mode) => {
	const { captureIacUnpricedScopeTrust } = await import(
		"../src/budget-authority.js"
	);
	const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
	const constructorField = Object.getOwnPropertyDescriptor(
		Promise.prototype,
		"constructor",
	);
	const originalGet = Object.getOwnPropertyDescriptor(Object.prototype, "get");
	const originalValue = Object.getOwnPropertyDescriptor(
		Object.prototype,
		"value",
	);
	if (!species || !constructorField)
		throw new Error("missing native Promise descriptors");
	let traps = 0;
	const promise = Promise.resolve(true);
	const trust = captureIacUnpricedScopeTrust({
		verify: () => promise,
		isCurrent: () => false,
		settlement: () => false,
	} as never);
	try {
		if (mode === "species")
			Object.defineProperty(Promise, Symbol.species, {
				value: Promise,
				configurable: true,
			});
		else
			Object.defineProperty(Promise.prototype, "constructor", {
				get() {
					traps++;
					throw new Error("constructor trap");
				},
				configurable: true,
			});
		Object.defineProperty(Object.prototype, "get", {
			configurable: true,
			get() {
				traps++;
				throw new Error("descriptor get trap");
			},
		});
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get() {
				traps++;
				throw new Error("descriptor value trap");
			},
		});
		const result = trust?.verify({} as never);
		if (result !== false) throw new Error("nonboolean trust result accepted");
	} finally {
		Reflect.deleteProperty(Object.prototype, "get");
		Reflect.deleteProperty(Object.prototype, "value");
		if (originalGet)
			Object.defineProperty(Object.prototype, "get", originalGet);
		if (originalValue)
			Object.defineProperty(Object.prototype, "value", originalValue);
		Object.defineProperty(Promise, Symbol.species, species);
		Object.defineProperty(Promise.prototype, "constructor", constructorField);
	}
	expect(traps).toBe(0);
});
