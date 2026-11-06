import { createHash } from "node:crypto";

const MAX_ENTRIES = 128;
const MAX_BODY_BYTES = 512 * 1024;
type CachedResponse = {
	body: string;
	headers: Headers;
	statusText: string;
	etag: string;
};

function cacheKey(url: URL, headers: Headers): string {
	const identity = createHash("sha256")
		.update(headers.get("authorization") ?? "")
		.digest("hex");
	return JSON.stringify([
		url.href,
		identity,
		headers.get("accept"),
		headers.get("x-github-api-version"),
	]);
}

function hasCallerCondition(headers: Headers): boolean {
	return [
		"if-none-match",
		"if-match",
		"if-modified-since",
		"if-unmodified-since",
		"if-range",
		"range",
	].some((name) => headers.has(name));
}

function isJson(headers: Headers): boolean {
	const media = headers
		.get("content-type")
		?.split(";")[0]
		?.trim()
		.toLowerCase();
	return (
		media === "application/json" ||
		(media?.startsWith("application/") === true && media.endsWith("+json"))
	);
}

async function cacheBody(response: Response): Promise<string | undefined> {
	if (!response.body || response.bodyUsed || response.body.locked)
		return undefined;
	const copy = response.clone();
	if (!copy.body) return undefined;
	const reader = copy.body.getReader();
	const parts: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > MAX_BODY_BYTES) {
				// clone() tees the original stream: awaiting cancellation here can
				// deadlock until the caller is allowed to consume the original.
				void reader.cancel().catch(() => {});
				return undefined;
			}
			parts.push(chunk.value);
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(parts),
		);
		JSON.parse(text);
		return text;
	} catch {
		void reader.cancel().catch(() => {});
		return undefined;
	} finally {
		reader.releaseLock();
	}
}

function replay(entry: CachedResponse, fresh: Headers): Response {
	const headers = new Headers(entry.headers);
	const obsolete: string[] = [];
	for (const name of headers.keys()) {
		if (
			name.startsWith("x-ratelimit-") ||
			["retry-after", "date", "age", "x-github-request-id"].includes(name)
		)
			obsolete.push(name);
	}
	for (const name of obsolete) headers.delete(name);
	for (const [name, value] of fresh) headers.set(name, value);
	// Fetch has already decoded the body; a 304's zero/compressed length does
	// not describe the bytes returned by this in-process cached response.
	headers.delete("content-encoding");
	headers.delete("transfer-encoding");
	headers.set("content-length", String(Buffer.byteLength(entry.body)));
	return new Response(entry.body, {
		status: 200,
		statusText: entry.statusText,
		headers,
	});
}

/** Revalidates small GitHub JSON reads without changing caller-owned ETag or mutation semantics. */
export function createConditionalGithubFetch(fetchImpl: typeof fetch = fetch) {
	const cache = new Map<string, CachedResponse>();
	function remember(key: string, entry: CachedResponse): void {
		cache.delete(key);
		cache.set(key, entry);
		if (cache.size > MAX_ENTRIES) {
			const oldest = cache.keys().next();
			if (!oldest.done) cache.delete(oldest.value);
		}
	}
	return async (
		input: string | URL,
		init: RequestInit = {},
	): Promise<Response> => {
		const url = new URL(input);
		const headers = new Headers(init.headers);
		if (
			(init.method ?? "GET").toUpperCase() !== "GET" ||
			init.body != null ||
			url.origin !== "https://api.github.com" ||
			hasCallerCondition(headers)
		)
			return fetchImpl(input, init);
		const key = cacheKey(url, headers);
		const entry = cache.get(key);
		if (entry) headers.set("If-None-Match", entry.etag);
		const response = await fetchImpl(input, { ...init, headers });
		if (response.status === 304 && entry) {
			const result = replay(entry, response.headers);
			remember(key, {
				...entry,
				headers: new Headers(result.headers),
				etag: result.headers.get("etag") ?? entry.etag,
			});
			return result;
		}
		if (response.status !== 200) return response;
		cache.delete(key);
		const etag = response.headers.get("etag");
		if (
			!etag ||
			!isJson(response.headers) ||
			Number(response.headers.get("content-length")) > MAX_BODY_BYTES
		)
			return response;
		const body = await cacheBody(response);
		if (body !== undefined)
			remember(key, {
				body,
				etag,
				headers: new Headers(response.headers),
				statusText: response.statusText,
			});
		return response;
	};
}
