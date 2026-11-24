/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: promise rejection reasons remain opaque and are never interpreted as authority. */

const NativePromise = Promise;
const nativeThen = Promise.prototype.then;
const nativeResolve = Promise.resolve;
const apply = Reflect.apply;
const freeze = Object.freeze;
const create = Object.create;
const define = Object.defineProperty;
const weakAdd = WeakSet.prototype.add;
const weakHas = WeakSet.prototype.has;
const species = Symbol.species;

class BoundaryPromise<T> extends NativePromise<T> {}
define(BoundaryPromise.prototype, "then", {
	value: nativeThen,
	writable: false,
	configurable: false,
});
define(BoundaryPromise, species, {
	value: BoundaryPromise,
	writable: false,
	configurable: false,
});
define(BoundaryPromise, "resolve", {
	value: nativeResolve,
	writable: false,
	configurable: false,
});
freeze(BoundaryPromise.prototype);
freeze(BoundaryPromise);

export interface BoundaryBox<T> {
	readonly value: T;
}
export type BoundaryPending<T> = Promise<BoundaryBox<T>>;
export interface BoundaryDeferred<T> {
	readonly promise: BoundaryPending<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}
const branded = new WeakSet<object>();

export function createBoundaryDeferred<T>(): BoundaryDeferred<T> {
	let resolve!: (value: BoundaryBox<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new BoundaryPromise<BoundaryBox<T>>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	apply(weakAdd, branded, [promise]);
	freeze(promise);
	return freeze({
		promise,
		resolve(value: T) {
			const box: BoundaryBox<T> = create(null);
			const field: PropertyDescriptor = create(null);
			field.value = value;
			field.enumerable = true;
			define(box, "value", freeze(field));
			resolve(freeze(box));
		},
		reject(reason: unknown) {
			reject(reason);
		},
	});
}

function attachBoundary<T>(
	source: BoundaryPending<T>,
	result: BoundaryDeferred<T>,
): void {
	apply(nativeThen, source, [
		(box: BoundaryBox<T>) => {
			result.resolve(box.value);
		},
		(error: unknown) => {
			result.reject(error);
		},
	]);
}

export function raceBoundary<T>(
	first: BoundaryPending<T>,
	second: BoundaryPending<T>,
): BoundaryPending<T> {
	if (!apply(weakHas, branded, [first]) || !apply(weakHas, branded, [second]))
		throw new TypeError("boundary promises required");
	const result = createBoundaryDeferred<T>();
	attachBoundary(first, result);
	attachBoundary(second, result);
	return result.promise;
}

export function observeBoundary<T>(
	promise: BoundaryPending<T>,
	onValue: (value: T) => void,
	onError: () => void,
): void {
	if (!apply(weakHas, branded, [promise]))
		throw new TypeError("boundary promise required");
	apply(nativeThen, promise, [
		(box: BoundaryBox<T>) => {
			try {
				onValue(box.value);
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
}
