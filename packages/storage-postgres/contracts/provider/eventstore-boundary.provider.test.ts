import {
	type AppendOptions,
	type EventInput,
	EventStoreError,
	type JsonObject,
} from "@hobo/core";
import { expect, it } from "vitest";
import type { PostgresEventStore } from "../../src/index.js";
import { isJsonNumber, isJsonObject, isJsonString } from "../../src/json.js";
import {
	describeLive,
	liveStore,
	type ManualClock,
	manualClock,
	OPTS,
} from "../../test/support/live.js";
import { loadPact } from "../pact.js";

/** Provider verification: replay every pact interaction against a real PostgreSQL store. */
const pact = loadPact();

const CAMP = { subscriptionId: "hobo.cd.camp", partitionId: "camp-1" };

async function arrange(
	store: PostgresEventStore,
	clock: ManualClock,
	state: string,
): Promise<void> {
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

function field(request: JsonObject, name: string): string {
	const value = request[name];
	if (!isJsonString(value)) throw new Error(`request.${name} missing`);
	return value;
}

function eventsOf(request: JsonObject): EventInput[] {
	const events = request.events;
	if (!Array.isArray(events)) throw new Error("request.events missing");
	return events.map((event) => {
		if (!isJsonObject(event) || !isJsonString(event.type)) {
			throw new Error("request event malformed");
		}
		return { type: event.type, data: event.data ?? {} };
	});
}

function appendOptionsOf(request: JsonObject): AppendOptions {
	const options = request.options;
	if (!isJsonObject(options) || !isJsonNumber(options.expectedSeq)) {
		throw new Error("request.options malformed");
	}
	const parsed: AppendOptions = { ...OPTS, expectedSeq: options.expectedSeq };
	if (isJsonString(options.fenceToken)) {
		parsed.fenceToken = BigInt(options.fenceToken);
	}
	return parsed;
}

async function perform(
	store: PostgresEventStore,
	request: JsonObject,
): Promise<JsonObject> {
	switch (request.method) {
		case "append": {
			const result = await store.append(
				field(request, "streamId"),
				eventsOf(request),
				appendOptionsOf(request),
			);
			return {
				appended: result.appended.length,
				firstPosition: result.firstPosition?.toString() ?? null,
				lastPosition: result.lastPosition?.toString() ?? null,
			};
		}
		case "claimSubscription": {
			const lease = await store.claimSubscription({
				subscriptionId: field(request, "subscriptionId"),
				partitionId: field(request, "partitionId"),
				holderId: field(request, "holderId"),
			});
			return { fenceToken: lease.fenceToken.toString() };
		}
		case "commitCheckpoint": {
			const checkpoint = await store.commitCheckpoint({
				subscriptionId: field(request, "subscriptionId"),
				partitionId: field(request, "partitionId"),
				position: BigInt(field(request, "position")),
				fenceToken: BigInt(field(request, "fenceToken")),
			});
			return { position: checkpoint.position.toString() };
		}
		default:
			throw new Error(`unknown method ${String(request.method)}`);
	}
}

async function act(
	store: PostgresEventStore,
	request: JsonObject,
): Promise<JsonObject> {
	try {
		return await perform(store, request);
	} catch (error) {
		if (error instanceof EventStoreError)
			return { error: { code: error.code } };
		throw error;
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
