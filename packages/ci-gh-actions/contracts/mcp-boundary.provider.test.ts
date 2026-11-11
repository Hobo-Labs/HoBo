import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { expect, it } from "vitest";
import { z } from "zod";
import { createControlAuthenticator } from "../src/control-auth.js";
import { createRelayHandler } from "../src/http-handler.js";
import { createNodeRelayHandler } from "../src/node-http.js";
import { createRelayMcp } from "../src/relay-mcp.js";
import { config, job, NOW, SECRET } from "../test/fixtures.js";

const pact = z
	.object({
		consumer: z.object({ name: z.literal("McpAgentClient") }),
		provider: z.object({ name: z.literal("HoboCiRelayMcp") }),
		metadata: z.object({
			pactSpecification: z.object({ version: z.literal("3.0.0") }),
			consumerFixtures: z.object({
				credentials: z.object({
					reader: z.string().min(32),
					policyWriter: z.string().min(32),
				}),
			}),
		}),
		interactions: z.array(
			z.object({
				description: z.string(),
				request: z.object({
					method: z.enum(["GET", "POST"]),
					path: z.literal("/mcp"),
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
				new URL("./mcp-boundary.pact.json", import.meta.url),
				"utf8",
			),
		),
	);

it("executes every declared MCP interaction over the Node HTTP boundary", async () => {
	expect(pact.interactions).toHaveLength(16);
	const { credentials } = pact.metadata.consumerFixtures;
	const store = new SqliteCiStore(":memory:");
	// One account with one queued job: the journal holds exactly one event of its own.
	const { revision } = await store.configure(config(), 0, NOW);
	await store.queue(job(1), NOW, revision);
	const binding = (token: string, scope: string) => ({
		accountId: "account-a",
		installationIds: [10],
		tokenSha256: createHash("sha256").update(token).digest("hex"),
		scopes: [scope],
	});
	const mcp = createRelayMcp({
		store,
		relay: async () => ({
			reconcile: async () => {
				throw new Error("a refused reconciliation must not reach the relay");
			},
		}),
		authenticate: createControlAuthenticator(
			JSON.stringify({
				tokens: [
					binding(credentials.reader, "policy:read"),
					binding(credentials.policyWriter, "policy:write"),
				],
			}),
		),
		ready: async () => true,
		publicOrigin: "https://ci.example.test",
		// The contract every host honours: no session, JSON answers.
		sessions: "none",
		cursorSecret: SECRET,
	});
	const handle = createRelayHandler({
		webhookSecret: SECRET,
		application: {
			ingestWebhook: async () => "accepted",
			claim: async () => new Response(null, { status: 403 }),
			control: async () => undefined,
			ready: async () => true,
			mcp: mcp.handle,
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
				request.body = JSON.stringify(interaction.request.body);
			const response = await fetch(
				`http://127.0.0.1:${port}${interaction.request.path}`,
				request,
			);
			expect(response.status, interaction.description).toBe(
				interaction.response.status,
			);
			for (const [name, value] of Object.entries(interaction.response.headers))
				expect(response.headers.get(name), interaction.description).toBe(value);
			// A consumer names what it relies on; the provider may say more.
			const answered = await response.text();
			expect(JSON.parse(answered), interaction.description).toMatchObject(
				interaction.response.body,
			);
			// A cursor is a token issued to the account, never a journal position:
			// the contract pins that it is there and what it looks like, not its value.
			for (const cursor of answered.matchAll(/\\?"cursor\\?":\\?"([^"\\]*)/g))
				expect(cursor[1], interaction.description).toMatch(
					/^[A-Za-z0-9_-]{22}$/,
				);
			if (interaction.description.includes("events"))
				expect(answered, interaction.description).toContain("cursor");
			matched++;
		}
		expect(matched).toBe(16);
	} finally {
		server.close();
		await once(server, "close");
		await mcp.close();
		store.close();
	}
});
