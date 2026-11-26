import { describe, expect, it } from "vitest";
import { requestBounded } from "../src/http.js";

describe("bounded HTTP response bodies", () => {
	it("aborts a stalled response after headers and cancels its body", async () => {
		let cancelled = false;
		let signal: AbortSignal | null | undefined;
		const fetchImpl: typeof fetch = async (_input, init) => {
			signal = init?.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"partial":'));
					},
					cancel() {
						cancelled = true;
					},
				}),
			);
		};
		await expect(
			requestBounded(
				{ fetchImpl, timeoutMs: 30 },
				"https://example.test/metadata",
			),
		).rejects.toMatchObject({ code: "AUTHMD_DISCOVERY_FAILED" });
		expect(signal?.aborted).toBe(true);
		expect(cancelled).toBe(true);
	});

	it("consumes successful multi-chunk bodies before clearing the deadline", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"ok":'));
						controller.enqueue(new TextEncoder().encode("true}"));
						controller.close();
					},
				}),
			);
		await expect(
			requestBounded({ fetchImpl }, "https://example.test/metadata"),
		).resolves.toMatchObject({ body: '{"ok":true}' });
	});
});
