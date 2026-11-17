import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLOUDFLARE_R2_MAX_OBJECT_BYTES,
	cloudflareR2Digest,
	encodeCloudflareR2ContentType,
	encodeCloudflareR2Key,
	readCloudflareR2Bytes,
} from "../src/cloudflare-r2-protocol.js";
import {
	type CloudflareR2ProxyEnvironment,
	cloudflareR2Proxy,
} from "../src/cloudflare-r2-proxy.js";

type Item = { bytes: Uint8Array; contentType?: string; digest?: string };
afterEach(() => vi.useRealTimers());
function native() {
	const items = new Map<string, Item>();
	const calls: string[] = [];
	const binding: CloudflareR2ProxyEnvironment["HOBO_R2_BUCKET"] = {
		async get(key) {
			calls.push(`get:${key}`);
			const item = items.get(key);
			if (!item) return null;
			const bytes = new Uint8Array(item.bytes);
			return {
				key,
				size: bytes.length,
				httpMetadata: { contentType: item.contentType },
				customMetadata: item.digest ? { "hobo-sha256": item.digest } : {},
				body: new ReadableStream({
					type: "bytes",
					start(controller) {
						if (bytes.byteLength > 0) controller.enqueue(bytes);
						controller.close();
					},
				}),
			};
		},
		async put(key, value, options) {
			calls.push(`put:${key}`);
			const bytes = new Uint8Array(value.slice(0));
			items.set(key, {
				bytes,
				contentType: options.httpMetadata.contentType,
				digest: options.customMetadata["hobo-sha256"],
			});
			return {
				key,
				size: bytes.length,
				httpMetadata: options.httpMetadata,
				customMetadata: options.customMetadata,
			};
		},
		async delete(key) {
			calls.push(`delete:${key}`);
			items.delete(key);
		},
	};
	return { items, calls, binding };
}
function env(
	bucket: CloudflareR2ProxyEnvironment["HOBO_R2_BUCKET"],
	allow = "delete,read,write",
): CloudflareR2ProxyEnvironment {
	return { HOBO_R2_ALLOW: allow, HOBO_R2_BUCKET: bucket };
}
function request(
	operation: string,
	key = "key",
	extra: Record<string, string> = {},
	body?: BodyInit,
): Request {
	const init: RequestInit = {
		method: "POST",
		headers: { "x-hobo-r2-key": encodeCloudflareR2Key(key), ...extra },
	};
	if (body !== undefined) init.body = body;
	return new Request(`https://hobo-r2.internal/${operation}`, init);
}

describe("bounded private Cloudflare R2 proxy", () => {
	it("round-trips bytes, metadata and a Unicode key while verifying SHA-256", async () => {
		const { binding, items } = native();
		const key = "invoices/雪🌎";
		const bytes = new Uint8Array([0, 255, 17]);
		const digest = await cloudflareR2Digest(bytes.buffer);
		const contentType = "application/octet-stream; charset=utf-8";
		const put = await cloudflareR2Proxy.fetch(
			request(
				"write",
				key,
				{
					"x-hobo-r2-content-type": encodeCloudflareR2ContentType(contentType),
					"x-hobo-r2-size": "3",
					"x-hobo-r2-digest": digest,
				},
				bytes,
			),
			env(binding),
		);
		expect(put.status).toBe(204);
		expect(put.headers.get("x-hobo-r2-digest")).toBe(digest);
		expect(items.get(key)).toEqual({ bytes, contentType, digest });
		const read = await cloudflareR2Proxy.fetch(
			request("read", key),
			env(binding),
		);
		expect(read.status).toBe(200);
		expect(read.headers.get("x-hobo-r2-content-type")).toBe(
			encodeCloudflareR2ContentType(contentType),
		);
		expect(read.headers.get("x-hobo-r2-size")).toBe("3");
		expect(read.headers.get("x-hobo-r2-digest")).toBe(digest);
		expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
		expect(
			(await cloudflareR2Proxy.fetch(request("delete", key), env(binding)))
				.status,
		).toBe(204);
		expect(
			(await cloudflareR2Proxy.fetch(request("read", key), env(binding)))
				.status,
		).toBe(404);
	});

	it("computes a digest for existing objects, and rejects missing content type or corrupt stored digest", async () => {
		const { binding, items } = native();
		items.set("external", {
			bytes: new Uint8Array([2]),
			contentType: "text/plain",
		});
		items.set("no-type", { bytes: new Uint8Array([2]) });
		items.set("bad-hash", {
			bytes: new Uint8Array([2]),
			contentType: "text/plain",
			digest: `sha256:${"a".repeat(64)}`,
		});
		const external = await cloudflareR2Proxy.fetch(
			request("read", "external"),
			env(binding),
		);
		expect(external.status).toBe(200);
		expect(external.headers.get("x-hobo-r2-digest")).toBe(
			await cloudflareR2Digest(new Uint8Array([2]).buffer),
		);
		const absent = await cloudflareR2Proxy.fetch(
			request("read", "no-type"),
			env(binding),
		);
		expect(absent.status).toBe(422);
		expect(absent.headers.get("x-hobo-r2-error")).toBe(
			"R2_METADATA_UNSUPPORTED",
		);
		const corrupt = await cloudflareR2Proxy.fetch(
			request("read", "bad-hash"),
			env(binding),
		);
		expect(corrupt.status).toBe(422);
		expect(corrupt.headers.get("x-hobo-r2-error")).toBe(
			"R2_INTEGRITY_UNVERIFIED",
		);
	});

	it("enforces grants even for direct proxy requests and rejects Unicode or conflicting metadata before writing", async () => {
		const { binding, calls } = native();
		for (const operation of ["write", "delete"])
			expect(
				(
					await cloudflareR2Proxy.fetch(
						request(operation),
						env(binding, "read"),
					)
				).status,
			).toBe(403);
		const bytes = new Uint8Array([1]);
		const digest = await cloudflareR2Digest(bytes.buffer);
		const headers = {
			"x-hobo-r2-content-type": encodeURIComponent("text/雪"),
			"x-hobo-r2-size": "1",
			"x-hobo-r2-digest": digest,
		};
		expect(
			(
				await cloudflareR2Proxy.fetch(
					request("write", "x", headers, bytes),
					env(binding),
				)
			).status,
		).toBe(422);
		headers["x-hobo-r2-content-type"] = "text%2Fplain";
		headers["x-hobo-r2-size"] = "2";
		expect(
			(
				await cloudflareR2Proxy.fetch(
					request("write", "x", headers, bytes),
					env(binding),
				)
			).status,
		).toBe(422);
		expect(calls).toEqual([]);
	});

	it("cancels an oversized or excessively chunked native stream without buffering it fully", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			type: "bytes",
			pull(controller) {
				controller.enqueue(new Uint8Array(CLOUDFLARE_R2_MAX_OBJECT_BYTES + 1));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(readCloudflareR2Bytes(stream)).rejects.toMatchObject({
			code: "R2_OBJECT_TOO_LARGE",
		});
		expect(cancelled).toBe(true);
		let cancelledChunks = false;
		const chunks = new ReadableStream<Uint8Array>({
			type: "bytes",
			pull(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel() {
				cancelledChunks = true;
			},
		});
		await expect(readCloudflareR2Bytes(chunks)).rejects.toMatchObject({
			code: "R2_OBJECT_INVALID",
		});
		expect(cancelledChunks).toBe(true);
	});

	it("cancels unsupported non-BYOB streams rather than making unbounded reads", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		await expect(readCloudflareR2Bytes(stream)).rejects.toMatchObject({
			code: "R2_STREAM_UNSUPPORTED",
		});
		expect(cancelled).toBe(true);
	});

	it("times out and cancels a stalled byte stream", async () => {
		vi.useFakeTimers();
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			type: "bytes",
			pull() {},
			cancel() {
				cancelled = true;
			},
		});
		const result = expect(readCloudflareR2Bytes(stream)).rejects.toMatchObject({
			code: "R2_STREAM_TIMEOUT",
		});
		await vi.advanceTimersByTimeAsync(10_001);
		await result;
		expect(cancelled).toBe(true);
	});

	it("reports an ambiguous write if the native response is lost or mismatched", async () => {
		const n = native();
		const bytes = new Uint8Array([7]);
		const headers = {
			"x-hobo-r2-content-type": "text%2Fplain",
			"x-hobo-r2-size": "1",
			"x-hobo-r2-digest": await cloudflareR2Digest(bytes.buffer),
		};
		const lost: typeof n.binding = {
			...n.binding,
			async put(...args) {
				await n.binding.put(...args);
				throw new Error("lost");
			},
		};
		const result = await cloudflareR2Proxy.fetch(
			request("write", "key", headers, bytes),
			env(lost),
		);
		expect(result.headers.get("x-hobo-r2-error")).toBe(
			"R2_MUTATION_OUTCOME_UNKNOWN",
		);
		expect(n.items.get("key")?.bytes).toEqual(bytes);
		expect(n.calls).toEqual(["put:key"]);
		const mismatched: typeof n.binding = {
			...n.binding,
			async put(...args) {
				const value = await n.binding.put(...args);
				return value && { ...value, key: "wrong" };
			},
		};
		const wrong = await cloudflareR2Proxy.fetch(
			request("write", "key", headers, bytes),
			env(mismatched),
		);
		expect(wrong.headers.get("x-hobo-r2-error")).toBe(
			"R2_MUTATION_OUTCOME_UNKNOWN",
		);
	});
});
