import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import {
	createQueueHandoffHandler,
	forwardQueueHandoff,
} from "../src/queue-forwarding.js";
import {
	encodeRelayQueueMessage,
	MAX_DELIVERY_BODY_BYTES,
	parseRelayQueueMessage,
	type RelayQueueMessage,
} from "../src/relay-queue.js";

// The queue consumers (any deployment) hand each message to the current
// production relay's `/internal/queue-wakeup`. Both sides are this package's
// code, but they run in different deployments, so the body is a contract:
// the consumer side sends exactly these bodies (`forwardQueueHandoff` with the
// stateless relay's encoding) and the provider side answers them as recorded
// (`createQueueHandoffHandler` with the stateless relay's codec).

const Pact = z.object({
	consumer: z.object({ name: z.string() }),
	provider: z.object({ name: z.string() }),
	interactions: z.array(
		z.object({
			description: z.string(),
			providerState: z.string().optional(),
			request: z.object({
				method: z.literal("POST"),
				path: z.literal("/internal/queue-wakeup"),
				body: z.unknown(),
			}),
			response: z.object({ status: z.number() }),
		}),
	),
});
const pact = Pact.parse(
	JSON.parse(
		readFileSync(new URL("./queue-handoff.pact.json", import.meta.url), "utf8"),
	),
);
const JsonBody = z.json();
const origin = "https://ci.example.test";
const secret = "s".repeat(40);

it("forwards each recorded body exactly, and the relay answers each as recorded", async () => {
	expect(pact.interactions).toHaveLength(5);
	for (const interaction of pact.interactions) {
		const failing = interaction.providerState === "processing fails";
		const provider = createQueueHandoffHandler<RelayQueueMessage>({
			origin,
			secret,
			run: async () => {
				if (failing) throw new Error("GitHub unavailable");
			},
			codec: {
				parse: parseRelayQueueMessage,
				isRepairTick: (message) => message.kind === "repair",
				maxBodyBytes: Math.ceil((MAX_DELIVERY_BODY_BYTES * 4) / 3) + 4096,
			},
		});
		let sent: unknown;
		// What a queue consumer received is the recorded body; it is parsed,
		// then encoded again for the handoff, as `entry.ts` does.
		const received = JsonBody.parse(interaction.request.body);
		const forwarded = forwardQueueHandoff({
			origin,
			secret,
			body: encodeRelayQueueMessage(parseRelayQueueMessage(received)),
			fetch: async (url, init) => {
				const request = new Request(url, init);
				sent = await request.clone().json();
				return provider(request);
			},
		});
		if (interaction.response.status === 204) await forwarded;
		else
			await expect(forwarded).rejects.toMatchObject({
				status: interaction.response.status,
			});
		expect(sent, interaction.description).toEqual(interaction.request.body);
	}
});
