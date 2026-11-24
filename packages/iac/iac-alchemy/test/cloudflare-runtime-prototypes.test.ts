/* oxlint-disable unicorn/no-thenable -- These tests deliberately exercise hostile thenables. */
import { expect, it } from "vitest";
import { cloudflareKvProxy } from "../src/cloudflare-kv-proxy.js";
import { bindleCloudflareWorker } from "../src/cloudflare-runtime.js";

const thenProperty = "then";

it("keeps a write-only KV grant from gaining a denied operation", async () => {
	const includes = Array.prototype.includes;
	let deletes = 0;
	let response: Response | undefined;
	try {
		Reflect.set(
			Array.prototype,
			"includes",
			function (this: string[], value: string) {
				if (value === "delete") return true;
				// oxlint-disable-next-line anti-slop/no-reflect-apply -- Preserve unrelated native membership checks.
				return Reflect.apply(includes, this, [value]);
			},
		);
		response = await cloudflareKvProxy.fetch(
			new Request("https://hobo-kv.internal/delete", {
				method: "POST",
				headers: { "x-hobo-kv-key": "key" },
			}),
			{
				HOBO_KV_MODE: "write-only",
				HOBO_KV_ALLOW: "set",
				HOBO_KV_NAMESPACE: {
					get: async () => null,
					put: async () => {},
					delete: async () => {
						deletes++;
					},
				},
			},
		);
	} finally {
		Reflect.set(Array.prototype, "includes", includes);
	}
	expect(response?.status).toBe(403);
	expect(deletes).toBe(0);
});

it("pins a synchronous application response before an async return", async () => {
	const response = new Response("ok");
	const original = Object.getOwnPropertyDescriptor(
		Object.prototype,
		thenProperty,
	);
	let traps = 0;
	const entrypoint = () => () => {
		Object.defineProperty(Object.prototype, thenProperty, {
			configurable: true,
			get() {
				traps++;
				throw new Error("unexpected then getter");
			},
		});
		return response;
	};
	const worker = bindleCloudflareWorker(
		{
			name: "shop",
			resources: {
				web: {
					kind: "web",
					name: "web",
					stableId: "web:web",
					declaredAllow: [],
					dependsOn: [],
					annotations: [],
				},
			},
			edges: [],
			requirements: {},
			entrypoint: () => entrypoint,
		},
		"web",
	);
	let actual: Response | undefined;
	try {
		actual = await worker.fetch(new Request("https://example.test/"), {});
	} finally {
		if (original === undefined)
			Reflect.deleteProperty(Object.prototype, thenProperty);
		else Object.defineProperty(Object.prototype, thenProperty, original);
	}
	expect(actual).toBe(response);
	expect(traps).toBe(0);
});

it("keeps the native KV byte reader when a provider changes stream prototypes", async () => {
	const getReader = Object.getOwnPropertyDescriptor(
		ReadableStream.prototype,
		"getReader",
	);
	const read = Object.getOwnPropertyDescriptor(
		ReadableStreamBYOBReader.prototype,
		"read",
	);
	if (getReader === undefined || read === undefined)
		throw new Error("missing native readers");
	const stream = new ReadableStream<Uint8Array>({
		type: "bytes",
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
			controller.close();
		},
	});
	let traps = 0;
	const request = new Request("https://hobo-kv.internal/get", {
		method: "POST",
		headers: { "x-hobo-kv-key": "key" },
	});
	let response: Response | undefined;
	try {
		response = await cloudflareKvProxy.fetch(request, {
			HOBO_KV_MODE: "read-only",
			HOBO_KV_ALLOW: "get",
			HOBO_KV_NAMESPACE: {
				get() {
					Object.defineProperty(ReadableStream.prototype, "getReader", {
						configurable: true,
						value() {
							traps++;
							throw new Error("replaced getReader");
						},
					});
					Object.defineProperty(ReadableStreamBYOBReader.prototype, "read", {
						configurable: true,
						value() {
							traps++;
							throw new Error("replaced read");
						},
					});
					return Promise.resolve(stream);
				},
				put: async () => {},
				delete: async () => {},
			},
		});
	} finally {
		Object.defineProperty(ReadableStream.prototype, "getReader", getReader);
		Object.defineProperty(ReadableStreamBYOBReader.prototype, "read", read);
	}
	if (response === undefined) throw new Error("missing response");
	expect(response.status).toBe(200);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(
		new Uint8Array([1, 2, 3]),
	);
	expect(traps).toBe(0);
});
