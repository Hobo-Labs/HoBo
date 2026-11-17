/** Bounded JavaScript R2 object subset; this is not the WASI blobstore interface. */
export const CLOUDFLARE_R2_MAX_KEY_BYTES = 512;
export const CLOUDFLARE_R2_MAX_CONTENT_TYPE_BYTES = 512;
export const CLOUDFLARE_R2_MAX_OBJECT_BYTES = 1_048_576;
export type CloudflareR2Operation = "read" | "write" | "delete";

export class CloudflareR2Error extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "CloudflareR2Error";
	}
}

/** R2 keys pass through unchanged; headers carry their canonical URI encoding. */
export function encodeCloudflareR2Key(key: string): string {
	if (
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: callers cross the application runtime boundary. */
		typeof key !== "string" ||
		key.length === 0 ||
		key.length > CLOUDFLARE_R2_MAX_KEY_BYTES ||
		/[\p{Cc}]/u.test(key) ||
		new TextEncoder().encode(key).length > CLOUDFLARE_R2_MAX_KEY_BYTES
	)
		throw new CloudflareR2Error(
			"R2_KEY_INVALID",
			"object key is outside the supported limits",
		);
	try {
		return encodeURIComponent(key);
	} catch {
		throw new CloudflareR2Error(
			"R2_KEY_INVALID",
			"object key must be valid Unicode",
		);
	}
}

export function decodeCloudflareR2Key(input: string | null): string {
	if (input === null || input.length > CLOUDFLARE_R2_MAX_KEY_BYTES * 3)
		throw new CloudflareR2Error(
			"R2_KEY_INVALID",
			"object key is missing or too large",
		);
	try {
		const value = decodeURIComponent(input);
		if (encodeCloudflareR2Key(value) !== input) throw new Error("noncanonical");
		return value;
	} catch {
		throw new CloudflareR2Error(
			"R2_KEY_INVALID",
			"object key encoding is invalid",
		);
	}
}

/** Restrict HTTP metadata to printable ASCII: HTTP content types are not arbitrary Unicode. */
export function encodeCloudflareR2ContentType(value: string): string {
	if (
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: metadata crosses the runtime boundary. */
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > CLOUDFLARE_R2_MAX_CONTENT_TYPE_BYTES ||
		!/^[\x20-\x7e]+$/u.test(value)
	)
		throw new CloudflareR2Error(
			"R2_CONTENT_TYPE_INVALID",
			"a bounded printable ASCII content type is required",
		);
	return encodeURIComponent(value);
}

export function decodeCloudflareR2ContentType(input: string | null): string {
	if (input === null || input.length > CLOUDFLARE_R2_MAX_CONTENT_TYPE_BYTES * 3)
		throw new CloudflareR2Error(
			"R2_CONTENT_TYPE_INVALID",
			"content type is missing or too large",
		);
	try {
		const value = decodeURIComponent(input);
		if (encodeCloudflareR2ContentType(value) !== input)
			throw new Error("noncanonical");
		return value;
	} catch {
		throw new CloudflareR2Error(
			"R2_CONTENT_TYPE_INVALID",
			"content type encoding is invalid",
		);
	}
}

export function validCloudflareR2Digest(value: string): boolean {
	/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: digest is supplied by the application or service. */
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export async function cloudflareR2Digest(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Stop and cancel oversized, stalled, or excessive-chunk streams before buffering more. */
export async function readCloudflareR2Bytes(
	body: ReadableStream<Uint8Array> | null,
): Promise<ArrayBuffer> {
	if (body === null) return new Uint8Array().buffer;
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new CloudflareR2Error("R2_STREAM_TIMEOUT", "object stream timed out"),
				),
			10_000,
		);
	});
	try {
		while (true) {
			const result = await Promise.race([reader.read(), deadline]);
			if (result.done) break;
			if (!(result.value instanceof Uint8Array) || chunks.length >= 4096)
				throw new CloudflareR2Error(
					"R2_OBJECT_INVALID",
					"object stream is invalid",
				);
			total += result.value.byteLength;
			if (total > CLOUDFLARE_R2_MAX_OBJECT_BYTES)
				throw new CloudflareR2Error(
					"R2_OBJECT_TOO_LARGE",
					"object exceeds the supported size",
				);
			chunks.push(new Uint8Array(result.value));
		}
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		reader.releaseLock();
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result.buffer;
}

/** Snapshot and validate the exact grant before deriving a proxy identity. */
export function cloudflareR2Grant(
	allow: readonly string[],
	grantEpoch: string,
) {
	if (
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: epoch crosses the host authority boundary. */
		typeof grantEpoch !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(grantEpoch) ||
		!Array.isArray(allow) ||
		allow.length === 0 ||
		allow.length > 3 ||
		Object.getOwnPropertySymbols(allow).length !== 0
	)
		throw new CloudflareR2Error(
			"R2_GRANT_INVALID",
			"a host-issued epoch and explicit operation grant are required",
		);
	const descriptors = Object.getOwnPropertyDescriptors(allow);
	const result: string[] = [];
	for (let index = 0; index < allow.length; index++) {
		const entry = descriptors[String(index)];
		if (
			entry === undefined ||
			!("value" in entry) ||
			!entry.enumerable ||
			!["read", "write", "delete"].includes(entry.value)
		)
			throw new CloudflareR2Error(
				"R2_GRANT_INVALID",
				"operation grant is invalid",
			);
		result.push(entry.value);
	}
	if (
		Object.keys(descriptors).length !== allow.length + 1 ||
		new Set(result).size !== result.length
	)
		throw new CloudflareR2Error(
			"R2_GRANT_INVALID",
			"operation grant is invalid",
		);
	return Object.freeze({ grantEpoch, allow: Object.freeze(result.sort()) });
}
