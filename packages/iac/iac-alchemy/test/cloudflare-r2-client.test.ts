import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflareR2Store } from "../src/cloudflare-r2-client.js";
import {
	cloudflareR2Digest,
	encodeCloudflareR2ContentType,
	encodeCloudflareR2Key,
} from "../src/cloudflare-r2-protocol.js";
import {
	type CloudflareR2ProxyEnvironment,
	cloudflareR2Proxy,
} from "../src/cloudflare-r2-proxy.js";

afterEach(() => vi.useRealTimers());
function native() {
	const data = new Map<
		string,
		{ bytes: Uint8Array; contentType: string; digest: string }
	>();
	const calls: string[] = [];
	const binding: CloudflareR2ProxyEnvironment["HOBO_R2_BUCKET"] = {
		async get(key) {
			calls.push(`get:${key}`);
			const item = data.get(key);
			if (item === undefined) return null;
			const bytes = new Uint8Array(item.bytes);
			return {
				key,
				size: bytes.byteLength,
				httpMetadata: { contentType: item.contentType },
				customMetadata: { "hobo-sha256": item.digest },
				body: new ReadableStream({
					type: "bytes",
					start(c) {
						if (bytes.byteLength) c.enqueue(bytes);
						c.close();
					},
				}),
			};
		},
		async put(key, body, options) {
			calls.push(`put:${key}`);
			data.set(key, {
				bytes: new Uint8Array(body.slice(0)),
				contentType: options.httpMetadata.contentType,
				digest: options.customMetadata["hobo-sha256"] ?? "",
			});
			return {
				key,
				size: body.byteLength,
				httpMetadata: options.httpMetadata,
				customMetadata: options.customMetadata,
			};
		},
		async delete(key) {
			calls.push(`delete:${key}`);
			data.delete(key);
		},
	};
	return { data, calls, binding };
}

describe("bounded R2 application client", () => {
	it("inspects typed-array length without a mutable getter call property", async () => {
		const n = native();
		const service = {
			fetch: (request: Request) =>
				cloudflareR2Proxy.fetch(request, {
					HOBO_R2_ALLOW: "write",
					HOBO_R2_BUCKET: n.binding,
				}),
		};
		const store = createCloudflareR2Store(service, ["write"]);
		const body = new Uint8Array([3, 4]);
		const object = {
			name: "x",
			contentType: "text/plain",
			size: body.length,
			digest: await cloudflareR2Digest(body.buffer),
			body,
		};
		const getter = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(Uint8Array.prototype),
			"byteLength",
		)?.get;
		if (getter === undefined) throw new Error("missing typed-array getter");
		const original = Object.getOwnPropertyDescriptor(getter, "call");
		let traps = 0;
		Object.defineProperty(getter, "call", {
			configurable: true,
			get() {
				traps++;
				throw new Error("getter trap");
			},
		});
		try {
			await store.write(object);
		} finally {
			if (original === undefined) Reflect.deleteProperty(getter, "call");
			else Object.defineProperty(getter, "call", original);
		}
		expect(traps).toBe(0);
		expect(n.calls).toEqual(["put:x"]);
	});

	it("round-trips bytes and object metadata through the private proxy", async () => {
		const n = native();
		const service = {
			fetch: (request: Request) =>
				cloudflareR2Proxy.fetch(request, {
					HOBO_R2_ALLOW: "delete,read,write",
					HOBO_R2_BUCKET: n.binding,
				}),
		};
		const store = createCloudflareR2Store(service, ["read", "write", "delete"]);
		const body = new Uint8Array([0, 128, 255]);
		const object = {
			name: "docs/雪",
			contentType: "application/octet-stream",
			size: 3,
			digest: await cloudflareR2Digest(body.buffer),
			body,
		};
		await store.write(object);
		expect(await store.read(object.name)).toEqual(object);
		await store.delete(object.name);
		expect(await store.read(object.name)).toBeUndefined();
		expect(n.calls).toEqual([
			"put:docs/雪",
			"get:docs/雪",
			"delete:docs/雪",
			"get:docs/雪",
		]);
	});

	it("enforces grants and validates digest, size and metadata before any call", async () => {
		let calls = 0;
		const service = {
			async fetch() {
				calls++;
				return new Response();
			},
		};
		const readonly = createCloudflareR2Store(service, ["read"]);
		await expect(readonly.delete("x")).rejects.toMatchObject({
			code: "R2_OPERATION_DENIED",
		});
		const store = createCloudflareR2Store(service, ["write"]);
		const body = new Uint8Array([1]);
		const valid = {
			name: "x",
			contentType: "text/plain",
			size: 1,
			digest: await cloudflareR2Digest(body.buffer),
			body,
		};
		await expect(store.write({ ...valid, size: 2 })).rejects.toMatchObject({
			code: "R2_OBJECT_INVALID",
		});
		await expect(
			store.write({ ...valid, digest: `sha256:${"a".repeat(64)}` }),
		).rejects.toMatchObject({ code: "R2_INTEGRITY_UNVERIFIED" });
		await expect(
			store.write({ ...valid, contentType: "text/雪" }),
		).rejects.toMatchObject({ code: "R2_CONTENT_TYPE_INVALID" });
		const accessor = {
			...valid,
			get name() {
				throw new Error("must not execute");
			},
		};
		await expect(store.write(accessor)).rejects.toMatchObject({
			code: "R2_OBJECT_INVALID",
		});
		const oversized = new Uint8Array(1_048_577);
		Object.defineProperty(oversized, "byteLength", { value: 0 });
		await expect(
			store.write({ ...valid, body: oversized, size: 0 }),
		).rejects.toMatchObject({ code: "R2_OBJECT_INVALID" });
		/* oxlint-disable anti-slop/no-reflect-apply -- SAFETY: JavaScript callers can provide undeclared options; the boundary must reject them. */
		await expect(
			Reflect.apply(readonly.read, readonly, ["x", { events: true }]),
		).rejects.toMatchObject({ code: "R2_REQUEST_INVALID" });
		await expect(
			Reflect.apply(store.write, store, [valid, { presign: true }]),
		).rejects.toMatchObject({ code: "R2_REQUEST_INVALID" });
		/* oxlint-enable anti-slop/no-reflect-apply */
		expect(calls).toBe(0);
	});

	it("snapshots the real typed-array bytes without invoking caller properties", async () => {
		const n = native();
		const service = {
			fetch: (request: Request) =>
				cloudflareR2Proxy.fetch(request, {
					HOBO_R2_ALLOW: "write",
					HOBO_R2_BUCKET: n.binding,
				}),
		};
		const store = createCloudflareR2Store(service, ["write"]);
		const bytes = new Uint8Array([1, 2, 3]);
		const digest = await cloudflareR2Digest(new Uint8Array([1, 2, 3]).buffer);
		Object.defineProperty(bytes, "byteLength", { value: 0 });
		Object.defineProperty(bytes, Symbol.iterator, {
			value: () => {
				throw new Error("iterator must not run");
			},
		});
		await store.write({
			name: "x",
			contentType: "text/plain",
			size: 3,
			digest,
			body: bytes,
		});
		expect(n.data.get("x")?.bytes).toEqual(new Uint8Array([1, 2, 3]));
		expect(n.calls).toEqual(["put:x"]);
	});

	it("rejects mismatched write/delete receipts and never retries", async () => {
		let calls = 0;
		const service = {
			async fetch() {
				calls++;
				return new Response(null, {
					status: 204,
					headers: { "x-hobo-r2-key": "another" },
				});
			},
		};
		const store = createCloudflareR2Store(service, ["write", "delete"]);
		const body = new Uint8Array([5]);
		await expect(
			store.write({
				name: "x",
				contentType: "text/plain",
				digest: await cloudflareR2Digest(body.buffer),
				size: 1,
				body,
			}),
		).rejects.toMatchObject({ code: "R2_MUTATION_OUTCOME_UNKNOWN" });
		await expect(store.delete("x")).rejects.toMatchObject({
			code: "R2_MUTATION_OUTCOME_UNKNOWN",
		});
		expect(calls).toBe(2);
	});

	it("cancels invalid and late response streams without retrying", async () => {
		vi.useFakeTimers();
		vi.resetModules();
		const { createCloudflareR2Store: timedStore } = await import(
			"../src/cloudflare-r2-client.js"
		);
		let cancelled = false;
		const invalid = timedStore(
			{
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							cancel() {
								cancelled = true;
							},
						}),
						{ status: 500 },
					),
			},
			["delete"],
		);
		await expect(invalid.delete("x")).rejects.toMatchObject({
			code: "R2_MUTATION_OUTCOME_UNKNOWN",
		});
		expect(cancelled).toBe(true);
		let resolveResponse: (response: Response) => void = () => {};
		let lateCancelled = false;
		const late = timedStore(
			{
				fetch: () =>
					new Promise<Response>((resolve) => {
						resolveResponse = resolve;
					}),
			},
			["delete"],
		);
		const outcome = expect(late.delete("x")).rejects.toMatchObject({
			code: "R2_MUTATION_OUTCOME_UNKNOWN",
		});
		await vi.advanceTimersByTimeAsync(10_001);
		await outcome;
		resolveResponse(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						lateCancelled = true;
					},
				}),
			),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(lateCancelled).toBe(true);
	});

	it("does not mistake mismatched or corrupted reads for successful data", async () => {
		const body = new Uint8Array([1]);
		const headers = {
			"x-hobo-r2-key": encodeCloudflareR2Key("x"),
			"x-hobo-r2-content-type": encodeCloudflareR2ContentType("text/plain"),
			"x-hobo-r2-size": "1",
			"x-hobo-r2-digest": `sha256:${"a".repeat(64)}`,
		};
		const corrupt = createCloudflareR2Store(
			{ fetch: async () => new Response(body, { headers }) },
			["read"],
		);
		await expect(corrupt.read("x")).rejects.toMatchObject({
			code: "R2_READ_UNAVAILABLE",
		});
		const wrong = createCloudflareR2Store(
			{
				fetch: async () =>
					new Response(null, {
						status: 404,
						headers: { "x-hobo-r2-key": "other" },
					}),
			},
			["read"],
		);
		await expect(wrong.read("x")).rejects.toMatchObject({
			code: "R2_READ_UNAVAILABLE",
		});
	});

	it("returns unknown for stalled writes and cancels stalled reads", async () => {
		vi.useFakeTimers();
		vi.resetModules();
		const { createCloudflareR2Store: timedStore } = await import(
			"../src/cloudflare-r2-client.js"
		);
		let calls = 0;
		let aborted = false;
		const stalled = timedStore(
			{
				fetch: async (request: Request) => {
					calls++;
					request.signal.addEventListener("abort", () => {
						aborted = true;
					});
					return await new Promise<Response>(() => {});
				},
			},
			["delete"],
		);
		const writeResult = expect(stalled.delete("x")).rejects.toMatchObject({
			code: "R2_MUTATION_OUTCOME_UNKNOWN",
		});
		await vi.advanceTimersByTimeAsync(10_001);
		await writeResult;
		expect(calls).toBe(1);
		expect(aborted).toBe(true);
		let cancelled = false;
		const headers = {
			"x-hobo-r2-key": "x",
			"x-hobo-r2-content-type": "text%2Fplain",
			"x-hobo-r2-size": "0",
			"x-hobo-r2-digest": `sha256:${"a".repeat(64)}`,
		};
		const reader = timedStore(
			{
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							type: "bytes",
							pull() {},
							cancel() {
								cancelled = true;
							},
						}),
						{ headers },
					),
			},
			["read"],
		);
		const readResult = expect(reader.read("x")).rejects.toMatchObject({
			code: "R2_READ_UNAVAILABLE",
		});
		await vi.advanceTimersByTimeAsync(10_001);
		await readResult;
		expect(cancelled).toBe(true);
	});
});
