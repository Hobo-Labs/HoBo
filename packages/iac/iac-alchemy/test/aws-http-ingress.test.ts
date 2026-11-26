import { describe, expect, it } from "vitest";
import {
	AWS_HTTP_INGRESS_DEADLINE_MS,
	AWS_HTTP_MAX_INGRESS,
	AWS_HTTP_MAX_REQUEST_BYTES,
	AWS_HTTP_MAX_REQUEST_CHUNKS,
	createAwsIngressHandler,
} from "../src/aws-http-ingress.js";

function post(
	body: ReadableStream<Uint8Array>,
	headers?: HeadersInit,
): Request {
	// SAFETY: Node's Fetch implementation requires duplex for streamed request bodies.
	return new Request("https://app.test/", {
		method: "POST",
		body,
		headers,
		duplex: "half",
	} as RequestInit & { duplex: "half" });
}
function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

describe("AWS HTTP ingress", () => {
	it("dispatches only bounded complete request bodies", async () => {
		let calls = 0;
		const ingress = createAwsIngressHandler({
			fetch: async (request) => {
				calls++;
				return Response.json({
					size: (await request.arrayBuffer()).byteLength,
				});
			},
		});
		const atLimit = await ingress(
			post(stream(new Uint8Array(AWS_HTTP_MAX_REQUEST_BYTES))),
		);
		expect(atLimit.status).toBe(200);
		expect(await atLimit.json()).toEqual({ size: AWS_HTTP_MAX_REQUEST_BYTES });
		expect(
			(
				await ingress(
					post(stream(new Uint8Array(AWS_HTTP_MAX_REQUEST_BYTES + 1))),
				)
			).status,
		).toBe(413);
		expect(
			(
				await ingress(
					post(stream(new Uint8Array(1)), { "content-length": "2" }),
				)
			).status,
		).toBe(400);
		expect(
			(
				await ingress(
					post(stream(new Uint8Array(1)), {
						"content-length": String(AWS_HTTP_MAX_REQUEST_BYTES + 1),
					}),
				)
			).status,
		).toBe(413);
		expect(calls).toBe(1);
	});
	it("rejects a stream with too many chunks even when they are empty", async () => {
		let remaining = AWS_HTTP_MAX_REQUEST_CHUNKS + 1;
		let calls = 0;
		const ingress = createAwsIngressHandler({
			fetch: async () => {
				calls++;
				return new Response("ok");
			},
		});
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (remaining-- > 0) controller.enqueue(new Uint8Array());
				else controller.close();
			},
		});
		expect((await ingress(post(body))).status).toBe(413);
		expect(calls).toBe(0);
	});
	it("enforces the deadline when application code replaces Promise.race", async () => {
		let timeout: (() => void) | undefined;
		const originalRace = Promise.race;
		const ingress = createAwsIngressHandler(
			{
				fetch: () => {
					// SAFETY: the original intrinsic is restored immediately after starting the request.
					Promise.race = () => new Promise(() => {});
					return new Promise(() => {});
				},
			},
			{
				schedule(callback) {
					timeout = callback;
					return () => {};
				},
			},
		);
		let result: Promise<Response>;
		try {
			result = ingress(new Request("https://app.test/"));
		} finally {
			Promise.race = originalRace;
		}
		timeout?.();
		expect((await result).status).toBe(408);
	});
	it("does not turn capacity rejection into success when array prototypes change", async () => {
		let finish: ((response: Response) => void) | undefined;
		const pendingSource = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		const ingress = createAwsIngressHandler(
			{ fetch: () => pendingSource },
			{ schedule: () => () => {} },
		);
		const pending = Array.from({ length: AWS_HTTP_MAX_INGRESS }, () =>
			ingress(new Request("https://app.test/")),
		);
		const extra = new Request("https://app.test/");
		const iterator = Array.prototype[Symbol.iterator];
		const push = Array.prototype.push;
		let response: Promise<Response>;
		try {
			Reflect.set(Array.prototype, Symbol.iterator, function* () {});
			Reflect.set(Array.prototype, "push", () => 0);
			response = ingress(extra);
		} finally {
			Reflect.set(Array.prototype, Symbol.iterator, iterator);
			Reflect.set(Array.prototype, "push", push);
		}
		expect((await response).status).toBe(503);
		finish?.(new Response("ok"));
		await Promise.all(pending);
	});
	it("keeps its returned promise observable when application code replaces then", async () => {
		let timeout: (() => void) | undefined;
		let intercepted = 0;
		const originalThen = Promise.prototype.then;
		const ingress = createAwsIngressHandler(
			{
				fetch: () => {
					// SAFETY: the original intrinsic is restored before this test awaits.
					Reflect.set(Promise.prototype, "then", () => {
						intercepted++;
						return new Promise(() => {});
					});
					return new Promise(() => {});
				},
			},
			{
				schedule(callback) {
					timeout = callback;
					return () => {};
				},
			},
		);
		let observed: Promise<number>;
		try {
			observed = ingress(new Request("https://app.test/")).then(
				(response) => response.status,
			);
		} finally {
			Reflect.set(Promise.prototype, "then", originalThen);
		}
		timeout?.();
		expect(await observed).toBe(408);
		expect(intercepted).toBe(0);
	});
	it("retains each timed-out slot until its read cancellation settles", async () => {
		let finishCancellation: (() => void) | undefined;
		const canceled = new Promise<void>((resolve) => {
			finishCancellation = resolve;
		});
		const timers: (() => void)[] = [];
		let calls = 0;
		const ingress = createAwsIngressHandler(
			{
				fetch: async () => {
					calls++;
					return new Response("ok");
				},
			},
			{
				schedule(callback, delay) {
					expect(delay).toBe(AWS_HTTP_INGRESS_DEADLINE_MS);
					timers.push(callback);
					return () => {};
				},
			},
		);
		const pending = Array.from({ length: AWS_HTTP_MAX_INGRESS }, () =>
			ingress(post(new ReadableStream({ cancel: () => canceled }))),
		);
		for (const timer of timers) timer();
		expect(
			(await Promise.all(pending)).every((response) => response.status === 408),
		).toBe(true);
		expect((await ingress(new Request("https://app.test/"))).status).toBe(503);
		expect(calls).toBe(0);
		finishCancellation?.();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect((await ingress(new Request("https://app.test/"))).status).toBe(200);
		expect(calls).toBe(1);
	});
});
