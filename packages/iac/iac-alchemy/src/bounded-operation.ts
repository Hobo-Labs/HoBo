/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: this internal boundary carries opaque fulfillment values and rejection reasons without interpreting them. */
import { types } from "node:util";

const NativePromise = Promise;
const nativePrototype = NativePromise.prototype;
const nativeThen = nativePrototype.then;
const isPromise = types.isPromise;
const isProxy = types.isProxy;
const getPrototype = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const create = Object.create;
const freeze = Object.freeze;
const hasOwn = Object.hasOwn;
const apply = Reflect.apply;
const deleteProperty = Reflect.deleteProperty;
const schedule = setTimeout;
const cancel = clearTimeout;
const enqueue = queueMicrotask;
const number = Number;

function descriptor(
	value: unknown,
	enumerable = false,
	configurable = false,
	writable = false,
): PropertyDescriptor {
	const result = create(null) as PropertyDescriptor;
	result.value = value;
	result.enumerable = enumerable;
	result.configurable = configurable;
	result.writable = writable;
	return freeze(result);
}
class BoundaryPromise<T> extends NativePromise<T> {}
define(BoundaryPromise, Symbol.species, descriptor(BoundaryPromise));
define(BoundaryPromise.prototype, "then", descriptor(nativeThen));
freeze(BoundaryPromise.prototype);
freeze(BoundaryPromise);
const constructorDescriptor = descriptor(BoundaryPromise, false, true);

export interface BoundedDeadline {
	expired: boolean;
	readonly expiresAt: bigint;
	lastObserved: bigint;
	signalTimeout: (() => void) | undefined;
}

export type BoundedValue<T> = Readonly<{ value: T }>;

function box<T>(value: T): BoundedValue<T> {
	const result = create(null) as { value: T };
	define(result, "value", descriptor(value, true));
	return freeze(result);
}

export function boundedOperation<T>(
	deadline: BoundedDeadline,
	start: () => Promise<T>,
	onTimeout: () => void,
	isExpired: () => boolean,
	timeoutError: () => Error,
): Promise<BoundedValue<T>> {
	return new BoundaryPromise<BoundedValue<T>>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const rejectExpired = (notify: boolean) => {
			if (settled) return;
			settled = true;
			deadline.expired = true;
			try {
				if (timer !== undefined) cancel(timer);
			} catch {
				deadline.expired = true;
			}
			let error: unknown;
			try {
				error = timeoutError();
			} catch (cause) {
				error = cause;
			}
			if (notify) {
				try {
					onTimeout();
				} catch {
					deadline.expired = true;
				}
			}
			reject(error);
		};
		const expire = () => rejectExpired(true);
		deadline.signalTimeout = expire;
		try {
			if (isExpired()) {
				rejectExpired(false);
				return;
			}
			const remaining = number(
				(deadline.expiresAt - deadline.lastObserved + 999_999n) / 1_000_000n,
			);
			timer = schedule(expire, remaining < 1 ? 1 : remaining);
			if (deadline.expired) {
				cancel(timer);
				rejectExpired(false);
				return;
			}
			enqueue(() => {
				try {
					if (isExpired()) {
						rejectExpired(false);
						return;
					}
					let pending: Promise<T>;
					try {
						pending = start();
					} catch (error) {
						if (isExpired()) {
							rejectExpired(false);
							return;
						}
						if (timer !== undefined) cancel(timer);
						settled = true;
						reject(error);
						return;
					}
					if (
						isProxy(pending) ||
						!isPromise(pending) ||
						getPrototype(pending) !== nativePrototype
					) {
						expire();
						return;
					}
					const current = getDescriptor(pending, "constructor");
					if (
						current !== undefined &&
						(!hasOwn(current, "value") ||
							current.value !== NativePromise ||
							!current.configurable)
					) {
						expire();
						return;
					}
					const original =
						current === undefined
							? undefined
							: descriptor(
									current.value,
									current.enumerable,
									current.configurable,
									current.writable,
								);
					define(pending, "constructor", constructorDescriptor);
					try {
						apply(nativeThen, pending, [
							(value: T) => {
								try {
									if (isExpired()) {
										rejectExpired(false);
										return;
									}
									if (timer !== undefined) cancel(timer);
									const result = box(value);
									settled = true;
									resolve(result);
								} catch {
									expire();
								}
							},
							(error: unknown) => {
								try {
									if (isExpired()) {
										rejectExpired(false);
										return;
									}
									if (timer !== undefined) cancel(timer);
									settled = true;
									reject(error);
								} catch {
									expire();
								}
							},
						]);
					} finally {
						if (original === undefined) deleteProperty(pending, "constructor");
						else define(pending, "constructor", original);
					}
				} catch {
					expire();
				}
			});
		} catch {
			expire();
		}
	});
}
/* oxlint-enable anti-slop/no-unknown-parameters */
