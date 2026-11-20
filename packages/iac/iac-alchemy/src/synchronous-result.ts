import { types } from "node:util";

const isProxy = types.isProxy;
const isPromise = types.isPromise;
const apply = Reflect.apply;
const prototypeOf = Object.getPrototypeOf;
const descriptorOf = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const nativePromise = Promise;
const promisePrototype = nativePromise.prototype;
const nativeThen = promisePrototype.then;
const speciesDescriptor = descriptorOf(nativePromise, Symbol.species);
const nativeSpecies =
	speciesDescriptor !== undefined && hasOwn(speciesDescriptor, "get")
		? speciesDescriptor.get
		: undefined;
const ignoreRejection = () => undefined;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: the result is an untrusted host value and is inspected without reading user-controlled thenables. */
export function observeUnexpectedSynchronousResult(value: unknown): void {
	try {
		if (
			isProxy(value) ||
			!isPromise(value) ||
			prototypeOf(value) !== promisePrototype ||
			descriptorOf(value, "constructor") !== undefined
		)
			return;

		const constructorDescriptor = descriptorOf(promisePrototype, "constructor");
		const species = descriptorOf(nativePromise, Symbol.species);
		if (
			constructorDescriptor === undefined ||
			!hasOwn(constructorDescriptor, "value") ||
			constructorDescriptor.value !== nativePromise ||
			species === undefined ||
			!hasOwn(species, "get") ||
			nativeSpecies === undefined ||
			species.get !== nativeSpecies
		)
			return;
		apply(nativeThen, value, [ignoreRejection, ignoreRejection]);
	} catch {}
}

export function acceptSynchronousTrue(value: unknown): boolean {
	if (value === true) return true;
	observeUnexpectedSynchronousResult(value);
	return false;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */
