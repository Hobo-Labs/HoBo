import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { z } from "zod";
import { createRelayHandler } from "../src/http-handler.js";
import { createNodeRelayHandler } from "../src/node-http.js";

it("executes every declared GitHub and client interaction over the Node HTTP boundary", async () => {
	// SAFETY: this is a test-only, hand-authored Pact fixture; response bodies
	// are compared against actual HTTP output and every interaction is consumed.
	const pact = JSON.parse(
		readFileSync(new URL("./http-boundary.pact.json", import.meta.url), "utf8"),
	) as {
		consumer: { name: string };
		provider: { name: string };
		interactions: {
			request: {
				method: string;
				path: string;
				headers: Record<string, string>;
				body?: string;
			};
			response: { status: number; body: object };
		}[];
	};
	expect(pact.consumer.name).toBe("GitHubActionsAndHoboCiClient");
	expect(pact.provider.name).toBe("HoboCiRelayHttp");
	expect(pact.interactions).toHaveLength(6);
	let persisted = 0;
	let claims = 0;
	const handle = createRelayHandler({
		webhookSecret: "a-webhook-test-secret-with-32-bytes",
		application: {
			async ingestWebhook(input) {
				expect(input.deliveryId).toBe("delivery-1");
				expect(Buffer.from(input.rawBody).toString()).toBe(
					'{"workflow_job":{}}\n',
				);
				return persisted++ === 0 ? "accepted" : "duplicate";
			},
			async claim(id, oidc) {
				expect(id).toBe("01234567-89ab-4cde-8fab-0123456789ab");
				expect(oidc).toBe("contract-oidc");
				claims++;
				return Response.json({ encodedJitConfig: "dGVzdA==" });
			},
			async control() {
				return undefined;
			},
			async ready() {
				return true;
			},
		},
	});
	const server = createServer(
		createNodeRelayHandler({ origin: "https://ci.example.test", handle }),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = z
			.object({ port: z.number().int().positive() })
			.parse(server.address());
		let matched = 0;
		for (const interaction of pact.interactions) {
			const request: RequestInit = {
				method: interaction.request.method,
				headers: interaction.request.headers,
			};
			if (interaction.request.body !== undefined)
				request.body = interaction.request.body;
			const response = await fetch(
				`http://127.0.0.1:${port}${interaction.request.path}`,
				request,
			);
			expect(response.status).toBe(interaction.response.status);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.json()).toEqual(interaction.response.body);
			matched++;
		}
		expect(matched).toBe(6);
		expect(persisted).toBe(2);
		expect(claims).toBe(1);
	} finally {
		server.close();
		await once(server, "close");
	}
});
