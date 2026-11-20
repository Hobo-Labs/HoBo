import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(
	new URL("../src/bounded-operation.ts", import.meta.url),
	"utf8",
);
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.ESNext,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText;
const { boundedOperation } = await import(
	`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const NativePromise = Promise;
const define = Object.defineProperty;
const getDescriptor = Object.getOwnPropertyDescriptor;
const deleteProperty = Reflect.deleteProperty;
const create = Object.create;
const prototype = Object.prototype;
const promisePrototype = NativePromise.prototype;
const original = {
	thenDescriptor: getDescriptor(promisePrototype, "then"),
	constructor: getDescriptor(promisePrototype, "constructor"),
	species: getDescriptor(NativePromise, Symbol.species),
	resolve: getDescriptor(NativePromise, "resolve"),
	race: getDescriptor(NativePromise, "race"),
	globalPromise: globalThis.Promise,
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
	queueMicrotask: globalThis.queueMicrotask,
	number: globalThis.Number,
	max: Math.max,
};
const fields = [
	"get",
	"set",
	"value",
	"writable",
	"enumerable",
	"configurable",
	"then",
];
const prior = fields.map((field) => [field, getDescriptor(prototype, field)]);
const receipt = { id: "exact receipt" };
const completed = NativePromise.resolve(receipt);
let release;
const delayed = new NativePromise((resolve) => {
	release = resolve;
});
const timeout = new Error("deadline");
const deadline = (milliseconds) => ({
	expired: false,
	expiresAt: BigInt(milliseconds) * 1_000_000n,
	lastObserved: 0n,
	signalTimeout: undefined,
});
const firstDeadline = deadline(1000);
const secondDeadline = deadline(20);
let timers = 0;
let traps = 0;
let first;
let caught;
let failed;
let fieldRead = "";

function property(value) {
	const entry = create(null);
	entry.value = value;
	entry.configurable = true;
	return entry;
}
function poison() {
	traps++;
	throw timeout;
}

try {
	for (const field of fields) {
		const entry = create(null);
		entry.get = () => {
			fieldRead = field;
			return poison();
		};
		entry.configurable = true;
		define(prototype, field, entry);
	}
	define(promisePrototype, "then", property(poison));
	define(promisePrototype, "constructor", property(poison));
	define(NativePromise, Symbol.species, property(poison));
	define(NativePromise, "resolve", property(poison));
	define(NativePromise, "race", property(poison));
	globalThis.Promise = poison;
	globalThis.setTimeout = poison;
	globalThis.clearTimeout = poison;
	globalThis.queueMicrotask = poison;
	globalThis.Number = poison;
	Math.max = poison;

	first = await boundedOperation(
		firstDeadline,
		() => completed,
		poison,
		() => firstDeadline.expired,
		() => timeout,
	);
	try {
		await boundedOperation(
			secondDeadline,
			() => delayed,
			() => {
				timers++;
			},
			() => secondDeadline.expired,
			() => timeout,
		);
	} catch (error) {
		caught = error;
	}
} catch (error) {
	failed = error;
} finally {
	for (const [field, entry] of prior) {
		if (entry === undefined) deleteProperty(prototype, field);
		else define(prototype, field, entry);
	}
	define(promisePrototype, "then", original.thenDescriptor);
	define(promisePrototype, "constructor", original.constructor);
	define(NativePromise, Symbol.species, original.species);
	define(NativePromise, "resolve", original.resolve);
	define(NativePromise, "race", original.race);
	globalThis.Promise = original.globalPromise;
	globalThis.setTimeout = original.setTimeout;
	globalThis.clearTimeout = original.clearTimeout;
	globalThis.queueMicrotask = original.queueMicrotask;
	globalThis.Number = original.number;
	Math.max = original.max;
}
if (failed)
	throw new Error(`poisoned operation failed at ${fieldRead}`, {
		cause: failed,
	});
assert.equal(Object.getPrototypeOf(first), null);
assert.equal(first.value, receipt);
assert.equal(Object.isFrozen(first), true);
assert.equal(caught, timeout);
assert.equal(secondDeadline.expired, true);
assert.equal(timers, 1);
assert.equal(traps, 0);
release("late");
