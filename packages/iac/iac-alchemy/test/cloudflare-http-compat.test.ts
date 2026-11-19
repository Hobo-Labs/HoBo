/* oxlint-disable unicorn/no-thenable -- This test checks response assimilation. */
import { expect, it } from "vitest";
import {
	bindleCloudflareWorker,
	type CloudflareBindleEntrypoint,
} from "../src/cloudflare-runtime.js";
import {
	cloudflareRequestBodyUsed,
	cloudflareResponseHeader,
} from "../src/cloudflare-web-options.js";

function workerFor(entrypoint: CloudflareBindleEntrypoint) {
	return bindleCloudflareWorker(
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
}

it("accepts a class instance with a prototype fetch method", async () => {
	let receiverCorrect = false;
	class Handler {
		fetch() {
			receiverCorrect = this instanceof Handler;
			return new Response("ok");
		}
	}
	const result = await workerFor(() => new Handler()).fetch(
		new Request("https://example.test/"),
		{},
	);
	expect(await result.text()).toBe("ok");
	expect(receiverCorrect).toBe(true);
});

it("rejects an accessor on the handler prototype without invoking it", async () => {
	let traps = 0;
	class Handler {
		get fetch(): () => Response {
			traps++;
			throw new Error("unexpected getter");
		}
	}
	await expect(
		workerFor(() => new Handler()).fetch(
			new Request("https://example.test/"),
			{},
		),
	).rejects.toThrow("bindle entrypoint did not return an HTTP handler");
	expect(traps).toBe(0);
});

it("accepts a frozen native Response with no then property", async () => {
	const response = Object.freeze(new Response("ok"));
	const result = await workerFor(() => () => response).fetch(
		new Request("https://example.test/"),
		{},
	);
	expect(result).toBe(response);
});

it("rechecks a frozen Response immediately before asynchronous return", async () => {
	const thenProperty = "then";
	const original = Object.getOwnPropertyDescriptor(
		Object.prototype,
		thenProperty,
	);
	const response = Object.freeze(new Response("ok"));
	let finish: (value: Response) => void = () => {};
	const pending = new Promise<Response>((resolve) => {
		finish = resolve;
	});
	const work = workerFor(() => () => pending).fetch(
		new Request("https://example.test/"),
		{},
	);
	let traps = 0;
	let failure: unknown;
	try {
		finish(response);
		queueMicrotask(() => {
			Object.defineProperty(Object.prototype, thenProperty, {
				configurable: true,
				get() {
					traps++;
					throw new Error("unexpected then getter");
				},
			});
		});
		await work;
	} catch (error) {
		failure = error;
	} finally {
		if (original === undefined)
			Reflect.deleteProperty(Object.prototype, thenProperty);
		else Object.defineProperty(Object.prototype, thenProperty, original);
	}
	expect(failure).toMatchObject({
		message: "bindle handler returned an invalid response",
	});
	expect(traps).toBe(0);
});

it("does not impose private receipt header limits on normal HTTP responses", async () => {
	const response = new Response("ok", {
		headers: { "x-hobo-kv-key": "x".repeat(8193) },
	});
	const result = await workerFor(() => () => response).fetch(
		new Request("https://example.test/"),
		{},
	);
	expect(result).toBe(response);
	expect(() => cloudflareResponseHeader(response, "x-hobo-kv-key")).toThrow(
		"header value invalid",
	);
});

it("accepts a same-realm native Promise subclass from a handler", async () => {
	class ResponsePromise<T> extends Promise<T> {}
	const response = new Response("ok");
	const pending = new ResponsePromise<Response>((resolve) => resolve(response));
	Object.defineProperty(pending, "constructor", {
		value: ResponsePromise,
		writable: true,
		enumerable: false,
		configurable: true,
	});
	const original = Object.getOwnPropertyDescriptor(pending, "constructor");
	const result = await workerFor(() => () => pending).fetch(
		new Request("https://example.test/"),
		{},
	);
	expect(result).toBe(response);
	expect(Object.getOwnPropertyDescriptor(pending, "constructor")).toEqual(
		original,
	);
});

it("restores a subclass constructor after a rejected handler Promise", async () => {
	class ResponsePromise<T> extends Promise<T> {}
	const failure = new Error("handler failed");
	const pending = new ResponsePromise<Response>((_resolve, reject) =>
		reject(failure),
	);
	Object.defineProperty(pending, "constructor", {
		value: ResponsePromise,
		writable: true,
		enumerable: false,
		configurable: true,
	});
	const original = Object.getOwnPropertyDescriptor(pending, "constructor");
	await expect(
		workerFor(() => () => pending).fetch(
			new Request("https://example.test/"),
			{},
		),
	).rejects.toBe(failure);
	expect(Object.getOwnPropertyDescriptor(pending, "constructor")).toEqual(
		original,
	);
});

it("accepts frozen native Promises and safely pinned frozen subclasses", async () => {
	class ResponsePromise<T> extends Promise<T> {}
	const response = new Response("ok");
	const ordinary = Object.freeze(Promise.resolve(response));
	const subclass = new ResponsePromise<Response>((resolve) =>
		resolve(response),
	);
	Object.defineProperty(subclass, "constructor", { value: Promise });
	Object.freeze(subclass);
	for (const pending of [ordinary, subclass]) {
		const result = await workerFor(() => () => pending).fetch(
			new Request("https://example.test/"),
			{},
		);
		expect(result).toBe(response);
	}
});

it("fails closed when a frozen subclass constructor cannot be pinned", async () => {
	class ResponsePromise<T> extends Promise<T> {}
	const pending = Object.freeze(
		new ResponsePromise<Response>((resolve) => resolve(new Response("ok"))),
	);
	await expect(
		workerFor(() => () => pending).fetch(
			new Request("https://example.test/"),
			{},
		),
	).rejects.toThrow("bindle handler result could not be observed");
});

it("reads Request.bodyUsed again after the stream is consumed", async () => {
	const request = new Request("https://example.test/", {
		method: "POST",
		body: "body",
	});
	expect(cloudflareRequestBodyUsed(request)).toBe(false);
	await request.text();
	expect(cloudflareRequestBodyUsed(request)).toBe(true);
});
