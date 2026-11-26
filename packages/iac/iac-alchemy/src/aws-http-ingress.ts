import { createBoundaryDeferred, raceBoundary } from "./async-boundary.js";
import type { AwsHttpSource } from "./aws-http-source.js";
import { observeOrdinaryPromise } from "./node-promise-boundary.js";

export const AWS_HTTP_MAX_REQUEST_BYTES = 1_048_576;
export const AWS_HTTP_MAX_REQUEST_CHUNKS = 1024;
export const AWS_HTTP_MAX_INGRESS = 32;
export const AWS_HTTP_INGRESS_DEADLINE_MS = 10_000;
const NativeRequest = Request;
const NativeResponse = Response;
const NativeUint8Array = Uint8Array;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;
const byteSet = Uint8Array.prototype.set;
const arrayPush = Array.prototype.push;
const apply = Reflect.apply;
const define = Object.defineProperty;
const schedule = setTimeout;
const clear = clearTimeout;
const NativePromise = Promise;
const nativeThen = Promise.prototype.then;
const freeze = Object.freeze;
class IngressPromise extends NativePromise<Response> {}
define(IngressPromise.prototype, "then", {
	value: nativeThen,
	configurable: false,
	writable: false,
});
define(IngressPromise, Symbol.species, {
	value: IngressPromise,
	configurable: false,
	writable: false,
});
freeze(IngressPromise.prototype);
freeze(IngressPromise);
interface IngressClock {
	schedule(callback: () => void, delay: number): () => void;
}
const clock: IngressClock = Object.freeze({
	schedule(callback: () => void, delay: number) {
		const timer = schedule(callback, delay);
		return () => clear(timer);
	},
});

const responseStatus = Object.getOwnPropertyDescriptor(
	NativeResponse.prototype,
	"status",
)?.get;
function fallback(status: number): Response {
	const response = new NativeResponse(null, { status });
	define(response, "then", { value: undefined });
	return freeze(response);
}
const badRequest = fallback(400);
const tooLarge = fallback(413);
const expired = fallback(408);
const unavailable = fallback(503);
function error(status: number): Response {
	const backup =
		status === 413
			? tooLarge
			: status === 408
				? expired
				: status === 400
					? badRequest
					: unavailable;
	try {
		const result = new NativeResponse(null, { status });
		if (!responseStatus || apply(responseStatus, result, []) !== status)
			return backup;
		define(result, "then", { value: undefined });
		return result;
	} catch {
		return backup;
	}
}

export function createAwsIngressHandler(
	source: AwsHttpSource,
	timerClock: IngressClock = clock,
): (request: Request) => Promise<Response> {
	let inFlight = 0;
	const execute = async (request: Request): Promise<Response> => {
		if (inFlight >= AWS_HTTP_MAX_INGRESS) return error(503);
		inFlight++;
		let timedOut = false;
		let dispatched = false;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let cancellation: Promise<void> | undefined;
		let cancelTimer: (() => void) | undefined;
		const completion = createBoundaryDeferred<Response>();
		const timeout = createBoundaryDeferred<Response>();
		const work = (async (): Promise<Response> => {
			try {
				const declared = request.headers.get("content-length");
				if (declared !== null && !/^(0|[1-9][0-9]*)$/u.test(declared))
					return error(400);
				if (
					declared !== null &&
					(declared.length > 10 ||
						Number(declared) > AWS_HTTP_MAX_REQUEST_BYTES)
				)
					return error(413);
				if (request.body === null) {
					if (declared !== null && Number(declared) !== 0) return error(400);
					dispatched = true;
					return await source.fetch(request);
				}
				reader = request.body.getReader();
				const chunks: Uint8Array[] = [];
				let length = 0;
				for (;;) {
					const item = await reader.read();
					if (timedOut) return error(408);
					if (item.done) break;
					if (!typedArrayByteLength) return error(400);
					const chunkLength: number = apply(
						typedArrayByteLength,
						item.value,
						[],
					);
					length += chunkLength;
					if (
						chunks.length >= AWS_HTTP_MAX_REQUEST_CHUNKS ||
						length > AWS_HTTP_MAX_REQUEST_BYTES
					)
						return error(413);
					const copied = new NativeUint8Array(chunkLength);
					apply(byteSet, copied, [item.value]);
					apply(arrayPush, chunks, [copied]);
				}
				if (declared !== null && Number(declared) !== length) return error(400);
				const bytes = new NativeUint8Array(length);
				let offset = 0;
				for (let index = 0; index < chunks.length; index++) {
					const chunk = chunks[index];
					if (!chunk || !typedArrayByteLength) return error(400);
					apply(byteSet, bytes, [chunk, offset]);
					offset += apply(typedArrayByteLength, chunk, []);
				}
				if (timedOut) return error(408);
				const bounded = new NativeRequest(request.url, {
					method: request.method,
					headers: request.headers,
					body: bytes,
					signal: request.signal,
				});
				dispatched = true;
				return await source.fetch(bounded);
			} catch {
				return error(timedOut ? 408 : dispatched ? 503 : 400);
			} finally {
				if (reader) {
					try {
						cancellation ??= reader.cancel();
						await cancellation;
					} catch {}
					try {
						reader.releaseLock();
					} catch {}
				}
				inFlight--;
			}
		})();
		if (
			!observeOrdinaryPromise(
				work,
				(value) => {
					// SAFETY: work only returns the source response or an internally constructed response.
					completion.resolve(value as Response);
				},
				() => completion.resolve(error(503)),
			)
		)
			completion.resolve(error(503));
		cancelTimer = timerClock.schedule(() => {
			timedOut = true;
			if (reader) {
				try {
					cancellation ??= reader.cancel();
					void cancellation.catch(() => undefined);
				} catch {}
			}
			timeout.resolve(error(408));
		}, AWS_HTTP_INGRESS_DEADLINE_MS);
		try {
			return (await raceBoundary(completion.promise, timeout.promise)).value;
		} finally {
			cancelTimer?.();
		}
	};
	return (request) => {
		const result = new IngressPromise((resolve) => {
			const pending = execute(request);
			if (
				!observeOrdinaryPromise(
					pending,
					(value) => {
						// SAFETY: execute returns only the source response or an internal response.
						resolve(value as Response);
					},
					() => resolve(error(503)),
				)
			)
				resolve(error(503));
		});
		return freeze(result);
	};
}
