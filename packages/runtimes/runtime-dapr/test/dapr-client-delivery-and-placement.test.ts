/**
 * The in-memory Dapr sidecar client: at-least-once delivery, consumer-group
 * isolation, and actor placement.
 *
 * This client stands in for a real `daprd` in every lane that does not have
 * one, so the semantics it models are the ones HoBo's code is written against.
 * Getting them subtly wrong here means code that passes every test and then
 * misbehaves against the real sidecar.
 *
 * **Delivery is at-least-once, and the attempt count is how a consumer knows.**
 * A redelivered message arrives with a higher `deliveryAttempt`; that is what
 * lets a handler tell "first try" from "this keeps failing" and route to a DLQ
 * rather than looping forever.
 *
 * **In-flight messages are not redelivered until they are nacked.** Two drains
 * in a row must not hand the same message out twice, or one message gets
 * processed concurrently by two workers.
 *
 * **Consumer groups are independent.** One group acking a message must not
 * consume it for another — that is the whole point of a group, and getting it
 * wrong makes a second subscriber silently miss every message the first one
 * handled.
 *
 * **Acquiring an actor lease bumps a fence token, monotonically.** The fence is
 * what makes a stale holder's writes rejectable after it loses the lease. A
 * fence that repeated or went backwards would let a partitioned old holder
 * write over the new one.
 */
import { describe, expect, it } from "vitest";

import {
	createInMemoryDaprClient,
	resolveDaprClientFromEnv,
} from "../src/dapr-client.js";

/** Publish `count` messages to one topic and return their ids. */
async function publishAll(
	client: ReturnType<typeof createInMemoryDaprClient>,
	count: number,
	topic = "orders",
) {
	const ids: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const { id } = await client.publish({
			pubsubName: "bus",
			topic,
			data: { index },
			// SAFETY: the client reads exactly the fields named above.
		} as never);
		ids.push(id);
	}
	return ids;
}

const drain = (
	client: ReturnType<typeof createInMemoryDaprClient>,
	max = 10,
	group?: string,
	topic = "orders",
) =>
	group === undefined
		? client.drain("bus", topic, max)
		: client.drain("bus", topic, max, group);

describe("publishing", () => {
	it("gives every message its own id", async () => {
		const client = createInMemoryDaprClient();
		const ids = await publishAll(client, 3);
		// Two messages sharing an id would collapse to one in every cursor that
		// tracks acks by id.
		expect(new Set(ids).size).toBe(3);
	});

	it("is frozen", () => {
		// The client is passed across a runtime; a caller replacing `publish`
		// would bypass every semantic this file pins.
		expect(Object.isFrozen(createInMemoryDaprClient())).toBe(true);
	});

	it("reports itself healthy", async () => {
		expect(await createInMemoryDaprClient().health()).toBe(true);
	});

	it("identifies its kind", async () => {
		// Code branches on this to tell a live sidecar from the stand-in.
		expect(createInMemoryDaprClient().kind).toBe("dapr-sidecar-client");
	});
});

describe("draining a topic", () => {
	it("returns nothing when nothing was published", async () => {
		expect(await drain(createInMemoryDaprClient())).toEqual([]);
	});

	it("returns what was published", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 2);
		expect(await drain(client)).toHaveLength(2);
	});

	it("honours the message limit", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 5);
		// A drain that ignored its limit would hand a worker more work than it
		// asked to hold in flight.
		expect(await drain(client, 2)).toHaveLength(2);
	});

	it("does not redeliver an in-flight message", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		await drain(client);
		// Handing the same message out twice would have two workers process it
		// concurrently — the failure a lease exists to prevent.
		expect(await drain(client)).toEqual([]);
	});

	it("keeps messages for other topics out", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1, "orders");
		await publishAll(client, 1, "shipments");
		const drained = await drain(client, 10, undefined, "orders");
		expect(drained).toHaveLength(1);
		expect(drained[0]?.topic).toBe("orders");
	});

	it("keeps messages for another pubsub out", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		// A second bus is a separate broker; leaking across them would deliver a
		// message to a subscriber that never subscribed to it.
		expect(await client.drain("other-bus", "orders", 10)).toEqual([]);
	});

	it("carries the published payload through", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		expect((await drain(client))[0]?.data).toEqual({ index: 0 });
	});

	it("numbers the first delivery as attempt one", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		// Attempt zero would make "first try" and "never delivered"
		// indistinguishable to a handler deciding whether to retry.
		expect((await drain(client))[0]?.deliveryAttempt).toBe(1);
	});
});

describe("acking and nacking", () => {
	it("stops redelivering an acked message", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [message] = await drain(client);
		await client.ack(message?.id ?? "");
		expect(await drain(client)).toEqual([]);
	});

	it("redelivers a nacked message", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [message] = await drain(client);
		await client.nack(message?.id ?? "");
		// At-least-once: a handler that failed must see the message again, or
		// the work is silently dropped.
		expect(await drain(client)).toHaveLength(1);
	});

	it("increments the attempt count on redelivery", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [first] = await drain(client);
		await client.nack(first?.id ?? "");
		const [second] = await drain(client);
		// This is what lets a handler tell "first try" from "this keeps
		// failing" and route to a DLQ rather than looping forever.
		expect(second?.deliveryAttempt).toBe(2);
	});

	it("keeps counting across several redeliveries", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const [message] = await drain(client);
			await client.nack(message?.id ?? "");
		}
		expect((await drain(client))[0]?.deliveryAttempt).toBe(4);
	});

	it("refuses to ack a message that was never published", async () => {
		const client = createInMemoryDaprClient();
		// Silently accepting an unknown id would let a bug that mangles message
		// ids look like successful processing.
		await expect(client.ack("dapr-msg-999")).rejects.toThrow(/unknown message/);
	});

	it("refuses to nack a message that was never published", async () => {
		const client = createInMemoryDaprClient();
		await expect(client.nack("dapr-msg-999")).rejects.toThrow(
			/unknown message/,
		);
	});

	it("tolerates acking the same message twice", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [message] = await drain(client);
		await client.ack(message?.id ?? "");
		// A retried ack after a network blip must not become an error the
		// handler has to distinguish from a real one.
		await expect(client.ack(message?.id ?? "")).resolves.toBeUndefined();
	});
});

describe("consumer groups", () => {
	it("delivers the same message to two groups", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		expect(await drain(client, 10, "billing")).toHaveLength(1);
		// Two subscribers each get their own copy — that is what a group is for.
		expect(await drain(client, 10, "audit")).toHaveLength(1);
	});

	it("keeps one group's ack out of another's cursor", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [message] = await drain(client, 10, "billing");
		await client.ack(message?.id ?? "", "billing");
		// If the ack leaked, `audit` would silently miss every message billing
		// happened to handle first.
		expect(await drain(client, 10, "audit")).toHaveLength(1);
	});

	it("counts attempts per group", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [first] = await drain(client, 10, "billing");
		await client.nack(first?.id ?? "", "billing");
		await drain(client, 10, "billing");
		// A shared counter would make one group's retries push another group
		// into its DLQ.
		expect((await drain(client, 10, "audit"))[0]?.deliveryAttempt).toBe(1);
	});

	it("uses a default group when none is named", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [message] = await drain(client);
		await client.ack(message?.id ?? "");
		// The unnamed group has to be a real, stable group — not a fresh one per
		// call, or nothing would ever stay acked.
		expect(await drain(client)).toEqual([]);
	});

	it("treats the default group as its own group", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [message] = await drain(client);
		await client.ack(message?.id ?? "");
		expect(await drain(client, 10, "billing")).toHaveLength(1);
	});
});

describe("actor placement", () => {
	const acquire = (
		client: ReturnType<typeof createInMemoryDaprClient>,
		holderId: string,
		actorId = "a1",
	) =>
		client.invokeActor({
			actorType: "worker",
			actorId,
			method: "acquire",
			data: { holderId },
			// SAFETY: the client reads exactly the fields named above.
		} as never);

	it("reports the holder that acquired", async () => {
		const client = createInMemoryDaprClient();
		expect(await acquire(client, "node-1")).toMatchObject({
			holderId: "node-1",
		});
	});

	it("issues a fence token on acquire", async () => {
		const client = createInMemoryDaprClient();
		const result = await acquire(client, "node-1");
		// SAFETY: acquire always answers with a fence token.
		expect(Number((result as { fenceToken: string }).fenceToken)).toBe(1);
	});

	it("bumps the fence on every acquire", async () => {
		const client = createInMemoryDaprClient();
		await acquire(client, "node-1");
		const second = await acquire(client, "node-2");
		// The fence is what makes a stale holder's writes rejectable. A repeated
		// fence would let a partitioned old holder write over the new one.
		expect(Number((second as { fenceToken: string }).fenceToken)).toBe(2);
	});

	it("keeps fences per actor rather than global", async () => {
		const client = createInMemoryDaprClient();
		await acquire(client, "node-1", "a1");
		const other = await acquire(client, "node-1", "a2");
		// A global counter would make one actor's churn invalidate another
		// actor's perfectly good lease.
		expect(Number((other as { fenceToken: string }).fenceToken)).toBe(1);
	});

	it("keeps the fence across a release", async () => {
		const client = createInMemoryDaprClient();
		await acquire(client, "node-1");
		await client.invokeActor({
			actorType: "worker",
			actorId: "a1",
			method: "release",
			// SAFETY: the client reads exactly the fields named above.
		} as never);
		const reacquired = await acquire(client, "node-2");
		// Resetting on release would reissue a fence a stale holder still holds,
		// and its writes would be accepted again.
		expect(Number((reacquired as { fenceToken: string }).fenceToken)).toBe(2);
	});

	it("reports a release", async () => {
		const client = createInMemoryDaprClient();
		await acquire(client, "node-1");
		expect(
			await client.invokeActor({
				actorType: "worker",
				actorId: "a1",
				method: "release",
				// SAFETY: the client reads exactly the fields named above.
			} as never),
		).toMatchObject({ released: true });
	});

	it("names an unknown holder rather than failing the acquire", async () => {
		const client = createInMemoryDaprClient();
		const result = await client.invokeActor({
			actorType: "worker",
			actorId: "a1",
			method: "acquire",
			data: {},
			// SAFETY: the client reads exactly the fields named above.
		} as never);
		// Placement still has to happen; an anonymous holder is better than no
		// lease at all, and "unknown" is visible in a trace.
		expect(result).toMatchObject({ holderId: "unknown" });
	});

	it("names an unknown holder when the data is not an object", async () => {
		const client = createInMemoryDaprClient();
		const result = await client.invokeActor({
			actorType: "worker",
			actorId: "a1",
			method: "acquire",
			data: "node-1",
			// SAFETY: the client reads exactly the fields named above.
		} as never);
		expect(result).toMatchObject({ holderId: "unknown" });
	});

	it("echoes any other method rather than refusing it", async () => {
		const client = createInMemoryDaprClient();
		// This client models placement only; a domain method is the actor host's
		// business, so it passes through rather than erroring here.
		expect(
			await client.invokeActor({
				actorType: "worker",
				actorId: "a1",
				method: "doWork",
				// SAFETY: the client reads exactly the fields named above.
			} as never),
		).toMatchObject({ ok: true, method: "doWork" });
	});
});

describe("state and reminders", () => {
	const save = (
		client: ReturnType<typeof createInMemoryDaprClient>,
		key: string,
		value: unknown,
		storeName = "store",
	) =>
		client.saveState({
			storeName,
			key,
			value,
			// SAFETY: the client reads exactly the fields named above.
		} as never);

	const get = (
		client: ReturnType<typeof createInMemoryDaprClient>,
		key: string,
		storeName = "store",
		// SAFETY: the client reads exactly the fields named above.
	) => client.getState({ storeName, key } as never);

	it("reads back what was saved", async () => {
		const client = createInMemoryDaprClient();
		await save(client, "k", { a: 1 });
		expect(await get(client, "k")).toEqual({ a: 1 });
	});

	it("reports null for a key that was never saved", async () => {
		// `null` rather than undefined: the state API's absent value is a JSON
		// value, so a consumer can round-trip it.
		expect(await get(createInMemoryDaprClient(), "missing")).toBeNull();
	});

	it("stores null for a value that was omitted", async () => {
		const client = createInMemoryDaprClient();
		await client.saveState({
			storeName: "store",
			key: "k",
			// SAFETY: the client reads exactly the fields named above.
		} as never);
		expect(await get(client, "k")).toBeNull();
	});

	it("keeps stores apart", async () => {
		const client = createInMemoryDaprClient();
		await save(client, "k", "a", "store-a");
		// One store's key overwriting another's would make two components with
		// the same key names corrupt each other.
		expect(await get(client, "k", "store-b")).toBeNull();
	});

	it("overwrites a key on a second save", async () => {
		const client = createInMemoryDaprClient();
		await save(client, "k", "first");
		await save(client, "k", "second");
		expect(await get(client, "k")).toBe("second");
	});

	it("gives every reminder its own id", async () => {
		const client = createInMemoryDaprClient();
		const first = await client.registerReminder({
			name: "n",
			dueTimeMs: 1_000,
			// SAFETY: the client reads exactly the fields named above.
		} as never);
		const second = await client.registerReminder({
			name: "n",
			dueTimeMs: 1_000,
			// SAFETY: the client reads exactly the fields named above.
		} as never);
		// Two reminders with the same name and due time are still two reminders;
		// a shared id would cancel one when the other is cancelled.
		expect(second.reminderId).not.toBe(first.reminderId);
	});

	it("names the reminder and its due time in the id", async () => {
		const client = createInMemoryDaprClient();
		const registered = await client.registerReminder({
			name: "retry",
			dueTimeMs: 5_000,
			// SAFETY: the client reads exactly the fields named above.
		} as never);
		// A readable id is what makes a stuck reminder findable in a trace.
		expect(registered.reminderId).toContain("retry");
		expect(registered.reminderId).toContain("5000");
	});
});

describe("resolving a client from the environment", () => {
	it("returns nothing when nothing is configured", () => {
		// No sidecar configured is the ordinary case; returning a stand-in would
		// silently make a lane look live when it is not.
		expect(resolveDaprClientFromEnv({})).toBeUndefined();
	});

	it("returns the in-memory client when asked for memory", () => {
		expect(
			resolveDaprClientFromEnv({ HOBO_DAPR_LIVE_CLIENT: "memory" })?.kind,
		).toBe("dapr-sidecar-client");
	});

	it("prefers the memory opt-in over a configured endpoint", () => {
		let created = false;
		resolveDaprClientFromEnv(
			{
				HOBO_DAPR_LIVE_CLIENT: "memory",
				HOBO_DAPR_ENDPOINT: "http://127.0.0.1:3500",
			},
			{
				createLive: () => {
					created = true;
					// SAFETY: never reached; the assertion below proves it.
					return undefined as never;
				},
			},
		);
		// The explicit test opt-in has to win, or a developer with a sidecar
		// running locally cannot force the deterministic lane.
		expect(created).toBe(false);
	});

	it("builds a live client from an endpoint", () => {
		const endpoints: string[] = [];
		resolveDaprClientFromEnv(
			{ HOBO_DAPR_ENDPOINT: "http://127.0.0.1:3500" },
			{
				createLive: (endpoint) => {
					endpoints.push(endpoint);
					// SAFETY: the factory's return value is passed straight through.
					return undefined as never;
				},
			},
		);
		expect(endpoints).toEqual(["http://127.0.0.1:3500"]);
	});

	it("returns nothing for an endpoint with no factory", () => {
		// An endpoint alone cannot produce a client; returning the in-memory one
		// would quietly point a live lane at a stand-in.
		expect(
			resolveDaprClientFromEnv({ HOBO_DAPR_ENDPOINT: "http://127.0.0.1:3500" }),
		).toBeUndefined();
	});

	it("ignores an empty endpoint", () => {
		expect(
			resolveDaprClientFromEnv(
				{ HOBO_DAPR_ENDPOINT: "" },
				{ createLive: () => undefined as never },
			),
		).toBeUndefined();
	});
});
