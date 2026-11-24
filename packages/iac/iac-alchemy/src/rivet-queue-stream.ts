/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: native promises and stream values are checked at the provider boundary. */
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import {
	type BoundaryPending,
	createBoundaryDeferred,
	observeBoundary,
	raceBoundary,
} from "./async-boundary.js";
import { observeOrdinaryPromise } from "./node-promise-boundary.js";

const isProxy = types.isProxy;
const isUint8Array = types.isUint8Array;
const isSharedArrayBuffer = types.isSharedArrayBuffer;
const apply = Reflect.apply;
const freeze = Object.freeze;
const define = Object.defineProperty;
const create = Object.create;
const hasOwn = Object.hasOwn;
const min = Math.min;
const NativeUint8Array = Uint8Array;
const performanceNow = performance.now;
const monotonicNow = () => apply(performanceNow, performance, []);
const getPrototype = Object.getPrototypeOf;
const descriptor = Object.getOwnPropertyDescriptor;
const typedArrayPrototype = getPrototype(NativeUint8Array.prototype);
const byteLength = descriptor(typedArrayPrototype, "byteLength")?.get;
const backingBuffer = descriptor(typedArrayPrototype, "buffer")?.get;
const typedArraySet = descriptor(typedArrayPrototype, "set")?.value;
const signalAborted = descriptor(AbortSignal.prototype, "aborted")?.get;
const addListener = descriptor(
	EventTarget.prototype,
	"addEventListener",
)?.value;
const removeListener = descriptor(
	EventTarget.prototype,
	"removeEventListener",
)?.value;
const streamPrototype = ReadableStream.prototype;
const defaultReaderPrototype = ReadableStreamDefaultReader.prototype;
const byobReaderPrototype = ReadableStreamBYOBReader.prototype;
const getReader = descriptor(streamPrototype, "getReader")?.value;
const cancelStream = descriptor(streamPrototype, "cancel")?.value;
const defaultRead = descriptor(defaultReaderPrototype, "read")?.value;
const byobRead = descriptor(byobReaderPrototype, "read")?.value;
const defaultCancel = descriptor(defaultReaderPrototype, "cancel")?.value;
const byobCancel = descriptor(byobReaderPrototype, "cancel")?.value;
const defaultRelease = descriptor(defaultReaderPrototype, "releaseLock")?.value;
const byobRelease = descriptor(byobReaderPrototype, "releaseLock")?.value;
const listenerOptions: AddEventListenerOptions = create(null);
listenerOptions.once = true;
freeze(listenerOptions);
const byobOptions: ReadableStreamGetReaderOptions = create(null);
byobOptions.mode = "byob";
freeze(byobOptions);

export interface RivetQueueTimers {
	readonly schedule: typeof setTimeout;
	readonly cancel: typeof clearTimeout;
}
export type RivetQueueTrack = <T>(pending: BoundaryPending<T>) => void;

export function captureRivetQueueTimers(): RivetQueueTimers {
	return freeze({ schedule: setTimeout, cancel: clearTimeout });
}

function isAborted(signal: AbortSignal | undefined): boolean {
	if (signal === undefined) return false;
	try {
		return (
			isProxy(signal) ||
			signalAborted === undefined ||
			apply(signalAborted, signal, []) !== false
		);
	} catch {
		return true;
	}
}

export function rivetQueueObserveNative<T>(
	value: unknown,
	onUninspectable: () => void,
): BoundaryPending<T> {
	const result = createBoundaryDeferred<T>();
	if (
		!observeOrdinaryPromise(
			value,
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the caller validates the value before making a policy decision.
			(observed) => result.resolve(observed as T),
			() => result.reject(undefined),
		)
	)
		onUninspectable();
	return result.promise;
}

export const RIVET_QUEUE_TIMEOUT_MS = 10_000;
export const RIVET_QUEUE_CHUNK_BYTES = 65_536;

export class RivetQueueStreamError extends Error {
	constructor(
		readonly code: "invalid" | "unverified" | "timeout" | "unavailable",
	) {
		super(`queue stream ${code}`);
		this.name = "RivetQueueStreamError";
	}
}

const streamErrors = freeze({
	invalid: freeze(new RivetQueueStreamError("invalid")),
	unverified: freeze(new RivetQueueStreamError("unverified")),
	timeout: freeze(new RivetQueueStreamError("timeout")),
	unavailable: freeze(new RivetQueueStreamError("unavailable")),
});

export function rivetQueueStreamErrorCode(
	value: unknown,
): RivetQueueStreamError["code"] | undefined {
	if (value === streamErrors.invalid) return "invalid";
	if (value === streamErrors.unverified) return "unverified";
	if (value === streamErrors.timeout) return "timeout";
	if (value === streamErrors.unavailable) return "unavailable";
	return undefined;
}

export function cancelRivetQueueStream(
	body: ReadableStream<Uint8Array>,
): Promise<void> {
	if (
		isProxy(body) ||
		getPrototype(body) !== streamPrototype ||
		descriptor(body, "cancel") !== undefined ||
		cancelStream === undefined
	)
		throw streamErrors.invalid;
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the captured native cancellation method returns a Promise<void>.
	return apply(cancelStream, body, []) as Promise<void>;
}

export function boundedRivetQueueDecision(
	decide: () => boolean | Promise<boolean>,
	signal: AbortSignal | undefined,
	trackPending?: RivetQueueTrack,
	timers: RivetQueueTimers = captureRivetQueueTimers(),
	markUncertain?: () => void,
): BoundaryPending<boolean> {
	const output = createBoundaryDeferred<boolean>();
	const decision = createBoundaryDeferred<boolean>();
	const deadline = createBoundaryDeferred<boolean>();
	const expiresAt = monotonicNow() + RIVET_QUEUE_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let expired = false;
	let listening = false;
	let complete = false;
	const uncertain = () => {
		try {
			markUncertain?.();
		} catch {
			return;
		}
	};
	const current = () => {
		try {
			return !expired && !isAborted(signal) && monotonicNow() < expiresAt;
		} catch {
			return false;
		}
	};
	const abort = () => {
		expired = true;
		deadline.reject(undefined);
	};
	const cleanup = () => {
		let failed = false;
		try {
			if (timer !== undefined) apply(timers.cancel, undefined, [timer]);
		} catch {
			failed = true;
		}
		try {
			if (listening && signal !== undefined && removeListener !== undefined)
				apply(removeListener, signal, ["abort", abort]);
		} catch {
			failed = true;
		}
		if (failed) uncertain();
		return !failed;
	};
	observeBoundary(
		raceBoundary(decision.promise, deadline.promise),
		(value) => {
			if (complete) return;
			complete = true;
			const valid = current();
			const cleaned = cleanup();
			if (valid && cleaned) output.resolve(value);
			else output.reject(undefined);
		},
		() => {
			if (complete) return;
			complete = true;
			cleanup();
			output.reject(undefined);
		},
	);
	try {
		if (!current()) throw undefined;
		if (signal !== undefined) {
			if (addListener === undefined) throw undefined;
			apply(addListener, signal, ["abort", abort, listenerOptions]);
			listening = true;
		}
		timer = apply(timers.schedule, undefined, [
			() => {
				expired = true;
				deadline.reject(undefined);
			},
			RIVET_QUEUE_TIMEOUT_MS,
		]);
		if (!current()) throw undefined;
		trackPending?.(decision.promise);
		const start = createBoundaryDeferred<void>();
		observeBoundary(
			start.promise,
			() => {
				if (!current()) {
					decision.reject(undefined);
					return;
				}
				let value: unknown;
				try {
					value = decide();
				} catch {
					decision.reject(undefined);
					return;
				}
				if (typeof value === "boolean") decision.resolve(value);
				else if (
					!observeOrdinaryPromise(
						value,
						(observed) => {
							if (typeof observed === "boolean") decision.resolve(observed);
							else decision.reject(undefined);
						},
						() => decision.reject(undefined),
					)
				) {
					uncertain();
					deadline.reject(undefined);
				}
			},
			() => decision.reject(undefined),
		);
		start.resolve(undefined);
	} catch {
		expired = true;
		decision.reject(undefined);
		deadline.reject(undefined);
	}
	return output.promise;
}

export function readRivetQueueStream(
	body: ReadableStream<Uint8Array> | null,
	maximum: number,
	signal?: AbortSignal,
	verifyDefaultStream?: () => boolean | Promise<boolean>,
	trackPending?: RivetQueueTrack,
	markUncertain?: () => void,
	withinDeadline?: () => boolean,
	timers: RivetQueueTimers = captureRivetQueueTimers(),
): BoundaryPending<Uint8Array> {
	const output = createBoundaryDeferred<Uint8Array>();
	const start = createBoundaryDeferred<void>();
	const uncertain = () => {
		try {
			markUncertain?.();
		} catch {
			return;
		}
	};
	let code: RivetQueueStreamError["code"] = "unavailable";
	const fail: (failure: RivetQueueStreamError["code"]) => never = (failure) => {
		code = failure;
		throw undefined;
	};
	const run = async (): Promise<Uint8Array> => {
		await start.promise;
		if (body === null) return fail("invalid");
		if (
			typeof body !== "object" ||
			isProxy(body) ||
			getPrototype(body) !== streamPrototype ||
			descriptor(body, "getReader") !== undefined ||
			descriptor(body, "cancel") !== undefined ||
			getReader === undefined ||
			cancelStream === undefined ||
			defaultRead === undefined ||
			byobRead === undefined ||
			defaultCancel === undefined ||
			byobCancel === undefined ||
			defaultRelease === undefined ||
			byobRelease === undefined ||
			typedArraySet === undefined
		) {
			uncertain();
			return fail("invalid");
		}
		const deadline = createBoundaryDeferred<never>();
		observeBoundary(
			deadline.promise,
			() => {},
			() => {},
		);
		let reader:
			| ReadableStreamBYOBReader
			| ReadableStreamDefaultReader<Uint8Array>
			| undefined;
		let byob = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let expired = false;
		let listening = false;
		const expiresAt = monotonicNow() + RIVET_QUEUE_TIMEOUT_MS;
		const abort = () => {
			expired = true;
			code = "timeout";
			deadline.reject(undefined);
		};
		const ensureCurrent = () => {
			if (
				expired ||
				isAborted(signal) ||
				monotonicNow() >= expiresAt ||
				withinDeadline?.() === false
			)
				return fail("timeout");
		};
		const track = <T>(pending: BoundaryPending<T>) => {
			try {
				trackPending?.(pending);
			} catch {
				uncertain();
				return fail("unavailable");
			}
		};
		const chunks: Uint8Array[] = [];
		let total = 0;
		let result: Uint8Array | undefined;
		let failed = false;
		try {
			if (isAborted(signal)) fail("unavailable");
			if (signal !== undefined) {
				if (addListener === undefined) fail("unavailable");
				apply(addListener, signal, ["abort", abort, listenerOptions]);
				listening = true;
			}
			timer = apply(timers.schedule, undefined, [
				abort,
				RIVET_QUEUE_TIMEOUT_MS,
			]);
			ensureCurrent();
			try {
				reader = apply(getReader, body, [byobOptions]);
			} catch {
				byob = false;
				ensureCurrent();
				if (verifyDefaultStream === undefined) fail("unverified");
				let verifierThrew = false;
				try {
					const verified = boundedRivetQueueDecision(
						() => {
							try {
								return verifyDefaultStream();
							} catch {
								verifierThrew = true;
								throw undefined;
							}
						},
						signal,
						trackPending,
						timers,
						uncertain,
					);
					if ((await raceBoundary(verified, deadline.promise)).value !== true)
						fail("unverified");
				} catch {
					if (verifierThrew) fail("unverified");
					if (expired || isAborted(signal) || monotonicNow() >= expiresAt)
						fail("timeout");
					fail("unverified");
				}
				ensureCurrent();
				reader = apply(getReader, body, []);
			}
			if (
				reader === undefined ||
				isProxy(reader) ||
				getPrototype(reader) !==
					(byob ? byobReaderPrototype : defaultReaderPrototype) ||
				descriptor(reader, "read") !== undefined ||
				descriptor(reader, "cancel") !== undefined ||
				descriptor(reader, "releaseLock") !== undefined
			)
				fail("invalid");
			while (true) {
				ensureCurrent();
				const limit = min(RIVET_QUEUE_CHUNK_BYTES, maximum - total + 1);
				const reading: unknown = byob
					? apply(byobRead, reader, [new NativeUint8Array(limit)])
					: apply(defaultRead, reader, []);
				let inspectable = true;
				const pending = rivetQueueObserveNative<
					ReadableStreamReadResult<Uint8Array>
				>(reading, () => {
					inspectable = false;
					uncertain();
				});
				track(pending);
				if (!inspectable) fail("unavailable");
				const next = (await raceBoundary(pending, deadline.promise)).value;
				ensureCurrent();
				if (typeof next !== "object" || next === null || isProxy(next))
					fail("invalid");
				const done = descriptor(next, "done");
				const value = descriptor(next, "value");
				if (
					done === undefined ||
					!hasOwn(done, "value") ||
					typeof done.value !== "boolean"
				)
					fail("invalid");
				if (done.value) break;
				if (value === undefined || !hasOwn(value, "value")) fail("invalid");
				const chunk: unknown = value.value;
				if (
					isProxy(chunk) ||
					!isUint8Array(chunk) ||
					byteLength === undefined ||
					backingBuffer === undefined
				)
					fail("invalid");
				if (isSharedArrayBuffer(apply(backingBuffer, chunk, [])))
					fail("invalid");
				const length: number = apply(byteLength, chunk, []);
				if (
					length === 0 ||
					length > RIVET_QUEUE_CHUNK_BYTES ||
					chunks.length >= 4096
				)
					fail("invalid");
				total += length;
				if (total > maximum) fail("invalid");
				const copied = new NativeUint8Array(length);
				apply(typedArraySet, copied, [chunk]);
				const field: PropertyDescriptor = create(null);
				field.value = copied;
				field.writable = true;
				field.enumerable = true;
				field.configurable = true;
				define(chunks, `${chunks.length}`, field);
			}
			result = new NativeUint8Array(total);
			let offset = 0;
			for (let index = 0; index < chunks.length; index++) {
				const chunk = chunks[index];
				if (chunk === undefined || byteLength === undefined) fail("invalid");
				apply(typedArraySet, result, [chunk, offset]);
				offset += apply(byteLength, chunk, []);
			}
			ensureCurrent();
			const field: PropertyDescriptor = create(null);
			field.value = undefined;
			define(result, "then", field);
		} catch {
			failed = true;
			try {
				const cancelled: unknown =
					reader !== undefined &&
					!isProxy(reader) &&
					getPrototype(reader) ===
						(byob ? byobReaderPrototype : defaultReaderPrototype)
						? apply(byob ? byobCancel : defaultCancel, reader, [])
						: apply(cancelStream, body, []);
				const pending = rivetQueueObserveNative<void>(cancelled, uncertain);
				observeBoundary(pending, () => {}, uncertain);
				track(pending);
			} catch {
				uncertain();
			}
		} finally {
			try {
				if (timer !== undefined) apply(timers.cancel, undefined, [timer]);
				if (listening && signal !== undefined && removeListener !== undefined)
					apply(removeListener, signal, ["abort", abort]);
				if (
					reader !== undefined &&
					!isProxy(reader) &&
					getPrototype(reader) ===
						(byob ? byobReaderPrototype : defaultReaderPrototype)
				)
					apply(byob ? byobRelease : defaultRelease, reader, []);
			} catch {
				uncertain();
				code = "unavailable";
				failed = true;
			}
		}
		if (failed || result === undefined) throw undefined;
		return result;
	};
	const work = run();
	if (
		!observeOrdinaryPromise(
			work,
			(value) => {
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: run constructs only a bounded Uint8Array result.
				output.resolve(value as Uint8Array);
			},
			() => output.reject(streamErrors[code]),
		)
	) {
		uncertain();

		if (body !== null) {
			try {
				const cancelled = rivetQueueObserveNative<void>(
					cancelRivetQueueStream(body),
					uncertain,
				);
				observeBoundary(cancelled, () => {}, uncertain);
				trackPending?.(cancelled);
			} catch {
				uncertain();
			}
		}
		output.reject(streamErrors.unavailable);
	} else start.resolve(undefined);
	return output.promise;
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */
