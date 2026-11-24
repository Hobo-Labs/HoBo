// biome-ignore-all lint/suspicious/noThenProperty: This isolated process intentionally tests hostile thenable inheritance.
/* oxlint-disable unicorn/no-thenable -- SAFETY: the isolated fixture deliberately poisons and restores then. */
import { strict as assert } from "node:assert";
import {
	boundedRivetKvDecision,
	rivetKvDeadline,
	rivetKvNative,
	rivetKvRace,
} from "../src/rivet-kv-boundary.ts";

const object = { id: "expected" };
const response = new Response("expected");
const first = Promise.resolve(object);
const second = Promise.resolve(response);
const never = new Promise(() => {});
const originalThen = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
const originalConstructor = Object.getOwnPropertyDescriptor(
	Promise.prototype,
	"constructor",
);
const originalSpecies = Object.getOwnPropertyDescriptor(
	Promise,
	Symbol.species,
);
const originalObjectThen = Object.getOwnPropertyDescriptor(
	Object.prototype,
	"then",
);
const descriptorFields = [
	"get",
	"set",
	"value",
	"writable",
	"enumerable",
	"configurable",
	"capture",
	"passive",
	"signal",
];
const originalDescriptorFields = descriptorFields.map((field) => [
	field,
	Object.getOwnPropertyDescriptor(Object.prototype, field),
]);
const descriptorPoison = Object.create(null);
descriptorPoison.configurable = true;
const originalRace = Promise.race;
const originalError = Object.getOwnPropertyDescriptor(globalThis, "Error");
const NativeError = Error;
const controller = new AbortController();
const expired = rivetKvDeadline(controller.signal);
expired.expire();
const active = rivetKvDeadline(controller.signal);
let traps = 0;
const poison = () => {
	traps++;
	throw new NativeError("poisoned intrinsic");
};
descriptorPoison.get = poison;
Object.freeze(descriptorPoison);
const restore = () => {
	for (const [field] of originalDescriptorFields)
		Reflect.deleteProperty(Object.prototype, field);
	for (const [field, previous] of originalDescriptorFields)
		if (previous) Object.defineProperty(Object.prototype, field, previous);
	Object.defineProperty(Promise.prototype, "then", originalThen);
	Object.defineProperty(Promise.prototype, "constructor", originalConstructor);
	Object.defineProperty(Promise, Symbol.species, originalSpecies);
	if (originalObjectThen)
		Object.defineProperty(Object.prototype, "then", originalObjectThen);
	else Reflect.deleteProperty(Object.prototype, "then");
	Promise.race = originalRace;
	Object.defineProperty(globalThis, "Error", originalError);
};
setImmediate(() => {
	const watchdog = setTimeout(() => {
		restore();
		process.stderr.write("isolated race did not settle\n");
		process.exitCode = 1;
	}, 2000);
	Object.defineProperty(Promise.prototype, "then", {
		configurable: true,
		get: poison,
	});
	Object.defineProperty(Promise.prototype, "constructor", {
		configurable: true,
		get: poison,
	});
	Object.defineProperty(Promise, Symbol.species, {
		configurable: true,
		get: poison,
	});
	Object.defineProperty(Object.prototype, "then", {
		configurable: true,
		get: poison,
	});
	Object.defineProperty(globalThis, "Error", {
		configurable: true,
		get: poison,
	});
	Promise.race = poison;
	for (const field of descriptorFields)
		Object.defineProperty(Object.prototype, field, descriptorPoison);
	void (async () => {
		try {
			const objectBox = await rivetKvRace(first, never);
			const responseBox = await rivetKvRace(second, never);
			const directBox = await rivetKvNative(first);
			const { value: decision } = await rivetKvNative(
				boundedRivetKvDecision(
					() => true,
					controller.signal,
					active,
					(pending) => pending,
				),
			);
			let rejected;
			try {
				await rivetKvNative(
					boundedRivetKvDecision(
						() => true,
						controller.signal,
						expired,
						(pending) => pending,
					),
				);
			} catch (error) {
				rejected = error;
			}
			restore();
			clearTimeout(watchdog);
			assert.equal(traps, 0);
			assert.equal(objectBox.value, object);
			assert.equal(responseBox.value, response);
			assert.equal(directBox.value, object);
			assert.equal(Object.getPrototypeOf(directBox), null);
			assert.equal(Object.isFrozen(directBox), true);
			assert.equal(Object.hasOwn(first, "constructor"), false);
			assert.equal(Object.getPrototypeOf(objectBox), null);
			assert.equal(Object.getPrototypeOf(responseBox), null);
			assert.equal(Object.isFrozen(objectBox), true);
			assert.equal(Object.isFrozen(responseBox), true);
			assert.equal(decision, true);
			assert.equal(rejected instanceof NativeError, true);
			assert.equal(rejected.message, "request expired");
		} catch (error) {
			restore();
			clearTimeout(watchdog);
			process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
			process.exitCode = 1;
		}
	})();
});
