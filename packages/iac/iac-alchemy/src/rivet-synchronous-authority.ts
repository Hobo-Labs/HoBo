import { types } from "node:util";

/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: this boundary classifies actual JavaScript callback results before accepting them. */

const applyCaptured = Reflect.apply;
const getPrototypeCaptured = Object.getPrototypeOf;
const getOwnDescriptorCaptured = Object.getOwnPropertyDescriptor;
const isProxyCaptured = types.isProxy;
const isPromiseCaptured = types.isPromise;
const promiseCaptured = Promise;
const promisePrototypeCaptured = Promise.prototype;
const promiseThenCaptured = Promise.prototype.then;
const promiseSpeciesDescriptor = getOwnDescriptorCaptured(
	Promise,
	Symbol.species,
);
const promiseSpeciesCaptured =
	promiseSpeciesDescriptor === undefined
		? undefined
		: getOwnDescriptorCaptured(promiseSpeciesDescriptor, "get")?.value;

export function isRivetAsyncResult(value: unknown): boolean {
	if (isProxyCaptured(value)) return true;
	if (!isPromiseCaptured(value)) return false;
	try {
		const nativeConstructor = getOwnDescriptorCaptured(
			promisePrototypeCaptured,
			"constructor",
		);
		const species = getOwnDescriptorCaptured(promiseCaptured, Symbol.species);
		const constructorValue =
			nativeConstructor === undefined
				? undefined
				: getOwnDescriptorCaptured(nativeConstructor, "value")?.value;
		const speciesGetter =
			species === undefined
				? undefined
				: getOwnDescriptorCaptured(species, "get")?.value;
		if (
			getPrototypeCaptured(value) !== promisePrototypeCaptured ||
			getOwnDescriptorCaptured(value, "constructor") !== undefined ||
			constructorValue !== promiseCaptured ||
			promiseSpeciesCaptured === undefined ||
			speciesGetter !== promiseSpeciesCaptured
		)
			return true;
		void applyCaptured(promiseThenCaptured, value, [
			() => undefined,
			() => undefined,
		]);
	} catch {}
	return true;
}

export function isRivetSynchronousTrue(value: unknown): boolean {
	return !isRivetAsyncResult(value) && value === true;
}
