import { once } from "node:events";
import { createServer, request } from "node:http";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
	createNodeRelayHandler,
	unavailableRetryAfterSeconds,
} from "../src/node-http.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0))
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
});
async function listen(handle: (request: Request) => Promise<Response>) {
	const server = createServer(
		createNodeRelayHandler({
			origin: "https://relay.example.test",
			handle,
			streams: (pathname) => pathname.startsWith("/sandbox/egress/"),
		}),
	);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return z.object({ port: z.number().int().positive() }).parse(server.address())
		.port;
}
it("streams sandbox requests and responses beyond the ordinary relay's 1 MiB limit", async () => {
	const port = await listen(async (incoming) => {
		expect(new URL(incoming.url).pathname).toBe("/sandbox/egress/artifact");
		const bytes = await incoming.arrayBuffer();
		return new Response(new Uint8Array(bytes));
	});
	const body = new Uint8Array(2 * 1024 * 1024).fill(7);
	const response = await fetch(
		`http://127.0.0.1:${port}/sandbox/egress/artifact`,
		{ method: "POST", body },
	);
	expect(response.status).toBe(200);
	const received = new Uint8Array(await response.arrayBuffer());
	expect(received.byteLength).toBe(body.byteLength);
	expect(received[received.length - 1]).toBe(7);
});
it("does not read an untrusted upload before the handler rejects it", async () => {
	let consumed = false;
	const port = await listen(async (incoming) => {
		consumed = incoming.bodyUsed;
		return new Response(null, { status: 403 });
	});
	const status = await new Promise<number>((resolve, reject) => {
		const client = request(
			{
				host: "127.0.0.1",
				port,
				path: "/sandbox/egress/upload",
				method: "POST",
				headers: { "content-length": 100_000_000 },
			},
			(response) => {
				resolve(response.statusCode ?? 0);
				response.resume();
				client.destroy();
			},
		);
		client.on("error", (error) => {
			if (!client.destroyed) reject(error);
		});
		client.write(Buffer.alloc(1024));
	});
	expect(status).toBe(403);
	expect(consumed).toBe(false);
});

it("holds every other path to the 1 MiB body limit", async () => {
	let reached = false;
	const port = await listen(async () => {
		reached = true;
		return new Response(null, { status: 204 });
	});
	const response = await fetch(`http://127.0.0.1:${port}/github/webhooks`, {
		method: "POST",
		body: new Uint8Array(2 * 1024 * 1024),
	}).catch(() => undefined);
	// The adapter answers 413 and may close the socket before the upload ends.
	expect(response?.status ?? 413).toBe(413);
	expect(reached).toBe(false);
});

it("serves plain HTTP only for an explicitly allowed loopback origin", () => {
	const handle = async () => new Response(null, { status: 204 });
	expect(() =>
		createNodeRelayHandler({ origin: "http://127.0.0.1:8787", handle }),
	).toThrow("relay origin must be an HTTPS origin");
	expect(() =>
		createNodeRelayHandler({
			origin: "http://relay.example.test",
			handle,
			allowLoopbackHttp: true,
		}),
	).toThrow("relay origin must be an HTTPS origin");
	expect(() =>
		createNodeRelayHandler({
			origin: "http://127.0.0.1:8787",
			handle,
			allowLoopbackHttp: true,
		}),
	).not.toThrow();
});

it("answers a failed request with 503 and the Retry-After its error states", async () => {
	// The store back-off's error: it knows when the store will be tried again.
	class StoreUnavailable extends Error {
		constructor(readonly retryAfterMs: number) {
			super("store unavailable; not retried yet");
		}
	}
	let failure: Error = new Error("anything else");
	const port = await listen(async () => {
		throw failure;
	});
	// Both the buffered path and the streamed one end in the same answer.
	for (const path of ["/internal/queue-wakeup", "/sandbox/egress/artifact"]) {
		failure = new Error("anything else");
		const fallback = await fetch(`http://127.0.0.1:${port}${path}`);
		expect(fallback.status).toBe(503);
		expect(fallback.headers.get("retry-after")).toBe("5");
		expect(await fallback.text()).toBe('{"error":"service unavailable"}');

		failure = new StoreUnavailable(39_001);
		const stated = await fetch(`http://127.0.0.1:${port}${path}`);
		expect(stated.status).toBe(503);
		expect(stated.headers.get("retry-after")).toBe("40");
		expect(stated.headers.get("cache-control")).toBe("no-store");
		// The error's text never reaches the caller.
		expect(await stated.text()).toBe('{"error":"service unavailable"}');
	}
});

it("states a Retry-After of 1 to 300 whole seconds, and 5 when the error says nothing usable", () => {
	const hinted = (retryAfterMs: number | string | undefined) =>
		unavailableRetryAfterSeconds(
			Object.assign(new Error("unavailable"), { retryAfterMs }),
		);
	expect(unavailableRetryAfterSeconds(undefined)).toBe(5);
	expect(unavailableRetryAfterSeconds(new Error("plain"))).toBe(5);
	expect(hinted(1)).toBe(1);
	expect(hinted(5_000)).toBe(5);
	expect(hinted(60_000)).toBe(60);
	expect(hinted(3_600_000)).toBe(300);
	for (const unusable of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
		expect(hinted(unusable)).toBe(5);
	expect(hinted("soon")).toBe(5);
	expect(hinted(undefined)).toBe(5);
});
