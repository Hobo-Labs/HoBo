import { types as utilTypes } from "node:util";

const isProxy = utilTypes.isProxy;
const isPromise = utilTypes.isPromise;
const apply = Reflect.apply;
const prototype = Object.getPrototypeOf;
const descriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const nativePromise = Promise;
const promisePrototype = Promise.prototype;
const promiseThen = Promise.prototype.then;
const capturedSpecies = descriptor(nativePromise, Symbol.species);
const speciesGetter =
	capturedSpecies !== undefined && hasOwn(capturedSpecies, "get")
		? capturedSpecies.get
		: undefined;

export function synchronousResult<T>(value: T): T {
	if (isProxy(value) || !isPromise(value)) return value;
	try {
		const constructorDescriptor = descriptor(promisePrototype, "constructor");
		const species = descriptor(nativePromise, Symbol.species);
		if (
			prototype(value) !== promisePrototype ||
			descriptor(value, "constructor") !== undefined ||
			constructorDescriptor === undefined ||
			!hasOwn(constructorDescriptor, "value") ||
			constructorDescriptor.value !== nativePromise ||
			species === undefined ||
			!hasOwn(species, "get") ||
			speciesGetter === undefined ||
			species.get !== speciesGetter
		)
			return value;
		void apply(promiseThen, value, [undefined, () => undefined]);
	} catch {}
	return value;
}
