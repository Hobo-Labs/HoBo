import { once } from "node:events";
import { createServer, request } from "node:http";
import { createNodeRelayHandler } from "@hobo/ci-gh-actions";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { streamsBody } from "../src/relay-streams.js";
import { createSandboxProxyQuotaHandler } from "../src/sandbox-proxy-quota.js";

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
			streams: streamsBody,
		}),
	);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return z.object({ port: z.number().int().positive() }).parse(server.address())
		.port;
}

it("streams only the sandbox and queue paths of this host", () => {
	for (const path of [
		"/sandbox/egress",
		"/sandbox/egress/artifact",
		"/internal/sandbox/quota",
		"/internal/queue-wakeup",
	])
		expect(streamsBody(path)).toBe(true);
	for (const path of [
		"/github/webhooks",
		"/sandbox/egressive",
		"/internal/tick",
		"/v1/accounts/self/policy",
	])
		expect(streamsBody(path)).toBe(false);
});

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

it("rejects an unauthenticated quota upload without waiting for its body", async () => {
	const reserve = vi.fn(async () => true);
	const handle = createSandboxProxyQuotaHandler({
		authenticateSandboxProxy: async () => undefined,
		reserveSandboxProxyEgress: reserve,
	});
	const port = await listen(handle);
	const status = await new Promise<number>((resolve, reject) => {
		const client = request(
			{
				host: "127.0.0.1",
				port,
				path: "/internal/sandbox/quota",
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
	expect(reserve).not.toHaveBeenCalled();
});
