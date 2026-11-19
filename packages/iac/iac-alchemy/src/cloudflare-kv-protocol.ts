import { readCloudflareByteStream } from "./cloudflare-byte-stream.js";

export const CLOUDFLARE_KV_MAX_KEY_BYTES = 512;
export const CLOUDFLARE_KV_MAX_VALUE_BYTES = 1_048_576;

export type CloudflareKvMode = "read-only" | "write-only";
const hasOwnDescriptor = Object.hasOwn;

export type CloudflareKvOperation = "get" | "set" | "delete";
export interface CloudflareKvGrant {
	readonly mode: CloudflareKvMode;

	readonly grantEpoch: string;

	readonly namespaceEpoch: string;
}

export function cloudflareKvGrant(
	mode: CloudflareKvMode,
	grantEpoch: string,
	namespaceEpoch: string,
	input: readonly string[],
): CloudflareKvGrant & { readonly allow: readonly string[] } {
	if (
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the host-provided epoch is an external input. */
		typeof grantEpoch !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(grantEpoch)
	)
		throw new CloudflareKvError(
			"KV_GRANT_INVALID",
			"a host-issued grant epoch is required",
		);
	if (
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the host-provided epoch is an external input. */
		typeof namespaceEpoch !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(namespaceEpoch)
	)
		throw new CloudflareKvError(
			"KV_GRANT_INVALID",
			"a host-issued namespace epoch is required",
		);
	if (
		!Array.isArray(input) ||
		input.length === 0 ||
		input.length > 2 ||
		Object.getOwnPropertySymbols(input).length !== 0
	)
		throw new CloudflareKvError(
			"KV_GRANT_INVALID",
			"an explicit allow list is required",
		);
	const properties = Object.getOwnPropertyDescriptors(input);
	const allowed: string[] = [];
	for (let index = 0; index < input.length; index++) {
		const entry = hasOwnDescriptor(properties, String(index))
			? properties[String(index)]
			: undefined;
		if (
			entry === undefined ||
			!hasOwnDescriptor(entry, "value") ||
			!entry.enumerable
		)
			throw new CloudflareKvError(
				"KV_GRANT_INVALID",
				"the allow list is invalid",
			);
		allowed.push(entry.value);
	}
	if (
		Object.keys(properties).length !== input.length + 1 ||
		new Set(allowed).size !== allowed.length ||
		(mode === "read-only" && (allowed.length !== 1 || allowed[0] !== "get")) ||
		(mode === "write-only" &&
			allowed.some((verb) => verb !== "set" && verb !== "delete")) ||
		(mode !== "read-only" && mode !== "write-only")
	)
		throw new CloudflareKvError(
			"KV_GRANT_INVALID",
			"KV requires an explicit read-only or write-only allow list",
		);
	return Object.freeze({
		mode,
		grantEpoch,
		namespaceEpoch,
		allow: Object.freeze(allowed.sort()),
	});
}

export function cloudflareEventualKv(grant: CloudflareKvGrant) {
	/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: adapter options are an external input. */
	if (typeof grant !== "object" || grant === null || Array.isArray(grant))
		throw new CloudflareKvError(
			"KV_MODE_INVALID",
			"a grant choice is required",
		);
	const properties = Object.getOwnPropertyDescriptors(grant);
	const mode = hasOwnDescriptor(properties, "mode")
		? properties.mode
		: undefined;
	const epoch = hasOwnDescriptor(properties, "grantEpoch")
		? properties.grantEpoch
		: undefined;
	const namespace = hasOwnDescriptor(properties, "namespaceEpoch")
		? properties.namespaceEpoch
		: undefined;
	if (
		Object.getOwnPropertySymbols(grant).length !== 0 ||
		Object.keys(properties).length !== 3 ||
		mode === undefined ||
		!hasOwnDescriptor(mode, "value") ||
		(mode.value !== "read-only" && mode.value !== "write-only") ||
		!mode.enumerable ||
		epoch === undefined ||
		!hasOwnDescriptor(epoch, "value") ||
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the host epoch is an external input. */
		typeof epoch.value !== "string" ||
		!epoch.enumerable ||
		namespace === undefined ||
		!hasOwnDescriptor(namespace, "value") ||
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the host namespace epoch is an external input. */
		typeof namespace.value !== "string" ||
		!namespace.enumerable
	)
		throw new CloudflareKvError(
			"KV_GRANT_INVALID",
			"grant choice must be plain data",
		);
	const checked = cloudflareKvGrant(
		mode.value,
		epoch.value,
		namespace.value,
		mode.value === "read-only" ? ["get"] : ["set"],
	);
	return Object.freeze({
		provider: "cloudflare",
		option: "eventual-kv",
		config: Object.freeze({
			mode: checked.mode,
			grantEpoch: checked.grantEpoch,
			namespaceEpoch: checked.namespaceEpoch,
			consistency: "eventual",
			runtime: "worker-js",
		}),
	});
}

export class CloudflareKvError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "CloudflareKvError";
	}
}

export function encodeCloudflareKvKey(key: string): string {
	if (
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: application values cross the runtime boundary. */
		typeof key !== "string" ||
		key.length === 0 ||
		key.length > CLOUDFLARE_KV_MAX_KEY_BYTES ||
		key === "." ||
		key === ".." ||
		new TextEncoder().encode(key).length > CLOUDFLARE_KV_MAX_KEY_BYTES
	)
		throw new CloudflareKvError(
			"KV_KEY_INVALID",
			"key is outside the native KV limits",
		);
	try {
		return encodeURIComponent(key);
	} catch {
		throw new CloudflareKvError("KV_KEY_INVALID", "key must be valid Unicode");
	}
}

export function decodeCloudflareKvKey(input: string | null): string {
	if (input === null || input.length > CLOUDFLARE_KV_MAX_KEY_BYTES * 3)
		throw new CloudflareKvError(
			"KV_KEY_INVALID",
			"key is missing or too large",
		);
	try {
		const key = decodeURIComponent(input);
		if (encodeCloudflareKvKey(key) !== input)
			throw new CloudflareKvError(
				"KV_KEY_INVALID",
				"key encoding is not canonical",
			);
		return key;
	} catch {
		throw new CloudflareKvError("KV_KEY_INVALID", "key encoding is invalid");
	}
}

export function readCloudflareKvBytes(
	body: ReadableStream<Uint8Array> | null,
): Promise<ArrayBuffer> {
	return readCloudflareByteStream(
		body,
		CLOUDFLARE_KV_MAX_VALUE_BYTES,
		true,
		(kind) => {
			if (kind === "unsupported")
				return new CloudflareKvError(
					"KV_STREAM_INVALID",
					"a bounded byte stream is required",
				);
			if (kind === "large")
				return new CloudflareKvError(
					"KV_VALUE_TOO_LARGE",
					"value exceeds the configured limit",
				);
			if (kind === "timeout")
				return new CloudflareKvError(
					"KV_STREAM_TIMEOUT",
					"value stream timed out",
				);
			return new CloudflareKvError(
				"KV_VALUE_INVALID",
				"value stream is invalid",
			);
		},
	);
}
