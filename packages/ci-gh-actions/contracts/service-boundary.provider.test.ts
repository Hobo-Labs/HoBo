import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { createRelayHandler } from "../src/http-handler.js";
import { admitWhenReady, createRelayService } from "../src/service.js";
import { SECRET } from "../test/fixtures.js";

const Pact = z.object({
	interactions: z.array(
		z.object({
			description: z.string(),
			providerStates: z.array(
				z.object({
					name: z.enum([
						"provider readiness unavailable",
						"provider readiness available",
					]),
				}),
			),
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

it("verifies service readiness Pact over actual loopback HTTP with injected dependencies", async () => {
	const pact = Pact.parse(
		JSON.parse(
			readFileSync(
				new URL("./service-boundary.pact.json", import.meta.url),
				"utf8",
			),
		),
	);
	expect(pact.interactions).toHaveLength(4);
	let available = false;
	let admitted = 0;
	const service = createRelayService({
		origin: "https://relay.example",
		handle: (ready) =>
			createRelayHandler({
				application: admitWhenReady(
					{
						async ingestWebhook() {
							admitted++;
							return "accepted";
						},
						claim: async () => new Response(null, { status: 204 }),
						control: async () => undefined,
						ready: async () => true,
					},
					ready,
				),
				webhookSecret: SECRET,
			}),
		tick: async () => {},
		close: () => {},
		host: "127.0.0.1",
		port: 0,
		readinessProbe: async () => available,
	});
	try {
		await service.start();
		const address = z
			.object({ port: z.number() })
			.parse(service.server.address());
		for (const interaction of pact.interactions) {
			available =
				interaction.providerStates[0]?.name === "provider readiness available";
			await service.checkReadiness();
			const init: RequestInit = {
				method: interaction.request.method,
				headers: interaction.request.headers ?? {},
			};
			if (interaction.request.body !== undefined)
				init.body = JSON.stringify(interaction.request.body);
			const response = await fetch(
				`http://127.0.0.1:${address.port}${interaction.request.path}`,
				init,
			);
			expect(response.status, interaction.description).toBe(
				interaction.response.status,
			);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("content-type")).toContain(
				"application/json",
			);
			expect(await response.json()).toEqual(interaction.response.body);
		}
		// The refused delivery was authentic; it was never handed to the relay.
		expect(admitted).toBe(0);
	} finally {
		await service.stop();
	}
});
