/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: promise rejections and authority results cross a checked host boundary. */
import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import { kvBytes } from "./rivet-kv-protocol.js";
import {
	RIVET_QUEUE_CHUNK_BYTES,
	RIVET_QUEUE_TIMEOUT_MS,
} from "./rivet-queue-stream.js";

const NativeError = Error;
const freeze = Object.freeze;
const isProxy = utilTypes.isProxy;
const apply = Reflect.apply;
export const rivetKvSchedule = setTimeout;
export const rivetKvCancelTimer = clearTimeout;
const NativePromise = Promise;
const promiseThen = NativePromise.prototype.then;
const nativePromisePrototype = NativePromise.prototype;
const getPrototype = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const create = Object.create;
const hasOwn = Object.hasOwn;
const deleteProperty = Reflect.deleteProperty;
const isPromise = utilTypes.isPromise;

export function rivetKvDescriptor(
	value: unknown,
	enumerable = false,
	configurable = false,
	writable = false,
): PropertyDescriptor {
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fresh null-prototype object contains only descriptor data.
	const result = create(null) as PropertyDescriptor;
	result.value = value;
	result.enumerable = enumerable;
	result.configurable = configurable;
	result.writable = writable;
	return freeze(result);
}
export const RIVET_KV_NONTHENABLE = rivetKvDescriptor(undefined);
// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this null-prototype options object is private and frozen before callbacks.
const listenerOptions = create(null) as AddEventListenerOptions;
listenerOptions.once = true;
export const RIVET_KV_ONCE = freeze(listenerOptions);
class RivetKvPromise<T> extends NativePromise<T> {}
defineProperty(
	RivetKvPromise,
	Symbol.species,
	rivetKvDescriptor(RivetKvPromise),
);
defineProperty(
	RivetKvPromise.prototype,
	"then",
	rivetKvDescriptor(promiseThen),
);
freeze(RivetKvPromise.prototype);
freeze(RivetKvPromise);
const privateConstructor = rivetKvDescriptor(RivetKvPromise, false, true);
const NativeUint8Array = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(NativeUint8Array.prototype);
const typedArrayLength = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get;
const typedArraySet = typedArrayPrototype.set;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const finite = Number.isFinite;
const ceil = Math.ceil;
const min = Math.min;
const now = performance.now;
const signalAborted = Object.getOwnPropertyDescriptor(
	AbortSignal.prototype,
	"aborted",
)?.get;
const streamLocked = Object.getOwnPropertyDescriptor(
	ReadableStream.prototype,
	"locked",
)?.get;
const streamReader = ReadableStream.prototype.getReader;
const streamCancel = ReadableStream.prototype.cancel;
const defaultRead = ReadableStreamDefaultReader.prototype.read;
const defaultCancel = ReadableStreamDefaultReader.prototype.cancel;
const defaultRelease = ReadableStreamDefaultReader.prototype.releaseLock;
const byobRead = ReadableStreamBYOBReader.prototype.read;
const byobCancel = ReadableStreamBYOBReader.prototype.cancel;
const byobRelease = ReadableStreamBYOBReader.prototype.releaseLock;

export function rivetKvPromise<T>(
	executor: (
		resolve: (value: T | PromiseLike<T>) => void,
		reject: (reason?: unknown) => void,
	) => void,
): Promise<T> {
	return new RivetKvPromise<T>(executor);
}

export function rivetKvObserve<T>(
	pending: Promise<T>,
	onFulfilled: (value: T) => void,
	onRejected: (reason: unknown) => void,
): void {
	if (isProxy(pending) || !isPromise(pending))
		throw new NativeError("invalid promise");
	const prototype = getPrototype(pending);
	if (prototype === RivetKvPromise.prototype) {
		if (getDescriptor(pending, "constructor") !== undefined)
			throw new NativeError("invalid promise constructor");
		void apply(promiseThen, pending, [onFulfilled, onRejected]);
		return;
	}
	if (prototype !== nativePromisePrototype)
		throw new NativeError("invalid promise");
	const current = getDescriptor(pending, "constructor");
	if (
		current !== undefined &&
		(!hasOwn(current, "value") ||
			current.value !== NativePromise ||
			!current.configurable)
	)
		throw new NativeError("invalid promise constructor");
	const original =
		current === undefined
			? undefined
			: rivetKvDescriptor(
					current.value,
					current.enumerable,
					current.configurable,
					current.writable,
				);
	defineProperty(pending, "constructor", privateConstructor);
	let restored = true;
	try {
		void apply(promiseThen, pending, [onFulfilled, onRejected]);
	} finally {
		if (original === undefined) {
			restored = deleteProperty(pending, "constructor");
		} else defineProperty(pending, "constructor", original);
	}
	if (!restored)
		throw new NativeError("promise constructor could not be restored");
}

export type RivetKvBox<T> = Readonly<{ value: T }>;

function box<T>(value: T): RivetKvBox<T> {
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the value is defined on a fresh null-prototype record.
	const result = create(null) as { value: T };
	defineProperty(result, "value", rivetKvDescriptor(value, true));
	return freeze(result);
}

export function rivetKvNative<T>(pending: Promise<T>): Promise<RivetKvBox<T>> {
	let resolveBox: (value: RivetKvBox<T>) => void = () => {};
	let rejectBox: (reason: unknown) => void = () => {};
	const result = rivetKvPromise<RivetKvBox<T>>((resolve, reject) => {
		resolveBox = resolve;
		rejectBox = reject;
	});
	rivetKvObserve(
		pending,
		(value) => {
			try {
				resolveBox(box(value));
			} catch (error) {
				rejectBox(error);
			}
		},
		rejectBox,
	);
	return result;
}

export function rivetKvRace<T>(
	first: Promise<T>,
	second: Promise<T>,
): Promise<Readonly<{ value: T }>> {
	return rivetKvPromise<Readonly<{ value: T }>>((resolve, reject) => {
		const complete = (value: T) => {
			try {
				resolve(box(value));
			} catch (error) {
				reject(error);
			}
		};
		rivetKvObserve(first, complete, reject);
		rivetKvObserve(second, complete, reject);
	});
}

function never(): Promise<never> {
	return rivetKvPromise<never>(() => {});
}

export async function boundedRivetKvDecision(
	decide: () => boolean | Promise<boolean>,
	signal: AbortSignal,
	deadline: ReturnType<typeof rivetKvDeadline>,
	trackPending: (pending: Promise<boolean>) => Promise<boolean>,
): Promise<boolean> {
	if (deadline.expired()) throw new NativeError("request expired");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectTimeout: (reason: Error) => void = () => {};
	const timeout = rivetKvPromise<never>((_, reject) => {
		rejectTimeout = reject;
	});
	rivetKvObserve(
		timeout,
		() => {},
		() => {},
	);
	const abort = () => {
		deadline.expire();
		rejectTimeout(new NativeError("request expired"));
	};
	let listening = false;
	try {
		apply(addListener, signal, ["abort", abort, RIVET_KV_ONCE]);
		listening = true;
		timer = rivetKvSchedule(abort, RIVET_QUEUE_TIMEOUT_MS);
		if (deadline.expired()) throw new NativeError("request expired");
		const ready = rivetKvPromise<void>((resolve) => resolve());
		const pending = rivetKvPromise<boolean>((resolve, reject) => {
			rivetKvObserve(
				ready,
				() => {
					try {
						if (deadline.expired()) throw new NativeError("request expired");
						const value = decide();
						if (typeof value === "boolean") resolve(value);
						else {
							let observed = false;
							try {
								rivetKvObserve(
									value,
									(decision) => {
										if (!observed) return;
										if (typeof decision === "boolean") resolve(decision);
										else reject(new NativeError("invalid decision"));
									},
									(error) => {
										if (observed) reject(error);
									},
								);
								observed = true;
							} catch {
								deadline.expire();
								rejectTimeout(new NativeError("unobservable authority"));
							}
						}
					} catch (error) {
						reject(error);
					}
				},
				reject,
			);
		});

		rivetKvObserve(
			pending,
			() => {},
			() => {},
		);
		return (await rivetKvRace(trackPending(pending), timeout)).value;
	} catch (error) {
		deadline.expire();
		throw error;
	} finally {
		if (timer !== undefined) rivetKvCancelTimer(timer);
		if (listening) apply(removeListener, signal, ["abort", abort]);
	}
}

export function rivetKvDeadline(signal?: AbortSignal) {
	const start = apply(now, performance, []);
	let previous = start;
	let lapsed = !finite(start);
	const sample = (): number => {
		const current = apply(now, performance, []);
		let aborted = signal !== undefined;
		if (
			signal !== undefined &&
			!isProxy(signal) &&
			signalAborted !== undefined
		) {
			try {
				aborted = apply(signalAborted, signal, []) !== false;
			} catch {
				aborted = true;
			}
		}
		lapsed ||=
			aborted ||
			!finite(current) ||
			current < previous ||
			current - start >= RIVET_QUEUE_TIMEOUT_MS;
		previous = current;
		return current;
	};
	return freeze({
		expire(): void {
			lapsed = true;
		},
		expired(): boolean {
			sample();
			return lapsed;
		},
		remainingMs(): number {
			const current = sample();
			return lapsed ? 0 : ceil(RIVET_QUEUE_TIMEOUT_MS - (current - start));
		},
	});
}

export async function retireRivetKvStream(
	body: ReadableStream<Uint8Array> | null,
): Promise<void> {
	if (body === null) return;
	if (isProxy(body)) {
		await never();
		return;
	}
	try {
		await rivetKvNative(apply(streamCancel, body, []));
	} catch {
		await never();
	}
}

export async function readRivetKvStream(
	body: ReadableStream<Uint8Array> | null,
	maximum: number,
	signal: AbortSignal,
	deadline: ReturnType<typeof rivetKvDeadline>,
): Promise<Uint8Array> {
	if (body === null) throw new NativeError("unavailable");
	if (isProxy(body) || streamLocked === undefined) {
		await rivetKvNative(retireRivetKvStream(body));
		throw new NativeError("unavailable");
	}

	try {
		apply(streamLocked, body, []);
	} catch {
		await rivetKvNative(retireRivetKvStream(body));
		throw new NativeError("unavailable");
	}
	if (deadline.expired()) {
		await rivetKvNative(retireRivetKvStream(body));
		throw new NativeError("unavailable");
	}
	let reader:
		| ReadableStreamBYOBReader
		| ReadableStreamDefaultReader<Uint8Array>
		| undefined;
	let byob = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectTimeout: (error: Error) => void = () => {};
	const timedOut = rivetKvPromise<never>((_, reject) => {
		rejectTimeout = reject;
	});

	rivetKvObserve(
		timedOut,
		() => {},
		() => {},
	);
	const abort = () => rejectTimeout(new NativeError("unavailable"));
	let listening = false;
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		try {
			apply(addListener, signal, ["abort", abort, RIVET_KV_ONCE]);
			listening = true;
			if (deadline.expired()) throw new NativeError("unavailable");

			timer = rivetKvSchedule(() => {
				deadline.expire();
				abort();
			}, deadline.remainingMs());
			if (deadline.expired()) throw new NativeError("unavailable");
		} catch (error) {
			deadline.expire();
			throw error;
		}
		try {
			reader = apply(streamReader, body, [{ mode: "byob" }]);
		} catch {
			byob = false;
			reader = apply(streamReader, body, []);
		}
		while (true) {
			if (deadline.expired()) throw new NativeError("unavailable");
			const limit = min(RIVET_QUEUE_CHUNK_BYTES, maximum - total + 1);
			const { value: next } = await rivetKvRace(
				byob
					? apply(byobRead, reader, [new NativeUint8Array(limit)])
					: apply(defaultRead, reader, []),
				timedOut,
			);
			if (deadline.expired() || isProxy(next))
				throw new NativeError("unavailable");
			if (next.done) break;
			const copy = kvBytes(next.value, RIVET_QUEUE_CHUNK_BYTES);
			if (
				copy === undefined ||
				typedArrayLength === undefined ||
				chunks.length >= 4096
			)
				throw new NativeError("invalid chunk");
			const length: number = apply(typedArrayLength, copy, []);
			if (length === 0) throw new NativeError("invalid chunk");
			total += length;
			if (total > maximum) throw new NativeError("invalid length");
			chunks[chunks.length] = copy;
		}
		const bytes = new NativeUint8Array(total);
		let offset = 0;
		for (let index = 0; index < chunks.length; index++) {
			const chunk = chunks[index];
			if (chunk === undefined || typedArrayLength === undefined)
				throw new NativeError("invalid chunk");
			apply(typedArraySet, bytes, [chunk, offset]);
			offset += apply(typedArrayLength, chunk, []);
		}
		if (deadline.expired()) throw new NativeError("unavailable");
		defineProperty(bytes, "then", RIVET_KV_NONTHENABLE);
		return bytes;
	} catch (error) {
		try {
			if (reader !== undefined)
				await rivetKvNative(
					apply(byob ? byobCancel : defaultCancel, reader, []),
				);
			else await rivetKvNative(apply(streamCancel, body, []));
		} catch {
			await never();
		}
		throw error;
	} finally {
		let cleanupFailed = false;
		try {
			if (timer !== undefined) rivetKvCancelTimer(timer);
		} catch {
			cleanupFailed = true;
		}
		try {
			if (listening) apply(removeListener, signal, ["abort", abort]);
		} catch {
			cleanupFailed = true;
		}
		try {
			if (reader !== undefined)
				apply(byob ? byobRelease : defaultRelease, reader, []);
		} catch {
			cleanupFailed = true;
		}
		if (cleanupFailed) await never();
	}
}
