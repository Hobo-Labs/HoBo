/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: host promise values cross the checked runtime boundary here. */
import { types } from "node:util";

const isProxy = types.isProxy;
const isPromise = types.isPromise;
const NativePromise = Promise;
const promisePrototype = NativePromise.prototype;
const nativeThen = promisePrototype.then;
const prototype = Object.getPrototypeOf;
const descriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const apply = Reflect.apply;
const speciesSymbol = Symbol.species;
const speciesDescriptor = descriptor(NativePromise, speciesSymbol);
const speciesGetter =
	speciesDescriptor !== undefined && hasOwn(speciesDescriptor, "get")
		? speciesDescriptor.get
		: undefined;

export function observeOrdinaryPromise(
	value: unknown,
	onValue: (value: unknown) => void,
	onError: () => void,
): boolean {
	try {
		if (
			isProxy(value) ||
			!isPromise(value) ||
			prototype(value) !== promisePrototype ||
			descriptor(value, "constructor") !== undefined
		)
			return false;
		const constructorField = descriptor(promisePrototype, "constructor");
		const species = descriptor(NativePromise, speciesSymbol);
		if (
			constructorField === undefined ||
			!hasOwn(constructorField, "value") ||
			constructorField.value !== NativePromise ||
			species === undefined ||
			!hasOwn(species, "get") ||
			speciesGetter === undefined ||
			species.get !== speciesGetter
		)
			return false;
		apply(nativeThen, value, [
			(result: unknown) => {
				try {
					onValue(result);
				} catch {
					try {
						onError();
					} catch {}
				}
			},
			() => {
				try {
					onError();
				} catch {}
			},
		]);
		return true;
	} catch {
		return false;
	}
}
