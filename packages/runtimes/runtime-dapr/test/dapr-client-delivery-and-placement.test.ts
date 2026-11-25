import { describe, expect, it } from "vitest";

import {
	createInMemoryDaprClient,
	resolveDaprClientFromEnv,
} from "../src/dapr-client.js";

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
		expect(new Set(ids).size).toBe(3);
	});

	it("is frozen", () => {
		expect(Object.isFrozen(createInMemoryDaprClient())).toBe(true);
	});

	it("reports itself healthy", async () => {
		expect(await createInMemoryDaprClient().health()).toBe(true);
	});

	it("identifies its kind", async () => {
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
		expect(await drain(client, 2)).toHaveLength(2);
	});

	it("does not redeliver an in-flight message", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		await drain(client);
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
		expect(await drain(client)).toHaveLength(1);
	});

	it("increments the attempt count on redelivery", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [first] = await drain(client);
		await client.nack(first?.id ?? "");
		const [second] = await drain(client);
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
		await expect(client.ack(message?.id ?? "")).resolves.toBeUndefined();
	});
});

describe("consumer groups", () => {
	it("delivers the same message to two groups", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		expect(await drain(client, 10, "billing")).toHaveLength(1);
		expect(await drain(client, 10, "audit")).toHaveLength(1);
	});

	it("keeps one group's ack out of another's cursor", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [message] = await drain(client, 10, "billing");
		await client.ack(message?.id ?? "", "billing");
		expect(await drain(client, 10, "audit")).toHaveLength(1);
	});

	it("counts attempts per group", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [first] = await drain(client, 10, "billing");
		await client.nack(first?.id ?? "", "billing");
		await drain(client, 10, "billing");
		expect((await drain(client, 10, "audit"))[0]?.deliveryAttempt).toBe(1);
	});

	it("uses a default group when none is named", async () => {
		const client = createInMemoryDaprClient();
		await publishAll(client, 1);
		const [message] = await drain(client);
		await client.ack(message?.id ?? "");
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
		expect(Number((result as { fenceToken: string }).fenceToken)).toBe(1);
	});

	it("bumps the fence on every acquire", async () => {
		const client = createInMemoryDaprClient();
		await acquire(client, "node-1");
		const second = await acquire(client, "node-2");
		expect(Number((second as { fenceToken: string }).fenceToken)).toBe(2);
	});

	it("keeps fences per actor rather than global", async () => {
		const client = createInMemoryDaprClient();
		await acquire(client, "node-1", "a1");
		const other = await acquire(client, "node-1", "a2");
		expect(Number((other as { fenceToken: string }).fenceToken)).toBe(1);
	});

	it("keeps the fence across a release", async () => {
		const client = createInMemoryDaprClient();
		await acquire(client, "node-1");
		await client.invokeActor({
			actorType: "worker",
			actorId: "a1",
			method: "release",
		} as never);
		const reacquired = await acquire(client, "node-2");
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
		} as never);
		expect(result).toMatchObject({ holderId: "unknown" });
	});

	it("names an unknown holder when the data is not an object", async () => {
		const client = createInMemoryDaprClient();
		const result = await client.invokeActor({
			actorType: "worker",
			actorId: "a1",
			method: "acquire",
			data: "node-1",
		} as never);
		expect(result).toMatchObject({ holderId: "unknown" });
	});

	it("echoes any other method rather than refusing it", async () => {
		const client = createInMemoryDaprClient();
		expect(
			await client.invokeActor({
				actorType: "worker",
				actorId: "a1",
				method: "doWork",
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
		} as never);

	const get = (
		client: ReturnType<typeof createInMemoryDaprClient>,
		key: string,
		storeName = "store",
	) => client.getState({ storeName, key } as never);

	it("reads back what was saved", async () => {
		const client = createInMemoryDaprClient();
		await save(client, "k", { a: 1 });
		expect(await get(client, "k")).toEqual({ a: 1 });
	});

	it("reports null for a key that was never saved", async () => {
		expect(await get(createInMemoryDaprClient(), "missing")).toBeNull();
	});

	it("stores null for a value that was omitted", async () => {
		const client = createInMemoryDaprClient();
		await client.saveState({
			storeName: "store",
			key: "k",
		} as never);
		expect(await get(client, "k")).toBeNull();
	});

	it("keeps stores apart", async () => {
		const client = createInMemoryDaprClient();
		await save(client, "k", "a", "store-a");
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
		} as never);
		const second = await client.registerReminder({
			name: "n",
			dueTimeMs: 1_000,
		} as never);
		expect(second.reminderId).not.toBe(first.reminderId);
	});

	it("names the reminder and its due time in the id", async () => {
		const client = createInMemoryDaprClient();
		const registered = await client.registerReminder({
			name: "retry",
			dueTimeMs: 5_000,
		} as never);
		expect(registered.reminderId).toContain("retry");
		expect(registered.reminderId).toContain("5000");
	});
});

describe("resolving a client from the environment", () => {
	it("returns nothing when nothing is configured", () => {
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
					return undefined as never;
				},
			},
		);
		expect(created).toBe(false);
	});

	it("builds a live client from an endpoint", () => {
		const endpoints: string[] = [];
		resolveDaprClientFromEnv(
			{ HOBO_DAPR_ENDPOINT: "http://127.0.0.1:3500" },
			{
				createLive: (endpoint) => {
					endpoints.push(endpoint);
					return undefined as never;
				},
			},
		);
		expect(endpoints).toEqual(["http://127.0.0.1:3500"]);
	});

	it("returns nothing for an endpoint with no factory", () => {
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
