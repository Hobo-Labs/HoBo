import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRelaySetupMcp } from "@hobo/ci-gh-actions";
import { expect, it } from "vitest";
import { z } from "zod";
import { createHttpEntry, relaySetupGaps } from "../src/entry.js";
import { RelayRuntimeConfigError } from "../src/relay-runtime-config.js";
import {
	acceptRelaySetupValue,
	RELAY_SETUP_ENTRIES,
} from "../src/relay-setup.js";

const pact = z
	.object({
		consumer: z.object({ name: z.literal("McpConnectorClient") }),
		provider: z.object({ name: z.literal("HoboCiRelaySetup") }),
		interactions: z.array(
			z.object({
				description: z.string(),
				request: z.object({
					method: z.enum(["GET", "POST"]),
					path: z.string(),
					headers: z.record(z.string(), z.string()),
					body: z.json().optional(),
				}),
				response: z.object({
					status: z.number(),
					headers: z.record(z.string(), z.string()),
					body: z.record(z.string(), z.json()),
				}),
			}),
		),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL("./relay-setup-mcp.pact.json", import.meta.url),
				"utf8",
			),
		),
	);

it("executes every declared setup-mode interaction over the Vercel entry", async () => {
	expect(pact.interactions).toHaveLength(4);
	const incomplete = () =>
		Promise.reject(
			new RelayRuntimeConfigError(
				"invalid relay configuration",
				["HOBO_CI_CONFIG_JSON"],
				{ missing: ["HOBO_CI_CONFIG_JSON"], invalid: [] },
			),
		);
	const mcp = createRelaySetupMcp({
		publicOrigin: "https://relay.example",
		gaps: () => relaySetupGaps(incomplete),
		entries: RELAY_SETUP_ENTRIES,
		accept: acceptRelaySetupValue,
		write: undefined,
	});
	const server = createServer(
		createHttpEntry(incomplete, {
			setup: () => ({ origin: "https://relay.example", handle: mcp.handle }),
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = z.object({ port: z.number() }).parse(server.address());
		for (const interaction of pact.interactions) {
			const { request, response } = interaction;
			const answer = await fetch(`http://127.0.0.1:${port}${request.path}`, {
				method: request.method,
				headers: request.headers,
				body:
					request.body === undefined ? undefined : JSON.stringify(request.body),
			});
			expect(answer.status, interaction.description).toBe(response.status);
			for (const [name, value] of Object.entries(response.headers))
				expect(answer.headers.get(name), interaction.description).toContain(
					value,
				);
			expect(await answer.json(), interaction.description).toEqual(
				response.body,
			);
		}
	} finally {
		await mcp.close();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
