/* oxlint-disable unicorn/no-thenable -- These tests deliberately exercise hostile thenables. */
import { expect, it } from "vitest";
import { createCloudflareR2Store } from "../src/cloudflare-r2-client.js";
import { cloudflareR2Digest } from "../src/cloudflare-r2-protocol.js";
import { cloudflareR2Proxy } from "../src/cloudflare-r2-proxy.js";

const thenProperty = "then";

it("rejects a mismatched read receipt when Array.includes changes", async () => {
	const bytes = new Uint8Array([1]);
	const digest = await cloudflareR2Digest(bytes.buffer);
	const response = new Response(
		new ReadableStream<Uint8Array>({
			type: "bytes",
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
		{
			headers: {
				"x-hobo-r2-key": "other",
				"x-hobo-r2-content-type": "text%2Fplain",
				"x-hobo-r2-size": "1",
				"x-hobo-r2-digest": digest,
			},
		},
	);
	const includes = Array.prototype.includes;
	const store = createCloudflareR2Store(
		{
			fetch() {
				Reflect.set(
					Array.prototype,
					"includes",
					function (this: number[], value: number) {
						if (value === 200) return false;
						// oxlint-disable-next-line anti-slop/no-reflect-apply -- Preserve unrelated membership checks.
						return Reflect.apply(includes, this, [value]);
					},
				);
				return Promise.resolve(response);
			},
		},
		["read"],
	);
	let failure: unknown;
	try {
		await store.read("key");
	} catch (error) {
		failure = error;
	} finally {
		Reflect.set(Array.prototype, "includes", includes);
	}
	expect(failure).toMatchObject({ code: "R2_READ_UNAVAILABLE" });
});

it("does not grant a denied client operation when Set.has changes", async () => {
	let calls = 0;
	const store = createCloudflareR2Store(
		{
			fetch: async () => {
				calls++;
				return new Response(null, { status: 204 });
			},
		},
		["read"],
	);
	const has = Set.prototype.has;
	let failure: unknown;
	try {
		Reflect.set(
			Set.prototype,
			"has",
			function (this: Set<string>, value: string) {
				if (value === "delete") return true;
				// oxlint-disable-next-line anti-slop/no-reflect-apply -- Preserve unrelated membership checks.
				return Reflect.apply(has, this, [value]);
			},
		);
		await store.delete("key");
	} catch (error) {
		failure = error;
	} finally {
		Reflect.set(Set.prototype, "has", has);
	}
	expect(failure).toMatchObject({ code: "R2_OPERATION_DENIED" });
	expect(calls).toBe(0);
});

it("does not grant a denied proxy operation when Array.includes changes", async () => {
	const includes = Array.prototype.includes;
	let deletes = 0;
	let response: Response | undefined;
	try {
		Reflect.set(
			Array.prototype,
			"includes",
			function (this: string[], value: string) {
				if (value === "delete") return true;
				// oxlint-disable-next-line anti-slop/no-reflect-apply -- Preserve unrelated membership checks.
				return Reflect.apply(includes, this, [value]);
			},
		);
		response = await cloudflareR2Proxy.fetch(
			new Request("https://hobo-r2.internal/delete", {
				method: "POST",
				headers: { "x-hobo-r2-key": "key" },
			}),
			{
				HOBO_R2_ALLOW: "read",
				HOBO_R2_BUCKET: {
					get: async () => null,
					put: async () => null,
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

it("keeps the native R2 response readers when a callback changes their prototypes", async () => {
	const status = Object.getOwnPropertyDescriptor(Response.prototype, "status");
	const header = Object.getOwnPropertyDescriptor(Headers.prototype, "get");
	if (status === undefined || header === undefined)
		throw new Error("missing native readers");
	const response = new Response(null, {
		status: 204,
		headers: { "x-hobo-r2-key": "key" },
	});
	let traps = 0;
	const store = createCloudflareR2Store(
		{
			fetch() {
				Object.defineProperty(Response.prototype, "status", {
					configurable: true,
					get() {
						traps++;
						return 500;
					},
				});
				Object.defineProperty(Headers.prototype, "get", {
					configurable: true,
					value() {
						traps++;
						return null;
					},
				});
				return Promise.resolve(response);
			},
		},
		["delete"],
	);
	let error: unknown;
	try {
		await store.delete("key");
	} catch (caught) {
		error = caught;
	} finally {
		Object.defineProperty(Response.prototype, "status", status);
		Object.defineProperty(Headers.prototype, "get", header);
	}
	expect(error).toBeUndefined();
	expect(traps).toBe(0);
});

it("keeps unsupported thenables unavailable or outcome-unknown", async () => {
	let traps = 0;
	const unsupported = {
		get [thenProperty]() {
			traps++;
			throw new Error("unexpected then getter");
		},
	};
	const store = createCloudflareR2Store({ fetch: () => unsupported }, [
		"read",
		"delete",
	]);
	await expect(store.read("key")).rejects.toMatchObject({
		code: "R2_READ_UNAVAILABLE",
	});
	await expect(store.delete("key")).rejects.toMatchObject({
		code: "R2_MUTATION_OUTCOME_UNKNOWN",
	});
	expect(traps).toBe(0);
});
