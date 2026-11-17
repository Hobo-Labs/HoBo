/** Bounded JavaScript R2 object subset; this is not the WASI blobstore interface. */
export const CLOUDFLARE_R2_MAX_KEY_BYTES = 512;
export const CLOUDFLARE_R2_MAX_CONTENT_TYPE_BYTES = 512;
export const CLOUDFLARE_R2_MAX_OBJECT_BYTES = 1_048_576;
export type CloudflareR2Operation = "read" | "write" | "delete";
export interface CloudflareR2Grant {
	readonly grantEpoch: string;
	readonly bucketEpoch: string;
}

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
	if (
		!(bytes instanceof ArrayBuffer) ||
		bytes.byteLength > CLOUDFLARE_R2_MAX_OBJECT_BYTES
	)
		throw new CloudflareR2Error(
			"R2_OBJECT_INVALID",
			"a bounded object body is required",
		);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const digest = await Promise.race([
			crypto.subtle.digest("SHA-256", bytes),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("digest timed out")), 10_000);
			}),
		]);
		if (!(digest instanceof ArrayBuffer) || digest.byteLength !== 32)
			throw new Error("invalid digest");
		return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	} catch {
		throw new CloudflareR2Error(
			"R2_DIGEST_UNAVAILABLE",
			"the object digest could not be verified",
		);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Stop and cancel oversized, stalled, or excessive-chunk streams before buffering more. */
export async function readCloudflareR2Bytes(
	body: ReadableStream<Uint8Array> | null,
): Promise<ArrayBuffer> {
	if (body === null) return new Uint8Array().buffer;
	let reader: ReadableStreamBYOBReader;
	try {
		reader = body.getReader({ mode: "byob" });
	} catch {
		void body.cancel().catch(() => {});
		throw new CloudflareR2Error(
			"R2_STREAM_UNSUPPORTED",
			"a bounded byte stream is required",
		);
	}
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
			const size = Math.min(65_536, CLOUDFLARE_R2_MAX_OBJECT_BYTES - total + 1);
			const result = await Promise.race([
				reader.read(new Uint8Array(size)),
				deadline,
			]);
			if (result.done) break;
			if (
				!(result.value instanceof Uint8Array) ||
				result.value.byteLength === 0 ||
				chunks.length >= 4096
			)
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
	bucketEpoch: string,
) {
	if (
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: epoch crosses the host authority boundary. */
		typeof grantEpoch !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(grantEpoch) ||
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: bucket identity crosses the host authority boundary. */
		typeof bucketEpoch !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(bucketEpoch) ||
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
	return Object.freeze({
		grantEpoch,
		bucketEpoch,
		allow: Object.freeze(result.sort()),
	});
}

/** Target-specific selection; the provider-neutral Bindle remains unchanged. */
export function cloudflareR2Option(grant: CloudflareR2Grant) {
	if (
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the target choice crosses an application boundary. */
		typeof grant !== "object" ||
		grant === null ||
		Array.isArray(grant) ||
		Object.getOwnPropertySymbols(grant).length !== 0
	)
		throw new CloudflareR2Error(
			"R2_GRANT_INVALID",
			"a plain host grant is required",
		);
	const values = Object.getOwnPropertyDescriptors(grant);
	const epoch = values.grantEpoch;
	const bucket = values.bucketEpoch;
	if (
		Object.keys(values).length !== 2 ||
		epoch === undefined ||
		!("value" in epoch) ||
		!epoch.enumerable ||
		bucket === undefined ||
		!("value" in bucket) ||
		!bucket.enumerable
	)
		throw new CloudflareR2Error(
			"R2_GRANT_INVALID",
			"a plain host grant is required",
		);
	const checked = cloudflareR2Grant(["read"], epoch.value, bucket.value);
	return Object.freeze({
		provider: "cloudflare",
		option: "bounded-r2",
		config: Object.freeze({
			grantEpoch: checked.grantEpoch,
			bucketEpoch: checked.bucketEpoch,
			runtime: "worker-js",
		}),
	});
}
