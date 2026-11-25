/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/no-unknown-returns -- SAFETY: native values are inspected at the Worker boundary. */
import {
	type CloudflareNativeLease,
	type CloudflareRetirement,
	cancelCloudflareNative,
} from "./cloudflare-capacity.js";

const create = Object.create;
const freeze = Object.freeze;
const define = Object.defineProperty;
const descriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const apply = Reflect.apply;
const NativeResponse = Response;
const NativeRequest = Request;
const NativeAbortController = AbortController;
const NativeAbortSignal = AbortSignal;
const NativeError = Error;

function nativeGetter(
	prototype: object,
	key: string,
): (() => unknown) | undefined {
	let current: object | null = prototype;
	for (let depth = 0; current !== null && depth < 8; depth++) {
		const field = descriptor(current, key);
		if (field !== undefined)
			return hasOwn(field, "get") && typeof field.get === "function"
				? field.get
				: undefined;
		current = getPrototype(current);
	}
	return undefined;
}

const statusGetter = nativeGetter(NativeResponse.prototype, "status");
const bodyGetter = nativeGetter(NativeResponse.prototype, "body");
const headersGetter = nativeGetter(NativeResponse.prototype, "headers");
const getHeader = Headers.prototype.get;
const cancelStream = ReadableStream.prototype.cancel;
const requestUrlGetter = nativeGetter(NativeRequest.prototype, "url");
const requestMethodGetter = nativeGetter(NativeRequest.prototype, "method");
const requestHeadersGetter = nativeGetter(NativeRequest.prototype, "headers");
const requestBodyGetter = nativeGetter(NativeRequest.prototype, "body");
const requestBodyUsedGetter = nativeGetter(NativeRequest.prototype, "bodyUsed");
const abortSignalGetter = nativeGetter(
	NativeAbortController.prototype,
	"signal",
);
const signalAbortedGetter = nativeGetter(
	NativeAbortSignal.prototype,
	"aborted",
);
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;
const isInteger = Number.isInteger;

function nativeField(
	value: object,
	prototype: object,
	key: string,
	getter: (() => unknown) | undefined,
): unknown {
	if (getter !== undefined) return apply(getter, value, []);
	if (getPrototype(value) !== prototype)
		throw new NativeError("native object unavailable");
	const field = descriptor(value, key);
	if (field === undefined || !hasOwn(field, "value"))
		throw new NativeError("native field unavailable");
	return field.value;
}

const receiptHeaders = freeze([
	"x-hobo-r2-key",
	"x-hobo-r2-content-type",
	"x-hobo-r2-size",
	"x-hobo-r2-digest",
	"x-hobo-r2-error",
	"x-hobo-kv-key",
]);

function snapshotHeaders(
	value: unknown,
): Readonly<Record<string, string | null>> {
	const result = create(null) as Record<string, string | null>;
	for (let index = 0; index < receiptHeaders.length; index++) {
		const name = receiptHeaders[index];
		if (name === undefined) throw new NativeError("header name unavailable");
		const field = apply(getHeader, value, [name]);
		if (field !== null && (typeof field !== "string" || field.length > 8192))
			throw new NativeError("header value invalid");
		result[name] = field;
	}
	return freeze(result);
}

interface ResponseSnapshot {
	readonly status: number;
	readonly body: ReadableStream<Uint8Array> | null;
	readonly headers: Headers;
}
interface RequestSnapshot {
	readonly url: string;
	readonly method: string;
	readonly body: ReadableStream<Uint8Array> | null;
	readonly headers: Readonly<Record<string, string | null>>;
}
const responses = new WeakMap<object, ResponseSnapshot>();
const responseHeaders = new WeakMap<
	object,
	Readonly<Record<string, string | null>>
>();
const requests = new WeakMap<object, RequestSnapshot>();

function responseSnapshot(value: object): ResponseSnapshot {
	const cached = apply(weakGet, responses, [value]) as
		| ResponseSnapshot
		| undefined;
	if (cached !== undefined) return cached;
	const status = nativeField(
		value,
		NativeResponse.prototype,
		"status",
		statusGetter,
	);
	const body = nativeField(value, NativeResponse.prototype, "body", bodyGetter);
	const headers = nativeField(
		value,
		NativeResponse.prototype,
		"headers",
		headersGetter,
	);
	if (
		typeof status !== "number" ||
		!isInteger(status) ||
		(status !== 0 && (status < 100 || status > 599)) ||
		(body !== null && (typeof body !== "object" || body === null))
	)
		throw new NativeError("response fields invalid");

	apply(getHeader, headers, ["x-hobo-boundary-check"]);
	const result = create(null) as {
		status: number;
		body: ReadableStream<Uint8Array> | null;
		headers: Headers;
	};
	result.status = status;
	result.body = body as ReadableStream<Uint8Array> | null;
	result.headers = headers as Headers;
	const snapshot = freeze(result);
	apply(weakSet, responses, [value, snapshot]);
	return snapshot;
}

function requestSnapshot(value: Request): RequestSnapshot {
	const cached = apply(weakGet, requests, [value]) as
		| RequestSnapshot
		| undefined;
	if (cached !== undefined) return cached;
	const url = nativeField(
		value,
		NativeRequest.prototype,
		"url",
		requestUrlGetter,
	);
	const method = nativeField(
		value,
		NativeRequest.prototype,
		"method",
		requestMethodGetter,
	);
	const body = nativeField(
		value,
		NativeRequest.prototype,
		"body",
		requestBodyGetter,
	);
	const headers = nativeField(
		value,
		NativeRequest.prototype,
		"headers",
		requestHeadersGetter,
	);
	if (
		typeof url !== "string" ||
		url.length > 8192 ||
		typeof method !== "string" ||
		method.length > 32 ||
		(body !== null && (typeof body !== "object" || body === null))
	)
		throw new NativeError("request fields invalid");
	const result = create(null) as {
		url: string;
		method: string;
		body: ReadableStream<Uint8Array> | null;
		headers: Readonly<Record<string, string | null>>;
	};
	result.url = url;
	result.method = method;
	result.body = body as ReadableStream<Uint8Array> | null;
	result.headers = snapshotHeaders(headers);
	const snapshot = freeze(result);
	apply(weakSet, requests, [value, snapshot]);
	return snapshot;
}

const nonThenable: PropertyDescriptor = create(null);
nonThenable.value = undefined;
nonThenable.writable = false;
nonThenable.enumerable = false;
nonThenable.configurable = false;
freeze(nonThenable);

export function cloudflareNonThenable<T extends object>(value: T): T {
	define(value, "then", nonThenable);
	return value;
}

function responseIsNonThenable(value: object): boolean {
	let current: object | null = value;
	for (let depth = 0; current !== null && depth < 32; depth++) {
		const field = descriptor(current, "then");
		if (field !== undefined)
			return hasOwn(field, "value") && typeof field.value !== "function";
		current = getPrototype(current);
	}
	return current === null;
}

export function cloudflareProtectResponse(value: unknown): value is Response {
	try {
		if (typeof value !== "object" || value === null) return false;
		responseSnapshot(value);
		try {
			cloudflareNonThenable(value);
			return true;
		} catch {
			return responseIsNonThenable(value);
		}
	} catch {
		return false;
	}
}

export function cloudflareResponseStatus(value: Response): number {
	return responseSnapshot(value).status;
}

export function cloudflareResponseBody(
	value: Response,
): ReadableStream<Uint8Array> | null {
	return responseSnapshot(value).body;
}

export function cloudflareResponseHeader(
	value: Response,
	name: string,
): string | null {
	let headers = apply(weakGet, responseHeaders, [value]) as
		| Readonly<Record<string, string | null>>
		| undefined;
	if (headers === undefined) {
		headers = snapshotHeaders(responseSnapshot(value).headers);
		apply(weakSet, responseHeaders, [value, headers]);
	}
	const field = descriptor(headers, name);
	if (field === undefined || !hasOwn(field, "value"))
		throw new NativeError("response header unavailable");
	return field.value;
}

export function cloudflareRequestUrl(value: Request): string {
	return requestSnapshot(value).url;
}

export function cloudflareRequestMethod(value: Request): string {
	return requestSnapshot(value).method;
}

export function cloudflareRequestHeader(
	value: Request,
	name: string,
): string | null {
	const headers = requestSnapshot(value).headers;
	const field = descriptor(headers, name);
	if (field === undefined || !hasOwn(field, "value"))
		throw new NativeError("request header unavailable");
	return field.value;
}

export function cloudflareRequestBody(
	value: Request,
): ReadableStream<Uint8Array> | null {
	return requestSnapshot(value).body;
}

export function cloudflareRequestBodyUsed(value: Request): boolean {
	const used = nativeField(
		value,
		NativeRequest.prototype,
		"bodyUsed",
		requestBodyUsedGetter,
	);
	if (typeof used !== "boolean") throw new NativeError("request state invalid");
	return used;
}

export function cloudflareAbortSignal(value: AbortController): AbortSignal {
	const signal = nativeField(
		value,
		NativeAbortController.prototype,
		"signal",
		abortSignalGetter,
	);
	if (typeof signal !== "object" || signal === null)
		throw new NativeError("abort signal unavailable");
	const aborted = nativeField(
		signal,
		NativeAbortSignal.prototype,
		"aborted",
		signalAbortedGetter,
	);
	if (aborted !== false) throw new NativeError("abort signal unavailable");
	return signal as AbortSignal;
}

export function cloudflareDiscardResponse(
	value: unknown,
	transferred?: CloudflareNativeLease,
): CloudflareRetirement {
	try {
		if (!cloudflareProtectResponse(value)) return "unavailable";
		const body = cloudflareResponseBody(value);
		if (body === null) return "none";
		return cancelCloudflareNative(
			() => apply(cancelStream, body, []),
			transferred,
		);
	} catch {
		return "unavailable";
	}
}

export function cloudflareHeaders(
	name: string,
	value: string,
): Record<string, string> {
	const headers = create(null) as Record<string, string>;
	headers[name] = value;
	return headers;
}

export function cloudflareResponseInit(
	status: number,
	headers?: HeadersInit,
): ResponseInit {
	const init = create(null) as ResponseInit;
	init.status = status;
	if (headers !== undefined) init.headers = headers;
	return init;
}

export function cloudflareResponse(
	body: BodyInit | null,
	status: number,
	headers?: HeadersInit,
): Response {
	const response = new NativeResponse(
		body,
		cloudflareResponseInit(status, headers),
	);
	if (!cloudflareProtectResponse(response))
		throw new NativeError("the response could not be returned safely");
	return response;
}

export function cloudflareRequestInit(
	headers: HeadersInit,
	signal: AbortSignal,
	body?: BodyInit,
): RequestInit {
	const init = create(null) as RequestInit;
	init.method = "POST";
	init.headers = headers;
	init.signal = signal;
	if (body !== undefined) init.body = body;
	return init;
}

export function cloudflareR2PutOptions(
	contentType: string,
	sha256: string,
): {
	readonly httpMetadata: { readonly contentType: string };
	readonly customMetadata: Record<string, string>;
	readonly sha256: string;
} {
	const httpMetadata = create(null) as { contentType: string };
	httpMetadata.contentType = contentType;
	const customMetadata = cloudflareHeaders("hobo-sha256", `sha256:${sha256}`);
	const options = create(null) as {
		httpMetadata: { contentType: string };
		customMetadata: Record<string, string>;
		sha256: string;
	};
	options.httpMetadata = httpMetadata;
	options.customMetadata = customMetadata;
	options.sha256 = sha256;
	return options;
}

export function cloudflareR2ReadResult(
	name: string,
	contentType: string,
	size: number,
	digest: string,
	body: Uint8Array,
): Readonly<{
	name: string;
	contentType: string;
	size: number;
	digest: string;
	body: Uint8Array;
}> {
	const result = create(null) as {
		name: string;
		contentType: string;
		size: number;
		digest: string;
		body: Uint8Array;
	};
	result.name = name;
	result.contentType = contentType;
	result.size = size;
	result.digest = digest;
	result.body = body;
	return freeze(result);
}

const byob = create(null) as { mode: "byob" };
byob.mode = "byob";
export const cloudflareByobOptions = freeze(byob);
