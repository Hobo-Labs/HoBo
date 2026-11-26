import { describe, expect, it } from "vitest";
import { createBoundedFetchTransport } from "../src/ports/fetch-http-transport.js";
import type { TransportRequest } from "../src/ports/http-transport.js";

const request: TransportRequest = {
	method: "GET",
	url: "https://api.example.test/v1/resource",
	headers: {},
	timeoutMs: 100,
	maxResponseBytes: 10,
};

describe("bounded WHATWG provider transport", () => {
	it("measures bytes across chunk boundaries and preserves multibyte UTF-8", async () => {
		const bytes = new TextEncoder().encode("é12345678");
		const transport = createBoundedFetchTransport({
			fetchImpl: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(bytes.slice(0, 1));
							controller.enqueue(bytes.slice(1));
							controller.close();
						},
					}),
				),
		});
		expect((await transport(request)).body).toBe("é12345678");
	});
	it("cancels an oversized stream before reading its unbounded remainder", async () => {
		let cancelled = false;
		let pulls = 0;
		const transport = createBoundedFetchTransport({
			fetchImpl: async () =>
				new Response(
					new ReadableStream({
						pull(controller) {
							pulls++;
							controller.enqueue(new Uint8Array(8));
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		await expect(transport(request)).rejects.toMatchObject({
			code: "TRANSPORT_BODY_TOO_LARGE",
		});
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThanOrEqual(3);
	});
	it("rejects declared oversized responses without buffering the body", async () => {
		let cancelled = false;
		const transport = createBoundedFetchTransport({
			fetchImpl: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-length": "999999" } },
				),
		});
		await expect(transport(request)).rejects.toMatchObject({
			code: "TRANSPORT_BODY_TOO_LARGE",
		});
		expect(cancelled).toBe(true);
	});
	it("enforces a deadline when fetch ignores its AbortSignal", async () => {
		let signal: AbortSignal | null | undefined;
		const transport = createBoundedFetchTransport({
			fetchImpl: async (_url, init) => {
				signal = init?.signal;
				return new Promise<Response>(() => {});
			},
		});
		await expect(transport({ ...request, timeoutMs: 5 })).rejects.toMatchObject(
			{ code: "TRANSPORT_TIMEOUT_EXCEEDED" },
		);
		expect(signal?.aborted).toBe(true);
	});
	it("bounds a stalled response body after headers arrive", async () => {
		let cancelled = false;
		const transport = createBoundedFetchTransport({
			fetchImpl: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		await expect(transport({ ...request, timeoutMs: 5 })).rejects.toMatchObject(
			{ code: "TRANSPORT_TIMEOUT_EXCEEDED" },
		);
		expect(cancelled).toBe(true);
	});
	it("never follows redirects and sends body only when declared", async () => {
		let init: RequestInit | undefined;
		const transport = createBoundedFetchTransport({
			fetchImpl: async (_url, seen) => {
				init = seen;
				return new Response(null, { status: 204 });
			},
		});
		expect(await transport(request)).toMatchObject({ status: 204, body: "" });
		expect(init?.redirect).toBe("manual");
		expect(init && Object.hasOwn(init, "body")).toBe(false);
	});
	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		0.5,
	])("refuses invalid bounds before invoking fetch: %s", async (value) => {
		let calls = 0;
		const transport = createBoundedFetchTransport({
			fetchImpl: async () => {
				calls++;
				return new Response("");
			},
		});
		await expect(
			transport({ ...request, timeoutMs: value }),
		).rejects.toMatchObject({ code: "TRANSPORT_TIMEOUT_EXCEEDED" });
		await expect(
			transport({ ...request, maxResponseBytes: value }),
		).rejects.toMatchObject({ code: "TRANSPORT_BODY_TOO_LARGE" });
		expect(calls).toBe(0);
	});
	it("refuses invalid UTF-8 bytes instead of turning them into an approved replacement character", async () => {
		let cancelled = false;
		const transport = createBoundedFetchTransport({
			fetchImpl: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array([0xff]));
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		await expect(transport(request)).rejects.toThrow(
			/encoded data|encoding|UTF-8/iu,
		);
		expect(cancelled).toBe(true);
	});
	it("preserves an observed UTF-8 BOM so content proof cannot normalize it away", async () => {
		const transport = createBoundedFetchTransport({
			fetchImpl: async () =>
				new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])),
		});
		expect((await transport(request)).body).toBe("\uFEFFa");
	});
	it("refuses a truncated multibyte sequence when the response stream ends", async () => {
		const transport = createBoundedFetchTransport({
			fetchImpl: async () => new Response(new Uint8Array([0xe2, 0x82])),
		});
		await expect(transport(request)).rejects.toThrow(
			/encoded data|encoding|UTF-8/iu,
		);
	});
});
