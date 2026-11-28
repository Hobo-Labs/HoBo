import { expect, it, vi } from "vitest";
import { rivetProtectResponse } from "../src/rivet-http-response.js";
import { createRivetHttpRetirementGate } from "../src/rivet-http-retirement.js";
import { createRivetHttpActor } from "../src/rivet-runtime.js";
import { runPublishedAdapterFixture } from "./published-adapter-fixture.js";

const context = { name: "web", key: ["tenant"], vars: {} };
function streamed(cancel: () => void | Promise<void>): Request {
	const body = new ReadableStream({ cancel });
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Node requires the duplex option when transferring a streaming request.
	return new Request("https://example.test/", {
		method: "POST",
		body,
		duplex: "half",
	} as RequestInit & { duplex: "half" });
}
function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("protects a response without reading polluted descriptor prototypes", () => {
	const response = new Response();
	const previous = Object.getOwnPropertyDescriptor(Object.prototype, "get");
	let traps = 0;
	let protectedResponse = false;
	try {
		Object.defineProperty(Object.prototype, "get", {
			configurable: true,
			get() {
				traps++;
				throw new Error("inherited descriptor field");
			},
		});
		protectedResponse = rivetProtectResponse(response);
	} finally {
		if (previous === undefined) Reflect.deleteProperty(Object.prototype, "get");
		else Object.defineProperty(Object.prototype, "get", previous);
	}
	expect(protectedResponse).toBe(true);
	expect(traps).toBe(0);
	expect(Object.getOwnPropertyDescriptor(response, "then")).toMatchObject({
		value: undefined,
		writable: false,
		configurable: false,
	});
});

it("does not assimilate poisoned response and Object prototypes", {
	timeout: 150_000,
}, () => {
	const output = runPublishedAdapterFixture(
		new URL("./rivet-http-response-fixture.mjs", import.meta.url),
		"rivet-runtime.js",
	);
	expect(output).toContain("http-response-intrinsics-ok");
});

it("quarantines a response that cannot be made non-thenable", async () => {
	let calls = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		entrypoint: () => () => {
			calls++;
			return Object.preventExtensions(new Response());
		},
	});
	for (let index = 0; index < 128; index++) {
		const result = await binding.handle(
			context,
			new Request("https://example.test"),
		);
		expect(result.status).toBe(503);
		expect(await result.json()).toMatchObject({
			error: "application-failed",
			execution: "possibly-completed",
		});
	}
	const overflow = await binding.handle(
		context,
		new Request("https://example.test"),
	);
	expect(overflow.status).toBe(503);
	expect(await overflow.json()).toMatchObject({
		error: "authorization-unavailable",
		execution: "not-started",
	});
	expect(calls).toBe(128);
});

it.each([
	"failure",
	"abort",
] as const)("keeps a post-effect %s unavailable when application code replaces Response.json", async (mode) => {
	const NativeResponse = Response;
	const originalJson = NativeResponse.json;
	const forged = vi.fn(() => new NativeResponse("forged", { status: 200 }));
	const source = new AbortController();
	let calls = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		entrypoint: () => () => {
			calls++;
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the replacement deliberately violates the static method contract.
			NativeResponse.json = forged as typeof NativeResponse.json;
			if (mode === "failure") throw new Error("handler failed");
			source.abort();
			return new NativeResponse("not disclosed");
		},
	});
	let result: Response;
	try {
		result = await binding.handle(
			context,
			new Request("https://example.test", { signal: source.signal }),
		);
	} finally {
		NativeResponse.json = originalJson;
	}
	expect(result.status).toBe(503);
	expect(await result.json()).toMatchObject({
		error:
			mode === "failure" ? "application-failed" : "authorization-unavailable",
		execution: "possibly-completed",
	});
	expect(calls).toBe(1);
	expect(forged).not.toHaveBeenCalled();
});

it("uses the captured Response constructor for denial and response validation", async () => {
	const NativeResponse = Response;
	let traps = 0;
	const replacement = new Proxy(NativeResponse, {
		construct() {
			traps++;
			throw new Error("untrusted constructor");
		},
		get() {
			traps++;
			throw new Error("untrusted constructor property");
		},
	});
	const denied = createRivetHttpActor({
		actorName: "web",
		authorize: () => {
			globalThis.Response = replacement;
			return false;
		},
		entrypoint: () => () => new NativeResponse("unexpected"),
	});
	let result: Response;
	try {
		result = await denied.handle(context, new Request("https://example.test"));
	} finally {
		globalThis.Response = NativeResponse;
	}
	expect(result.status).toBe(403);

	const allowed = createRivetHttpActor({
		actorName: "web",
		authorize: () => {
			globalThis.Response = replacement;
			return true;
		},
		entrypoint: () => () => new NativeResponse("original"),
	});
	try {
		result = await allowed.handle(context, new Request("https://example.test"));
	} finally {
		globalThis.Response = NativeResponse;
	}
	expect(result.status).toBe(200);
	expect(await result.text()).toBe("original");
	expect(traps).toBe(0);
});

it("rejects a proxied request before invoking its traps or authorization", async () => {
	let traps = 0;
	const authorize = vi.fn(() => true);
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize,
		entrypoint: () => () => new Response(),
	});
	const request = new Proxy(new Request("https://example.test"), {
		get() {
			traps++;
			throw new Error("request trap");
		},
		getPrototypeOf() {
			traps++;
			throw new Error("prototype trap");
		},
	});
	expect((await binding.handle(context, request)).status).toBe(403);
	expect(traps).toBe(0);
	expect(authorize).not.toHaveBeenCalled();
});

it.each([
	"method",
	"url",
	"headers",
	"body",
	"signal",
] as const)("rejects an own request %s accessor before transfer", async (field) => {
	let traps = 0;
	const authorize = vi.fn(() => true);
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize,
		entrypoint: () => () => new Response(),
	});
	const request = streamed(() => {});
	Object.defineProperty(request, field, {
		configurable: true,
		get() {
			traps++;
			throw new Error("request accessor");
		},
	});
	expect((await binding.handle(context, request)).status).toBe(403);
	expect(request.bodyUsed).toBe(false);
	expect(traps).toBe(0);
	expect(authorize).not.toHaveBeenCalled();
});

it.each([
	"aborted",
	"addEventListener",
	"removeEventListener",
] as const)("rejects an own signal %s accessor before transfer", async (field) => {
	let traps = 0;
	const authorize = vi.fn(() => true);
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize,
		entrypoint: () => () => new Response(),
	});
	const request = streamed(() => {});
	Object.defineProperty(request.signal, field, {
		configurable: true,
		get() {
			traps++;
			throw new Error("signal accessor");
		},
	});
	expect((await binding.handle(context, request)).status).toBe(403);
	expect(request.bodyUsed).toBe(false);
	expect(traps).toBe(0);
	expect(authorize).not.toHaveBeenCalled();
});

it("relays an abort without reading owner-mutated signal properties or starting late work", async () => {
	let started = () => {};
	let approve = (_value: boolean) => {};
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const pendingDecision = new Promise<boolean>((resolve) => {
		approve = resolve;
	});
	const handler = vi.fn(() => new Response("unexpected"));
	const binding = createRivetHttpActor({
		actorName: "web",
		entrypoint: () => handler,
		authorize: () => {
			started();
			return pendingDecision;
		},
	});
	const source = new AbortController();
	const request = new Request("https://example.test", {
		signal: source.signal,
	});
	const originalSignal = request.signal;
	const pending = binding.handle(context, request);
	await entered;
	let traps = 0;
	for (const field of ["aborted", "addEventListener", "removeEventListener"])
		Object.defineProperty(originalSignal, field, {
			configurable: true,
			get() {
				traps++;
				throw new Error("mutated signal");
			},
		});
	source.abort();
	approve(true);
	const result = await pending;
	expect(result.status).toBe(503);
	expect(await result.json()).toMatchObject({ execution: "not-started" });
	expect(handler).not.toHaveBeenCalled();
	expect(traps).toBe(0);
});

it("leaves an already-aborted request body with the host", async () => {
	const source = new AbortController();
	const request = new Request(
		streamed(() => {}),
		{ signal: source.signal },
	);
	source.abort();
	const authorize = vi.fn(() => true);
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize,
		entrypoint: () => () => new Response(),
	});
	const result = await binding.handle(context, request);
	expect(result.status).toBe(503);
	expect(await result.json()).toMatchObject({ execution: "not-started" });
	expect(request.bodyUsed).toBe(false);
	expect(authorize).not.toHaveBeenCalled();
});

it.each([
	"throws",
	"does-not-abort",
] as const)("latches and quarantines when captured abort %s", async (mode) => {
	const descriptor = Object.getOwnPropertyDescriptor(
		AbortController.prototype,
		"abort",
	);
	if (descriptor === undefined) throw new Error("native abort missing");
	let createActor: typeof createRivetHttpActor;
	try {
		Object.defineProperty(AbortController.prototype, "abort", {
			...descriptor,
			value() {
				if (mode === "throws") throw new Error("abort failure");
			},
		});
		vi.resetModules();
		({ createRivetHttpActor: createActor } = await import(
			"../src/rivet-runtime.js"
		));
	} finally {
		Object.defineProperty(AbortController.prototype, "abort", descriptor);
	}
	let started = () => {};
	let verdict = Promise.resolve(false);
	const handler = vi.fn(() => new Response("unexpected"));
	const authorize = vi.fn(() => {
		started();
		return verdict;
	});
	const binding = createActor({
		actorName: "web",
		entrypoint: () => handler,
		authorize,
	});
	for (let index = 0; index < 128; index++) {
		const entered = deferred();
		started = entered.resolve;
		let approve = (_value: boolean) => {};
		verdict = new Promise<boolean>((resolve) => {
			approve = resolve;
		});
		const source = new AbortController();
		const request = new Request("https://example.test", {
			signal: source.signal,
		});
		const pending = binding.handle(context, request);
		await entered.promise;
		source.abort();
		approve(true);
		const result = await pending;
		expect(result.status).toBe(503);
		expect(await result.json()).toMatchObject({ execution: "not-started" });
	}
	const overflow = streamed(() => {});
	expect((await binding.handle(context, overflow)).status).toBe(503);
	expect(overflow.bodyUsed).toBe(false);
	expect(authorize).toHaveBeenCalledTimes(128);
	expect(handler).not.toHaveBeenCalled();
});

it("uses the captured freeze operation for the authorized actor key", async () => {
	let keyFrozen = false;
	const binding = createRivetHttpActor({
		actorName: "web",
		entrypoint: () => () => new Response("ok"),
		authorize: ({ actorKey }) => {
			keyFrozen = Object.isFrozen(actorKey);
			return true;
		},
	});
	const original = Object.freeze;
	let pending: Promise<Response>;
	try {
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this hostile replacement deliberately disables all freeze overloads.
		Object.freeze = (<T>(value: T) => value) as typeof Object.freeze;
		pending = binding.handle(context, new Request("https://example.test"));
	} finally {
		Object.freeze = original;
	}
	expect((await pending).status).toBe(200);
	expect(keyFrozen).toBe(true);
});

it("does not treat a second cancellation as proof of an application-started cancellation", async () => {
	const upstream = deferred();
	let underlyingFinished = false;
	const stream = new ReadableStream({
		cancel: () =>
			upstream.promise.then(() => {
				underlyingFinished = true;
			}),
	});
	const response = new Response(stream);
	const first = stream.cancel();
	const reserve = createRivetHttpRetirementGate();
	const slot = reserve();
	if (slot === undefined) throw new Error("slot unavailable");
	slot.response(response);
	slot.finish();
	const held = Array.from({ length: 127 }, () => reserve());
	expect(held.every((entry) => entry !== undefined)).toBe(true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(underlyingFinished).toBe(false);
	const available = reserve();
	expect(available).toBeDefined();
	available?.finish();
	for (const entry of held) entry?.finish();

	upstream.resolve();
	await first;
	expect(underlyingFinished).toBe(true);
});

it("returns promptly after an abort while retaining pending response retirement capacity", async () => {
	const pending = Array.from({ length: 129 }, deferred);
	let active: AbortController | undefined;
	let calls = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		entrypoint: () => () => {
			const wait = pending[calls++];
			if (wait === undefined || active === undefined)
				throw new Error("unexpected request");
			active.abort();
			return new Response(new ReadableStream({ cancel: () => wait.promise }));
		},
	});
	for (let index = 0; index < 128; index++) {
		active = new AbortController();
		const result = await binding.handle(
			context,
			new Request("https://example.test", { signal: active.signal }),
		);
		expect(result.status).toBe(503);
		expect(await result.json()).toMatchObject({
			execution: "possibly-completed",
		});
	}
	const overflow = streamed(() => {});
	expect((await binding.handle(context, overflow)).status).toBe(503);
	expect(overflow.bodyUsed).toBe(false);
	expect(calls).toBe(128);
	pending[0]?.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	active = new AbortController();
	const next = await binding.handle(
		context,
		new Request("https://example.test", { signal: active.signal }),
	);
	expect(next.status).toBe(503);
	expect(await next.json()).toMatchObject({ execution: "possibly-completed" });
	expect(calls).toBe(129);
	for (const item of pending) item.resolve();
});

it("retains cancellation capacity when Set methods are replaced", async () => {
	const pending = deferred();
	const reserve = createRivetHttpRetirementGate();
	const slot = reserve();
	if (slot === undefined) throw new Error("missing reservation");
	const response = new Response(
		new ReadableStream({ cancel: () => pending.promise }),
	);
	const previousHas = Set.prototype.has;
	const previousAdd = Set.prototype.add;
	let traps = 0;
	try {
		Set.prototype.has = () => {
			traps++;
			return true;
		};
		Set.prototype.add = function () {
			traps++;
			return this;
		};
		slot.response(response);
		slot.finish();
	} finally {
		Set.prototype.has = previousHas;
		Set.prototype.add = previousAdd;
	}
	const held = Array.from({ length: 127 }, () => reserve());
	expect(held.every((entry) => entry !== undefined)).toBe(true);
	expect(reserve()).toBeUndefined();
	expect(traps).toBe(0);
	pending.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const available = reserve();
	expect(available).toBeDefined();
	available?.finish();
	for (const entry of held) entry?.finish();
});

it("retains bounded response slots until cancellation completes", async () => {
	const pending = Array.from({ length: 128 }, deferred);
	const reserve = createRivetHttpRetirementGate();
	for (const item of pending) {
		const slot = reserve();
		if (slot === undefined) throw new Error("capacity exhausted too early");
		slot.response(
			new Response(new ReadableStream({ cancel: () => item.promise })),
		);
		slot.finish();
	}
	expect(reserve()).toBeUndefined();
	pending[0]?.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const next = reserve();
	expect(next).toBeDefined();
	next?.finish();
	for (const item of pending) item.resolve();
});

it("quarantines failed response cancellations", async () => {
	const reserve = createRivetHttpRetirementGate();
	for (let index = 0; index < 128; index++) {
		const slot = reserve();
		if (slot === undefined) throw new Error("capacity exhausted too early");
		slot.response(
			new Response(
				new ReadableStream({
					cancel() {
						throw new Error("cancel failed");
					},
				}),
			),
		);
		slot.finish();
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(reserve()).toBeUndefined();
});

it("bounds active requests before taking ownership of an overflow stream", async () => {
	const pending = Array.from({ length: 129 }, deferred);
	let started = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		entrypoint: () => async () => {
			const wait = pending[started++];
			if (wait === undefined) throw new Error("unexpected invocation");
			await wait.promise;
			return new Response("done");
		},
	});
	const active = Array.from({ length: 128 }, () =>
		binding.handle(context, new Request("https://example.test")),
	);
	await vi.waitFor(() => expect(started).toBe(128));
	const overflow = streamed(() => {});
	expect((await binding.handle(context, overflow)).status).toBe(503);
	expect(overflow.bodyUsed).toBe(false);
	let traps = 0;
	const unaccepted = new Proxy(new Request("https://example.test"), {
		get() {
			traps++;
			throw new Error("request trap");
		},
	});
	expect((await binding.handle(context, unaccepted)).status).toBe(503);
	expect(traps).toBe(0);
	expect(started).toBe(128);
	pending[0]?.resolve();
	await active[0];
	const next = binding.handle(context, new Request("https://example.test"));
	await vi.waitFor(() => expect(started).toBe(129));
	for (const item of pending) item.resolve();
	await Promise.all([...active, next]);
});

it("retires a suppressed response without invoking its body or stream accessors", async () => {
	const reserve = createRivetHttpRetirementGate();
	const slot = reserve();
	if (slot === undefined) throw new Error("slot unavailable");
	let traps = 0;
	let cancelled = false;
	const stream = new ReadableStream({
		cancel() {
			cancelled = true;
		},
	});
	const response = new Response(stream);
	Object.defineProperty(response, "body", {
		get() {
			traps++;
			throw new Error("body trap");
		},
	});
	Object.defineProperty(stream, "cancel", {
		get() {
			traps++;
			throw new Error("cancel trap");
		},
	});
	slot.response(response);
	slot.finish();
	await vi.waitFor(() => expect(cancelled).toBe(true));
	expect(traps).toBe(0);
});

it("quarantines a proxied response without invoking its native brand traps", () => {
	const reserve = createRivetHttpRetirementGate();
	const slot = reserve();
	if (slot === undefined) throw new Error("slot unavailable");
	let traps = 0;
	const response = new Proxy(new Response("private"), {
		getPrototypeOf() {
			traps++;
			throw new Error("prototype trap");
		},
		get() {
			traps++;
			throw new Error("property trap");
		},
	});
	slot.response(response);
	slot.finish();
	const held = Array.from({ length: 127 }, () => reserve());
	expect(held.every((entry) => entry !== undefined)).toBe(true);
	expect(reserve()).toBeUndefined();
	expect(traps).toBe(0);
	for (const entry of held) entry?.finish();
});

it("does not cancel the same body transferred to a delivered response", async () => {
	const reserve = createRivetHttpRetirementGate();
	const slot = reserve();
	if (slot === undefined) throw new Error("slot unavailable");
	let cancelled = false;
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("kept"));
			controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	const original = new Response(stream);
	const delivered = new Response(original.body);
	slot.transferResponse(original, delivered);
	slot.finish();
	expect(await delivered.text()).toBe("kept");
	expect(cancelled).toBe(false);
});

it("uses captured native body and cancellation operations after a host callback changes the prototypes", async () => {
	const bodyDescriptor = Object.getOwnPropertyDescriptor(
		Request.prototype,
		"body",
	);
	const cancelDescriptor = Object.getOwnPropertyDescriptor(
		ReadableStream.prototype,
		"cancel",
	);
	if (bodyDescriptor === undefined || cancelDescriptor === undefined)
		throw new Error("native stream methods missing");
	let traps = 0;
	let cancelled = false;
	const request = streamed(() => {
		cancelled = true;
	});
	const binding = createRivetHttpActor({
		actorName: "web",
		entrypoint: () => () => new Response(),
		authorize: () => {
			Object.defineProperty(Request.prototype, "body", {
				configurable: true,
				get() {
					traps++;
					throw new Error("body trap");
				},
			});
			Object.defineProperty(ReadableStream.prototype, "cancel", {
				configurable: true,
				get() {
					traps++;
					throw new Error("cancel trap");
				},
			});
			return false;
		},
	});
	try {
		expect((await binding.handle(context, request)).status).toBe(403);
		await vi.waitFor(() => expect(cancelled).toBe(true));
		expect(traps).toBe(0);
	} finally {
		Object.defineProperty(Request.prototype, "body", bodyDescriptor);
		Object.defineProperty(ReadableStream.prototype, "cancel", cancelDescriptor);
	}
});

it("quarantines unknown ownership after a failed request transfer", async () => {
	const authorize = vi.fn(() => true);
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize,
		entrypoint: () => () => new Response(),
	});
	const consumed = new Request("https://example.test/", {
		method: "POST",
		body: "used",
	});
	await consumed.text();
	for (let index = 0; index < 128; index++)
		expect((await binding.handle(context, consumed)).status).toBe(403);
	const overflow = streamed(() => {});
	expect((await binding.handle(context, overflow)).status).toBe(503);
	expect(overflow.bodyUsed).toBe(false);
	expect(authorize).not.toHaveBeenCalled();
});
