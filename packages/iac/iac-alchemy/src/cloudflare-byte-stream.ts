/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-runtime-typeof -- SAFETY: native stream values are inspected at the Worker boundary. */

import { createBoundaryDeferred, observeBoundary } from "./async-boundary.js";
import {
	type CloudflareNativeLease,
	type CloudflareRetirement,
	cancelCloudflareNative,
	quarantineCloudflareNative,
	releaseCloudflareNative,
	reserveCloudflareNative,
} from "./cloudflare-capacity.js";
import {
	createCloudflareDeadline,
	isCloudflareNativeTimeout,
} from "./cloudflare-native-await.js";
import {
	cloudflareByobOptions,
	cloudflareNonThenable,
} from "./cloudflare-web-options.js";

const apply = Reflect.apply;
const descriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const define = Object.defineProperty;
const create = Object.create;
const min = Math.min;
const isSafeInteger = Number.isSafeInteger;
const NativeBytes = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(NativeBytes.prototype);
const byteLength = descriptor(typedArrayPrototype, "byteLength")?.get;
const byteBuffer = descriptor(typedArrayPrototype, "buffer")?.get;
const setBytes = NativeBytes.prototype.set;
const getReader = ReadableStream.prototype.getReader;
const cancelStream = ReadableStream.prototype.cancel;
const read = ReadableStreamBYOBReader.prototype.read;
const cancelReader = ReadableStreamBYOBReader.prototype.cancel;
const releaseLock = ReadableStreamBYOBReader.prototype.releaseLock;

type StreamFailure = "unsupported" | "invalid" | "large" | "timeout";

function cancel(
	value: object,
	method: typeof cancelStream | typeof cancelReader,
	transferred?: CloudflareNativeLease,
	canRelease?: () => boolean,
): CloudflareRetirement {
	return cancelCloudflareNative(
		() => apply(method, value, []),
		transferred,
		canRelease,
	);
}

export function cancelCloudflareByteStream(
	body: ReadableStream<Uint8Array>,
	transferred?: CloudflareNativeLease,
): CloudflareRetirement {
	return cancel(body, cancelStream, transferred);
}

export async function readCloudflareByteStream(
	body: ReadableStream<Uint8Array> | null,
	maximum: number,
	allowEmptyChunks: boolean,
	failure: (kind: StreamFailure) => Error,
): Promise<ArrayBuffer> {
	if (!isSafeInteger(maximum) || maximum < 0 || maximum > 1_048_576)
		throw failure("invalid");
	if (byteLength === undefined || byteBuffer === undefined)
		throw failure("unsupported");
	if (body === null)
		return cloudflareNonThenable(apply(byteBuffer, new NativeBytes(0), []));
	const lease = reserveCloudflareNative();
	if (lease === undefined) throw failure("unsupported");
	const ownership = createBoundaryDeferred<boolean>();
	observeBoundary(
		ownership.promise,
		(safe) => {
			if (safe) releaseCloudflareNative(lease);
		},
		() => {},
	);
	let reader: ReadableStreamBYOBReader;
	try {
		reader = apply(getReader, body, [cloudflareByobOptions]);
	} catch {
		cancel(body, cancelStream, lease);
		throw failure("unsupported");
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	let completed = false;
	let retirement: CloudflareRetirement = "unavailable";
	let unlocked = false;
	let failed = false;
	let caught: unknown;
	let deadline: ReturnType<typeof createCloudflareDeadline> | undefined;
	try {
		deadline = createCloudflareDeadline();
		while (true) {
			const size = min(65_536, maximum - total + 1);
			const boxed = await deadline.run<ReadableStreamReadResult<Uint8Array>>(
				() => apply(read, reader, [new NativeBytes(size)]),
			);
			const result = boxed.value;
			if (typeof result !== "object" || result === null)
				throw failure("invalid");
			const done = descriptor(result, "done");
			if (
				done === undefined ||
				!hasOwn(done, "value") ||
				typeof done.value !== "boolean"
			)
				throw failure("invalid");
			if (done.value) {
				completed = true;
				break;
			}
			const item = descriptor(result, "value");
			if (item === undefined || !hasOwn(item, "value") || chunks.length >= 4096)
				throw failure("invalid");
			let length: number;
			try {
				length = apply(byteLength, item.value, []);
			} catch {
				throw failure("invalid");
			}
			if (
				!isSafeInteger(length) ||
				length < 0 ||
				(!allowEmptyChunks && length === 0)
			)
				throw failure("invalid");
			total += length;
			if (total > maximum) throw failure("large");
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the native typed-array getter above accepted this view.
			const chunk = new NativeBytes(item.value as Uint8Array);
			const field: PropertyDescriptor = create(null);
			field.value = chunk;
			field.writable = true;
			field.enumerable = true;
			field.configurable = true;
			define(chunks, chunks.length, field);
		}
	} catch (error) {
		failed = true;
		caught = error;
		retirement = cancel(reader, cancelReader, lease, () => unlocked);
	} finally {
		deadline?.close();
	}
	try {
		apply(releaseLock, reader, []);
		unlocked = true;
	} catch {}
	if (!unlocked) quarantineCloudflareNative(lease);
	if (unlocked && (completed || retirement === "none")) ownership.resolve(true);
	if (failed) {
		if (isCloudflareNativeTimeout(caught)) throw failure("timeout");
		throw caught;
	}
	if (!unlocked) throw failure("invalid");
	const result = new NativeBytes(total);
	let offset = 0;
	for (let index = 0; index < chunks.length; index++) {
		const chunk = chunks[index];
		if (chunk === undefined) throw failure("invalid");
		apply(setBytes, result, [chunk, offset]);
		offset += apply(byteLength, chunk, []);
	}
	return cloudflareNonThenable(apply(byteBuffer, result, []));
}
