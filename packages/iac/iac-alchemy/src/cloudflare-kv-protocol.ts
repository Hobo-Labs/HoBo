/** Bounded JavaScript subset of Cloudflare Workers KV, not a WASI guest binding. */
export const CLOUDFLARE_KV_MAX_KEY_BYTES = 512;
export const CLOUDFLARE_KV_MAX_VALUE_BYTES = 1_048_576;

export type CloudflareKvMode = "read-only" | "write-only";
export type CloudflareKvOperation = "get" | "set" | "delete";

/** Explicitly opt into the provider's eventual, JavaScript-only subset. */
export function cloudflareEventualKv(mode: CloudflareKvMode) {
	if (mode !== "read-only" && mode !== "write-only")
		throw new CloudflareKvError(
			"KV_MODE_INVALID",
			"a read-only or write-only mode is required",
		);
	return Object.freeze({
		provider: "cloudflare",
		option: "eventual-kv",
		config: Object.freeze({
			mode,
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

/** Preserve native keys exactly; reject invalid Unicode and native key limits. */
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

/** Stop reading an oversized or unbounded stream before buffering it. */
export async function readCloudflareKvBytes(
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
					new CloudflareKvError("KV_STREAM_TIMEOUT", "value stream timed out"),
				),
			10_000,
		);
	});
	try {
		while (true) {
			const result = await Promise.race([reader.read(), deadline]);
			if (result.done) break;
			if (!(result.value instanceof Uint8Array) || chunks.length >= 4096)
				throw new CloudflareKvError(
					"KV_VALUE_INVALID",
					"value stream is invalid",
				);
			total += result.value.byteLength;
			if (total > CLOUDFLARE_KV_MAX_VALUE_BYTES)
				throw new CloudflareKvError(
					"KV_VALUE_TOO_LARGE",
					"value exceeds the configured limit",
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
