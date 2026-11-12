import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { PostgresEventStore } from "../../src/index.js";
import {
	describeLive,
	liveStore,
	manualClock,
	OPTS,
} from "../../test/support/live.js";

/** Provider verification: replay every pact interaction against a real PostgreSQL store. */
const here = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(join(here, "..", "eventstore-boundary.pact.json"), "utf8"),
) as {
	interactions: {
		description: string;
		providerState: string;
		request: Record<string, unknown> & { method: string };
		response: Record<string, unknown>;
	}[];
};

const CAMP = { subscriptionId: "hobo.cd.camp", partitionId: "camp-1" };

async function arrange(
	store: PostgresEventStore,
	clock: ReturnType<typeof manualClock>,
	state: string,
) {
	switch (state) {
		case "an empty store":
			return;
		case "stream order:1 has one event":
			await store.append(
				"order:1",
				[{ type: "order.Created", data: { n: 1 } }],
				{ ...OPTS, expectedSeq: 0 },
			);
			return;
		case "stream actor:a is fenced at 5":
			await store.append("actor:a", [{ type: "actor.Opened", data: {} }], {
				...OPTS,
				expectedSeq: 0,
				fenceToken: 5n,
			});
			return;
		case "subscription hobo.cd.camp/camp-1 is leased by replica-a with fence 1":
			await store.claimSubscription({ ...CAMP, holderId: "replica-a" });
			return;
		case "subscription hobo.cd.camp/camp-1 was taken over with fence 2":
			await store.claimSubscription({
				...CAMP,
				holderId: "replica-a",
				leaseTtlMs: 1_000,
			});
			clock.advance(1_001);
			await store.claimSubscription({ ...CAMP, holderId: "replica-b" });
			return;
		case "subscription hobo.cd.camp/camp-1 is checkpointed at 7 with fence 1":
			await store.claimSubscription({ ...CAMP, holderId: "replica-a" });
			await store.commitCheckpoint({ ...CAMP, position: 7n, fenceToken: 1n });
			return;
		default:
			throw new Error(`unknown provider state: ${state}`);
	}
}

async function act(
	store: PostgresEventStore,
	request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const text = (field: string) => String(request[field]);
	try {
		switch (request.method) {
			case "append": {
				const options = request.options as {
					expectedSeq: number;
					fenceToken?: string;
				};
				const result = await store.append(
					text("streamId"),
					request.events as never,
					{
						...OPTS,
						expectedSeq: options.expectedSeq,
						...(options.fenceToken !== undefined
							? { fenceToken: BigInt(options.fenceToken) }
							: {}),
					},
				);
				return {
					appended: result.appended.length,
					firstPosition: result.firstPosition?.toString(),
					lastPosition: result.lastPosition?.toString(),
				};
			}
			case "claimSubscription": {
				const lease = await store.claimSubscription({
					subscriptionId: text("subscriptionId"),
					partitionId: text("partitionId"),
					holderId: text("holderId"),
				});
				return { fenceToken: lease.fenceToken.toString() };
			}
			case "commitCheckpoint": {
				const checkpoint = await store.commitCheckpoint({
					subscriptionId: text("subscriptionId"),
					partitionId: text("partitionId"),
					position: BigInt(text("position")),
					fenceToken: BigInt(text("fenceToken")),
				});
				return { position: checkpoint.position.toString() };
			}
			default:
				throw new Error(`unknown method ${String(request.method)}`);
		}
	} catch (error) {
		return { error: { code: String(Reflect.get(error as object, "code")) } };
	}
}

describeLive("eventstore boundary — provider verification (PostgreSQL)", () => {
	for (const interaction of pact.interactions) {
		it(interaction.description, async () => {
			const clock = manualClock();
			const store = liveStore({ clock });
			await arrange(store, clock, interaction.providerState);
			expect(await act(store, interaction.request)).toEqual(
				interaction.response,
			);
		});
	}
});
