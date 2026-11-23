import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
} from "@hobo/kv-redis-compatible";
import { expect, it } from "vitest";
import { z } from "zod";
import { CacheBindingError } from "../src/cache-backend.js";
import { createOwnerHandoffEntry } from "../src/entry.js";
import { createOwnerHandoffMailbox } from "../src/owner-handoff.js";

const Request_ = z.object({
	method: z.enum(["POST", "PUT"]),
	path: z.string().startsWith("/v1/owner-handoff/mailboxes"),
	headers: z.record(z.string(), z.string()),
	body: z.json().optional(),
});
const Pact = z.object({
	consumer: z.object({ name: z.literal("hobo-mcp-owner-link") }),
	provider: z.object({ name: z.literal("hobo-ci-relay-owner-handoff") }),
	metadata: z.object({ providerClockMs: z.number() }),
	interactions: z.array(
		z.object({
			description: z.string(),
			providerState: z.enum([
				"no mailbox",
				"an open mailbox",
				"a sealed mailbox",
				"a collected mailbox",
				"an expired mailbox",
				"no mailbox store",
			]),
			request: Request_,
			response: z.object({
				status: z.number(),
				body: z.json().optional(),
			}),
		}),
	),
});
const pact = Pact.parse(
	JSON.parse(
		readFileSync(
			new URL(
				"../../hobo/contracts/owner-handoff-relay.pact.json",
				import.meta.url,
			),
			"utf8",
		),
	),
);
const registration = pact.interactions.find(
	(interaction) => interaction.providerState === "no mailbox",
)?.request;
const deposit = pact.interactions.find(
	(interaction) => interaction.request.method === "PUT",
)?.request;
const collect = pact.interactions.find((interaction) =>
	interaction.request.path.endsWith("/collect"),
)?.request;

const ORIGIN = "https://relay.example";
const toRequest = (request: z.infer<typeof Request_>) =>
	new Request(`${ORIGIN}${request.path}`, {
		method: request.method,
		headers: request.headers,
		...(request.body === undefined
			? undefined
			: { body: JSON.stringify(request.body) }),
	});

it("answers every recorded owner hand-off interaction as the consumer expects", async () => {
	expect(pact.interactions).toHaveLength(8);
	if (
		registration === undefined ||
		deposit === undefined ||
		collect === undefined
	)
		throw new Error("the pact lacks a registration, deposit or collection");
	for (const interaction of pact.interactions) {
		const clock = { now: pact.metadata.providerClockMs };
		const state = createRedisEphemeralState({
			executor: createMemoryRedisExecutor({ now: () => clock.now }),
		});
		const mailbox = createOwnerHandoffMailbox({
			state,
			environment: "pact",
			now: () => clock.now,
		});
		let response: Response;
		if (interaction.providerState === "no mailbox store") {
			const entry = createOwnerHandoffEntry({}, async () => {
				throw new CacheBindingError("no cache is bound");
			});
			const server = createServer(entry);
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			try {
				const { port } = z.object({ port: z.number() }).parse(server.address());
				response = await fetch(
					`http://127.0.0.1:${port}${interaction.request.path}`,
					{
						method: interaction.request.method,
						headers: interaction.request.headers,
						body: JSON.stringify(interaction.request.body),
					},
				);
			} finally {
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
			}
		} else {
			if (interaction.providerState !== "no mailbox")
				expect((await mailbox(toRequest(registration))).status).toBe(201);
			if (
				interaction.providerState === "a sealed mailbox" ||
				interaction.providerState === "a collected mailbox"
			)
				expect((await mailbox(toRequest(deposit))).status).toBe(204);
			if (interaction.providerState === "a collected mailbox")
				expect((await mailbox(toRequest(collect))).status).toBe(200);
			if (interaction.providerState === "an expired mailbox")
				clock.now += 11 * 60_000;
			response = await mailbox(toRequest(interaction.request));
		}
		expect(response.status, interaction.description).toBe(
			interaction.response.status,
		);
		expect(response.headers.get("cache-control"), interaction.description).toBe(
			"no-store",
		);
		if (interaction.response.body !== undefined)
			expect(await response.json(), interaction.description).toEqual(
				interaction.response.body,
			);
	}
});
