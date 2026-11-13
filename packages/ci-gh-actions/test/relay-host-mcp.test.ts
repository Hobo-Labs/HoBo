import { randomBytes } from "node:crypto";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { relayInstallAssets } from "../src/assets.js";
import { createRelayHost } from "../src/relay-host.js";
import { config, job, NOW, SECRET } from "./fixtures.js";

const stops: Array<() => Promise<{ drained: boolean }>> = [];
afterEach(async () => {
	await Promise.all(stops.splice(0).map((stop) => stop()));
});

it("serves MCP sessions from the Node host and ends their streams when it drains", async () => {
	const store = new SqliteCiStore(":memory:");
	const { revision } = await store.configure(config(), 0, NOW);
	const authorization = `Bearer ${randomBytes(24).toString("base64url")}`;
	const { service } = createRelayHost({
		store,
		github: {
			appRequest: async () => new Response(null, { status: 500 }),
			request: async () => new Response(null, { status: 500 }),
		},
		identity: {
			verify: async () => {
				throw new Error("unexpected runner identity request");
			},
		},
		webhookSecret: SECRET,
		authenticate: (presented) =>
			presented === authorization
				? {
						accountId: "account-a",
						installationIds: [10],
						scopes: ["policy:read"],
					}
				: undefined,
		publicOrigin: "https://relay.example",
		assets: relayInstallAssets(),
		port: 0,
		// The worker is not under test: one pass at start, then none.
		tickIntervalMs: 600_000,
		drainTimeoutMs: 20_000,
	});
	stops.push(() => service.stop());
	await service.start();
	const { port } = z
		.object({ port: z.number() })
		.parse(service.server.address());
	const endpoint = new URL(`http://127.0.0.1:${port}/engines/gh-actions/mcp`);

	const refused = await fetch(endpoint, { method: "POST" });
	expect(refused.status).toBe(401);
	expect(refused.headers.get("www-authenticate")).toBe("Bearer");

	const client = new Client({ name: "relay-host-mcp", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(endpoint, {
			requestInit: { headers: { authorization } },
		}),
	);
	// This host outlives a request: it keeps sessions and pushes updates.
	expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
	const updated = new Promise<string>((resolve) => {
		client.setNotificationHandler(
			ResourceUpdatedNotificationSchema,
			(notification) => resolve(notification.params.uri),
		);
	});
	await client.subscribeResource({ uri: "hobo-ci://events" });
	await store.queue(job(1), NOW, revision);
	expect(await updated).toBe("hobo-ci://events");

	// The session's event stream is still open. The drain ends it instead of
	// waiting out its timeout for a last byte that never comes.
	const started = Date.now();
	expect(await service.stop()).toEqual({ drained: true });
	expect(Date.now() - started).toBeLessThan(10_000);
	await client.close().catch(() => undefined);
});
