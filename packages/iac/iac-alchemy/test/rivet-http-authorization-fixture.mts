// biome-ignore-all lint/suspicious/noThenProperty: the fixture poisons prototype hooks deliberately.
import { createRivetHttpAuthorizationGate } from "../src/rivet-http-authorization.ts";

const get = Object.getOwnPropertyDescriptor;
const put = Object.defineProperty;
const remove = Reflect.deleteProperty;
const apply = Reflect.apply;
const nativeThen = Promise.prototype.then;
const fields: Array<[object, string | symbol, PropertyDescriptor | undefined]> =
	[
		[Promise, "race", get(Promise, "race")],
		[Promise, "resolve", get(Promise, "resolve")],
		[Promise, Symbol.species, get(Promise, Symbol.species)],
		[Promise.prototype, "then", get(Promise.prototype, "then")],
		[Promise.prototype, "constructor", get(Promise.prototype, "constructor")],
		[Object.prototype, "then", get(Object.prototype, "then")],
		[Object, "freeze", get(Object, "freeze")],
		[Object, "create", get(Object, "create")],
		[Object, "defineProperty", get(Object, "defineProperty")],
		[globalThis, "setTimeout", get(globalThis, "setTimeout")],
		[globalThis, "clearTimeout", get(globalThis, "clearTimeout")],
		[WeakSet.prototype, "add", get(WeakSet.prototype, "add")],
		[WeakSet.prototype, "has", get(WeakSet.prototype, "has")],
	];
let traps = 0;
let calls = 0;
const restore = () => {
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (field === undefined) continue;
		if (field[2] === undefined) remove(field[0], field[1]);
		else put(field[0], field[1], field[2]);
	}
};
const fail = () => {
	restore();
	process.stderr.write("authorization failed or returned an unexpected result");
	process.exitCode = 1;
};
setImmediate(() => {
	const gate = createRivetHttpAuthorizationGate(1_000);
	const pending = gate(() => {
		calls++;
		const trap = () => {
			traps++;
			throw new Error("poisoned intrinsic");
		};
		put(Promise, "race", { configurable: true, value: trap });
		put(Promise, "resolve", { configurable: true, value: trap });
		put(Promise, Symbol.species, { configurable: true, get: trap });
		put(Promise.prototype, "then", { configurable: true, value: trap });
		put(Promise.prototype, "constructor", { configurable: true, get: trap });
		put(Object.prototype, "then", { configurable: true, get: trap });
		put(Object, "freeze", { configurable: true, value: trap });
		put(Object, "create", { configurable: true, value: trap });
		put(Object, "defineProperty", { configurable: true, value: trap });
		put(globalThis, "setTimeout", { configurable: true, value: trap });
		put(globalThis, "clearTimeout", { configurable: true, value: trap });
		put(WeakSet.prototype, "add", { configurable: true, value: trap });
		put(WeakSet.prototype, "has", { configurable: true, value: trap });
		return false;
	});
	apply(nativeThen, pending, [
		(box: { value: { status: string } }) => {
			const status = box.value.status;
			restore();
			if (status !== "deny" || calls !== 1 || traps !== 0) {
				process.stderr.write(`status=${status} calls=${calls} traps=${traps}`);
				process.exitCode = 1;
				return;
			}
			process.stdout.write("http-authorization-intrinsics-ok");
		},
		fail,
	]);
});
