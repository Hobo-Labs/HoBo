/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters -- SAFETY: native provider results cross the Worker boundary here. */
const NativePromise = Promise;
const nativePrototype = NativePromise.prototype;
const nativeThen = nativePrototype.then;
const getPrototype = Object.getPrototypeOf;
const descriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const apply = Reflect.apply;
const define = Object.defineProperty;
const remove = Reflect.deleteProperty;
const create = Object.create;
const freeze = Object.freeze;
const species = Symbol.species;
const initialSpecies = descriptor(NativePromise, species);
const speciesGetter =
	initialSpecies !== undefined && hasOwn(initialSpecies, "get")
		? initialSpecies.get
		: undefined;

const pinnedConstructor: PropertyDescriptor = create(null);
pinnedConstructor.value = NativePromise;
pinnedConstructor.writable = false;
pinnedConstructor.enumerable = false;
pinnedConstructor.configurable = true;
freeze(pinnedConstructor);

function hasNativePromisePrototype(value: object): boolean {
	let current: object | null = getPrototype(value);
	for (let depth = 0; current !== null && depth < 32; depth++) {
		if (current === nativePrototype) return true;
		current = getPrototype(current);
	}
	return false;
}

export function observeCloudflareNativePromise<T>(
	value: unknown,
	onValue: (value: T) => void,
	onError: (reason?: unknown) => void,
): boolean {
	try {
		if (
			(typeof value !== "object" && typeof value !== "function") ||
			value === null ||
			!hasNativePromisePrototype(value)
		)
			return false;
		const constructorField = descriptor(nativePrototype, "constructor");
		const speciesField = descriptor(NativePromise, species);
		if (
			constructorField === undefined ||
			!hasOwn(constructorField, "value") ||
			constructorField.value !== NativePromise ||
			speciesField === undefined ||
			!hasOwn(speciesField, "get") ||
			speciesGetter === undefined ||
			speciesField.get !== speciesGetter
		)
			return false;
		const original = descriptor(value, "constructor");
		if (original !== undefined && !hasOwn(original, "value")) return false;
		const direct =
			(original === undefined && getPrototype(value) === nativePrototype) ||
			(original !== undefined && original.value === NativePromise);
		let restore: PropertyDescriptor | undefined;
		if (!direct) {
			if (original !== undefined) {
				if (
					original.configurable !== true ||
					typeof original.writable !== "boolean" ||
					typeof original.enumerable !== "boolean"
				)
					return false;
				restore = create(null) as PropertyDescriptor;
				restore.value = original.value;
				restore.writable = original.writable;
				restore.enumerable = original.enumerable;
				restore.configurable = original.configurable;
				freeze(restore);
			}
			define(value, "constructor", pinnedConstructor);
		}
		let restored = true;
		try {
			apply(nativeThen, value, [
				(result: T) => {
					try {
						onValue(result);
					} catch {
						try {
							onError();
						} catch {}
					}
				},
				(reason: unknown) => {
					try {
						onError(reason);
					} catch {}
				},
			]);
		} finally {
			if (!direct) {
				try {
					if (restore === undefined) restored = remove(value, "constructor");
					else define(value, "constructor", restore);
				} catch {
					restored = false;
				}
			}
		}
		return restored;
	} catch {
		return false;
	}
}
