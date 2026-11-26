import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHostedRelayRuntime } from "../src/hosted-runtime.js";
import { createRelayHandler } from "../src/http-handler.js";
import { signIngressForward } from "../src/ingress-forward.js";
import { createNodeRelayHandler } from "../src/node-http.js";
import { harness, SECRET } from "./fixtures.js";

const ListenAddress = z.object({
	address: z.string(),
	family: z.string(),
	port: z.number().int().positive(),
});

function listenPort(
	address: ReturnType<ReturnType<typeof createServer>["address"]>,
): number {
	return ListenAddress.parse(address).port;
}

/** The relay behind its HTTP handler and Node adapter, as a host serves it. */
function relayServer(ingressForwardSecret?: string) {
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
				ingressForwardSecret,
			}),
		}),
	);
	return { h, server };
}

describe("relay ingress forward intake", () => {
	it("accepts x-hobo-ingress-forward without github signature", async () => {
		const ingressSecret = "ingress-forward-secret-32-characters!!";
		const { h, server } = relayServer(ingressSecret);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		const port = listenPort(address);
		const body = Buffer.from(
			JSON.stringify({
				action: "queued",
				installation: { id: 1 },
				repository: { id: 1, full_name: "acme/repo" },
				workflow_job: { id: 99, run_id: 1, labels: ["hobo"] },
			}),
		);
		const forward = signIngressForward(ingressSecret, body);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/github/webhooks`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-github-event": "workflow_job",
					// The ingress passes GitHub's delivery id through with the body.
					"x-github-delivery": "forwarded-delivery-1",
					"x-hobo-ingress-forward": forward,
				},
				body,
			});
			expect(response.status).toBe(202);
			// The forward authenticated the bytes; the repository has no connection.
			expect(await response.json()).toEqual({ status: "ignored" });
			expect(await h.ledger.hasWebhook("forwarded-delivery-1")).toBe(true);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("still requires github signature without ingress forward header", async () => {
		const { server } = relayServer();
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		const port = listenPort(address);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/github/webhooks`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-github-event": "workflow_job",
				},
				body: "{}",
			});
			expect(response.status).toBe(401);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
		expect(SECRET.length).toBeGreaterThan(31);
	});
});
