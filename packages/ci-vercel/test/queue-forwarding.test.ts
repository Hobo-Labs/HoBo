import { describe, expect, it, vi } from "vitest";
import {
	createQueueWakeupHandler,
	forwardQueueWakeup,
	normalizeQueueWakeup,
	QueueHandoffError,
	queueRedeliveryDelaySeconds,
	redeliverRefusedWakeup,
} from "../src/queue-forwarding.js";
import { StoreUnavailable } from "../src/store-unavailable.js";

const origin = "https://hobo.example";
const secret = "x".repeat(43);
const delivery = (deliveryCount: number) => ({
	messageId: "message-1",
	deliveryCount,
	createdAt: new Date(0),
	expiresAt: new Date(3_600_000),
	topicName: "hobo-ci",
	consumerGroup: "api_queue",
	region: "iad1",
});
/** The handoff's failure against a relay that answers `response` to every wakeup. */
async function refused(
	response: () => Response,
	now?: () => number,
): Promise<{ error: QueueHandoffError; requests: number }> {
	const send = vi.fn(async () => response());
	const options: Parameters<typeof forwardQueueWakeup>[0] = {
		origin,
		secret,
		message: { deliveryId: "one" },
		fetch: send,
	};
	if (now) options.now = now;
	const error = await forwardQueueWakeup(options).then(
		() => undefined,
		(thrown: Error) => thrown,
	);
	if (!(error instanceof QueueHandoffError))
		throw new Error("the handoff did not fail with a QueueHandoffError");
	return { error, requests: send.mock.calls.length };
}
const wakeup = (body: string, authorization = `Bearer ${secret}`) =>
	new Request(`${origin}/internal/queue-wakeup`, {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body,
	});

describe("deployment queue handoff", () => {
	it("acknowledges a handoff only after the current worker succeeds", async () => {
		const run = vi.fn(async () => {});
		const handle = createQueueWakeupHandler({ origin, secret, run });
		const send: typeof fetch = async (input, init) =>
			handle(new Request(input, init));
		await forwardQueueWakeup({
			origin,
			secret,
			message: { deliveryId: "one" },
			fetch: send,
		});
		expect(run).toHaveBeenCalledWith({ deliveryId: "one" });
		run.mockRejectedValueOnce(new Error("worker failed"));
		await expect(
			forwardQueueWakeup({
				origin,
				secret,
				message: { deliveryId: "two" },
				fetch: send,
			}),
		).rejects.toThrow("queue handoff failed");
	});
	it("forwards only a validated, minimal wakeup to the canonical HTTPS endpoint", async () => {
		const send = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(null, { status: 204 }),
		);
		await forwardQueueWakeup({
			origin,
			secret,
			message: { deliveryId: "delivery-1", extra: "discard" },
			fetch: send,
		});
		expect(send).toHaveBeenCalledOnce();
		const [url, init] = send.mock.calls[0] ?? [];
		expect(url).toBe(`${origin}/internal/queue-wakeup`);
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			body: '{"deliveryId":"delivery-1"}',
		});
		expect(
			normalizeQueueWakeup({
				source: "static",
				name: "hobo-ci-repair",
				payload: { ignored: true },
			}),
		).toEqual({ source: "static", name: "hobo-ci-repair" });
		expect(normalizeQueueWakeup(null)).toBeNull();
		expect(() => normalizeQueueWakeup({ deliveryId: "../bad" })).toThrow();
		expect(() =>
			normalizeQueueWakeup({
				deliveryId: "a",
				source: "static",
				name: "hobo-ci-repair",
			}),
		).toThrow();
	});
	it("fails rather than acknowledging on rejection, network error or invalid origin", async () => {
		await expect(
			forwardQueueWakeup({
				origin,
				secret,
				message: null,
				fetch: async () => new Response(null, { status: 503 }),
			}),
		).rejects.toThrow("queue handoff failed");
		await expect(
			forwardQueueWakeup({
				origin,
				secret,
				message: null,
				fetch: async () => {
					throw new Error("private-token");
				},
			}),
		).rejects.toThrow("queue handoff unavailable");
		await expect(
			forwardQueueWakeup({
				origin: "https://user:pass@hobo.example",
				secret,
				message: null,
			}),
		).rejects.toThrow("invalid queue handoff origin");
	});
	it("authenticates before reading and executes only strict messages", async () => {
		const run = vi.fn(async () => {});
		const handle = createQueueWakeupHandler({ origin, secret, run });
		let pulls = 0;
		const stream = new ReadableStream(
			{
				pull() {
					pulls++;
					throw new Error("read before auth");
				},
			},
			{ highWaterMark: 0 },
		);
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: {
				authorization: "Bearer bad",
				"content-type": "application/json",
			},
			body: stream,
			duplex: "half",
		};
		const unauth = new Request(`${origin}/internal/queue-wakeup`, init);
		expect((await handle(unauth)).status).toBe(403);
		expect(pulls).toBe(0);
		expect(
			(await handle(wakeup('{"deliveryId":"one","extra":true}'))).status,
		).toBe(400);
		expect(
			(await handle(wakeup('{"source":"static","name":"hobo-ci-repair"}')))
				.status,
		).toBe(204);
		expect(run).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledWith({
			source: "static",
			name: "hobo-ci-repair",
		});
	});
	it("bounds input and returns failure when the active worker fails", async () => {
		const run = vi.fn(async () => {
			throw new Error("private-worker-secret");
		});
		const handle = createQueueWakeupHandler({ origin, secret, run });
		expect(
			(await handle(wakeup(JSON.stringify({ deliveryId: "x".repeat(5000) }))))
				.status,
		).toBe(413);
		const response = await handle(wakeup('{"deliveryId":"one"}'));
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("private-worker-secret");
	});
	it("abandons an authenticated stalled body without running work", async () => {
		vi.useFakeTimers();
		try {
			const run = vi.fn(async () => {});
			const handle = createQueueWakeupHandler({ origin, secret, run });
			const stream = new ReadableStream(
				{ pull: () => new Promise(() => {}) },
				{ highWaterMark: 0 },
			);
			const init: RequestInit & { duplex: "half" } = {
				method: "POST",
				headers: {
					authorization: `Bearer ${secret}`,
					"content-type": "application/json",
				},
				body: stream,
				duplex: "half",
			};
			const pending = handle(
				new Request(`${origin}/internal/queue-wakeup`, init),
			);
			await vi.advanceTimersByTimeAsync(5001);
			expect((await pending).status).toBe(400);
			expect(run).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("refused queue handoff", () => {
	it("names the status and the stated Retry-After, and nothing the relay or the caller holds", async () => {
		const { error } = await refused(
			() =>
				new Response("private-response-body", {
					status: 503,
					headers: { "retry-after": "35", "x-private": "private-header" },
				}),
		);
		expect(error.message).toBe(
			"queue handoff failed: status 503, retry-after 35s",
		);
		expect(error.status).toBe(503);
		expect(error.retryAfterSeconds).toBe(35);
		for (const hidden of [secret, "private-response-body", "private-header"])
			expect(
				JSON.stringify([error.message, error.stack, { ...error }]),
			).not.toContain(hidden);

		const bare = await refused(() => new Response(null, { status: 503 }));
		expect(bare.error.message).toBe("queue handoff failed: status 503");
		expect(bare.error.retryAfterSeconds).toBeUndefined();
	});

	it("reads Retry-After as seconds or an HTTP date, and never repeats a header it cannot read", async () => {
		const now = Date.UTC(2026, 10, 11, 12, 0, 0);
		const stated = async (value: string) =>
			(
				await refused(
					() =>
						new Response(null, {
							status: 503,
							headers: { "retry-after": value },
						}),
					() => now,
				)
			).error;
		expect((await stated("0")).retryAfterSeconds).toBe(0);
		expect((await stated(" 120 ")).retryAfterSeconds).toBe(120);
		expect(
			(await stated("Wed, 11 Nov 2026 12:00:40 GMT")).retryAfterSeconds,
		).toBe(40);
		// A date already past means "now", not a negative wait.
		expect(
			(await stated("Wed, 11 Nov 2026 11:59:00 GMT")).retryAfterSeconds,
		).toBe(0);
		for (const unreadable of ["soon", "-5", "1.5", "5, 10", "11 Nov 2026"]) {
			const error = await stated(unreadable);
			expect(error.retryAfterSeconds).toBeUndefined();
			expect(error.message).toBe("queue handoff failed: status 503");
		}
	});

	it("makes one request and fails at once, whatever the relay answers", async () => {
		for (const status of [200, 400, 403, 413, 415, 500, 502, 503, 504]) {
			const { error, requests } = await refused(
				() => new Response(null, { status }),
			);
			expect(requests, String(status)).toBe(1);
			expect(error.status).toBe(status);
			expect(error.message).toBe(`queue handoff failed: status ${status}`);
		}
	});

	it("tells the caller when the store will be tried again, and only then", async () => {
		const run = vi.fn(async () => {});
		const handle = createQueueWakeupHandler({ origin, secret, run });
		run.mockRejectedValueOnce(new StoreUnavailable(34_001));
		const backingOff = await handle(wakeup('{"deliveryId":"one"}'));
		expect(backingOff.status).toBe(503);
		expect(backingOff.headers.get("retry-after")).toBe("35");
		expect(backingOff.headers.get("cache-control")).toBe("no-store");
		expect(await backingOff.text()).toBe("");

		run.mockRejectedValueOnce(new StoreUnavailable(3_600_000));
		expect(
			(await handle(wakeup('{"deliveryId":"one"}'))).headers.get("retry-after"),
		).toBe("300");
		run.mockRejectedValueOnce(new StoreUnavailable(0));
		expect(
			(await handle(wakeup('{"deliveryId":"one"}'))).headers.get("retry-after"),
		).toBe("1");

		run.mockRejectedValueOnce(new Error("worker failed"));
		const failed = await handle(wakeup('{"deliveryId":"one"}'));
		expect(failed.status).toBe(503);
		expect(failed.headers.has("retry-after")).toBe(false);

		// End to end: the forwarder's error carries what the handler stated.
		run.mockRejectedValueOnce(new StoreUnavailable(20_000));
		const send: typeof fetch = async (input, init) =>
			handle(new Request(input, init));
		await expect(
			forwardQueueWakeup({
				origin,
				secret,
				message: { deliveryId: "two" },
				fetch: send,
			}),
		).rejects.toThrow("queue handoff failed: status 503, retry-after 20s");
	});
});

describe("queue redelivery after a refused wakeup", () => {
	it("waits at least the stated delay, doubles from 5 s per delivery, and never past five minutes", () => {
		const wait = (deliveryCount: number, retryAfterSeconds?: number) =>
			queueRedeliveryDelaySeconds({ deliveryCount, retryAfterSeconds });
		// No stated delay: 5 s doubling with each delivery of the message.
		expect([1, 2, 3, 4, 5, 6, 7, 8, 500].map((count) => wait(count))).toEqual([
			5, 10, 20, 40, 80, 160, 300, 300, 300,
		]);
		// The relay's statement is a floor, not a replacement for the doubling:
		// "come back in 5" on the sixth delivery is still 160 s.
		expect(wait(1, 35)).toBe(35);
		expect(wait(1, 34.2)).toBe(35);
		expect(wait(6, 5)).toBe(160);
		expect(wait(2, 60)).toBe(60);
		expect(wait(1, 86_400)).toBe(300);
		// A delivery count the queue did not supply is treated as the first.
		for (const count of [0, -3, 1.5, Number.NaN])
			expect(wait(count), String(count)).toBe(5);
		// Nothing usable stated: the doubling alone decides.
		for (const stated of [0, -10, Number.NaN, Number.POSITIVE_INFINITY])
			expect(wait(1, stated), String(stated)).toBe(5);
	});

	it("reschedules a 503 or a store in back-off, and lets every other failure propagate", () => {
		expect(
			redeliverRefusedWakeup(new QueueHandoffError(503, 45), delivery(1)),
		).toEqual({ afterSeconds: 45 });
		expect(
			redeliverRefusedWakeup(
				new QueueHandoffError(503, undefined),
				delivery(3),
			),
		).toEqual({ afterSeconds: 20 });
		// A preview deployment runs the worker in the callback itself.
		expect(
			redeliverRefusedWakeup(new StoreUnavailable(59_001), delivery(1)),
		).toEqual({ afterSeconds: 60 });
		// Fail fast: no directive, so the queue client rethrows.
		for (const status of [400, 403, 404, 413, 429, 500, 502, 504])
			expect(
				redeliverRefusedWakeup(new QueueHandoffError(status, 30), delivery(1)),
				String(status),
			).toBeUndefined();
		for (const other of [
			new Error("queue handoff unavailable"),
			new Error("queue handoff configuration unavailable"),
			new TypeError("fetch failed"),
			"queue handoff failed: status 503",
			undefined,
			null,
		])
			expect(redeliverRefusedWakeup(other, delivery(1))).toBeUndefined();
	});
});
