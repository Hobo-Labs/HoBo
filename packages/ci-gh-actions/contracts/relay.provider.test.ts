import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { z } from "zod";
import { createHostedRelayRuntime } from "../src/hosted-runtime.js";
import { createRelayHandler } from "../src/http-handler.js";
import { createNodeRelayHandler } from "../src/node-http.js";
import { harness, SECRET } from "../test/fixtures.js";

const Pact = z.object({
	interactions: z.array(
		z.object({
			description: z.string(),
			request: z.object({
				method: z.string(),
				path: z.string(),
				headers: z.record(z.string(), z.string()).optional(),
				body: z.json().optional(),
			}),
			response: z.object({ status: z.number(), body: z.json() }),
		}),
	),
});
it("verifies every relay HTTP pact interaction against simulated dependencies", async () => {
	const h = harness();
	const runtime = createHostedRelayRuntime({
		store: h.ledger,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => h.clock.now,
	});
	const server = createServer(
		createNodeRelayHandler({
			origin: "https://relay.example",
			handle: createRelayHandler({
				application: runtime,
				webhookSecret: SECRET,
			}),
		}),
	);
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = z.object({ port: z.number() }).parse(server.address());
	const base = `http://127.0.0.1:${address.port}`;
	try {
		const pact = Pact.parse(
			JSON.parse(
				readFileSync(
					new URL("./relay-boundary.pact.json", import.meta.url),
					"utf8",
				),
			),
		);
		expect(pact.interactions).toHaveLength(5);
		for (const interaction of pact.interactions) {
			const init: RequestInit = {
				method: interaction.request.method,
				headers: interaction.request.headers ?? {},
			};
			if (interaction.request.body !== undefined)
				init.body = JSON.stringify(interaction.request.body);
			const response = await fetch(`${base}${interaction.request.path}`, init);
			expect(response.status, interaction.description).toBe(
				interaction.response.status,
			);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.json()).toEqual(interaction.response.body);
		}
		// The signed delivery was committed; the worker tick reserves it and
		// dispatches its host. The provider fixture records the lease it is sent.
		expect(h.store.all()).toEqual([]);
		h.api.strictLeaseId = false;
		await runtime.tick();
		const lease = h.store.all()[0];
		if (!lease) throw new Error("missing reserved lease");
		expect(lease.state).toBe("dispatched");
		expect(h.api.leaseId).toBe(lease.id);
		expect(h.api.dispatches).toBe(1);
		h.api.host.display_title = `HoBo lease ${lease.id}`;
		const claimUrl = `${base}/v1/leases/${lease.id}/jit`;
		expect((await fetch(claimUrl, { method: "POST" })).status).toBe(403);
		const result = await fetch(claimUrl, {
			method: "POST",
			headers: { Authorization: "Bearer valid" },
		});
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({ encodedJitConfig: "c2VjcmV0" });
		expect(
			(
				await fetch(claimUrl, {
					method: "POST",
					headers: { Authorization: "Bearer valid" },
				})
			).status,
		).toBe(403);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		h.store.close();
	}
});
