import { once } from "node:events";
import { createServer } from "node:http";
import { QueueClient } from "@vercel/queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerQueueConsumer, retryQueueWakeup } from "../src/entry.js";
import { forwardQueueWakeup } from "../src/queue-forwarding.js";

const origin = "https://hobo.example";
const secret = "x".repeat(43);

type QueueCall = { method: string; path: string; body: string };
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const server of servers.splice(0))
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
});

/**
 * The installed `@vercel/queue` client against a local stand-in for the queue
 * service, which records what the client asks of it. The callback is the
 * production one in miniature: forward the wakeup to a relay that answers
 * `relay()`, with the consumer's real `retry` policy.
 */
async function deliver(relay: () => Response, deliveryCount: number) {
	const calls: QueueCall[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			calls.push({
				method: request.method ?? "",
				path: request.url ?? "",
				body: Buffer.concat(chunks).toString("utf8"),
			});
			response.writeHead(200, { "content-type": "application/json" }).end("{}");
		});
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = z.object({ port: z.number() }).parse(server.address());
	const client = new QueueClient({
		region: "iad1",
		token: "queue-test-token",
		deploymentId: "dpl_test",
		resolveBaseUrl: () => new URL(`http://127.0.0.1:${port}`),
	});
	const forwarded = vi.fn(async () => relay());
	const callback = client.handleCallback(
		async (message) => {
			await forwardQueueWakeup({ origin, secret, message, fetch: forwarded });
		},
		{ retry: retryQueueWakeup },
	);
	const response = await callback(
		new Request("https://hobo.example/api/queue", {
			method: "POST",
			headers: {
				"ce-type": "com.vercel.queue.v2beta",
				"ce-vqsqueuename": "hobo-ci",
				"ce-vqsconsumergroup": "api_queue",
				"ce-vqsmessageid": "message-1",
				"ce-vqsreceipthandle": "receipt-1",
				"ce-vqsdeliverycount": String(deliveryCount),
				"ce-vqscreatedat": new Date().toISOString(),
				"ce-vqsexpiresat": new Date(Date.now() + 3_600_000).toISOString(),
				"ce-vqsregion": "iad1",
				"content-type": "application/json",
			},
			body: JSON.stringify({ deliveryId: "delivery-1" }),
		}),
	);
	return {
		status: response.status,
		calls,
		forwards: forwarded.mock.calls.length,
	};
}

const lease = "/api/v3/topic/hobo-ci/consumer/api_queue/lease/receipt-1";

describe("queue consumer redelivery", () => {
	it("has the queue hold a wakeup for the relay's stated Retry-After instead of redelivering at once", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const held = await deliver(
			() =>
				new Response("private-response-body", {
					status: 503,
					headers: { "retry-after": "45" },
				}),
			1,
		);
		// One request to the relay; then the lease is moved out by 45 s, and the
		// callback itself answers 200: nothing is thrown back at the queue.
		expect(held.forwards).toBe(1);
		expect(held.calls).toEqual([
			{
				method: "PATCH",
				path: lease,
				body: JSON.stringify({ visibilityTimeoutSeconds: 45 }),
			},
		]);
		expect(held.status).toBe(200);
		// The rescheduled failure is still reported, by status, without secrets.
		const line = String(log.mock.calls[0]?.[0]);
		expect(JSON.parse(line)).toMatchObject({
			event: "hobo_ci_queue_handoff_deferred",
			status: 503,
			afterSeconds: 45,
			deliveryCount: 1,
			error: "QueueHandoffError",
			message: "queue handoff failed: status 503, retry-after 45s",
		});
		expect(line).not.toContain(secret);
		expect(line).not.toContain("private-response-body");
	});

	it("backs off by delivery count when the relay keeps saying five seconds, capped at five minutes", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const relay = () =>
			new Response(null, { status: 503, headers: { "retry-after": "5" } });
		const waits: number[] = [];
		for (const deliveryCount of [1, 2, 4, 7, 40]) {
			const { calls } = await deliver(relay, deliveryCount);
			waits.push(
				z
					.object({ visibilityTimeoutSeconds: z.number() })
					.parse(JSON.parse(calls[0]?.body ?? "{}")).visibilityTimeoutSeconds,
			);
		}
		expect(waits).toEqual([5, 10, 40, 300, 300]);
	});

	it("fails fast on any other status: no reschedule, and the queue's default redelivery applies", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		for (const status of [403, 500]) {
			const failed = await deliver(
				() => new Response(null, { status, headers: { "retry-after": "45" } }),
				1,
			);
			expect(failed.forwards).toBe(1);
			expect(failed.calls.filter((call) => call.method === "PATCH")).toEqual(
				[],
			);
			expect(failed.status).toBe(500);
		}
	});

	it("acknowledges a wakeup the relay took", async () => {
		const taken = await deliver(() => new Response(null, { status: 204 }), 1);
		expect(taken.status).toBe(200);
		expect(taken.calls).toEqual([{ method: "DELETE", path: lease, body: "" }]);
	});

	it("registers the production consumer with that policy", () => {
		const real = new QueueClient({
			region: "iad1",
			token: "queue-test-token",
			deploymentId: "dpl_test",
		});
		const registered: Parameters<QueueClient["handleNodeCallback"]>[1][] = [];
		const consumer = registerQueueConsumer({
			handleNodeCallback: (handler, options) => {
				registered.push(options);
				return real.handleNodeCallback(handler, options);
			},
		});
		expect(registered).toEqual([{ retry: retryQueueWakeup }]);
		expect(consumer).toBeTypeOf("function");
	});
});
