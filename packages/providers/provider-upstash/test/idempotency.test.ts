import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	createInMemoryIdempotencyStore,
	createUpstashClient,
} from "../src/client.js";
import { isProviderError } from "../src/errors.js";
import {
	createStubTransport,
	FAKE_DATABASE_ID,
	VALID_PAYLOAD,
} from "./fixtures/index.js";

const CLOCK = () => Date.parse("2026-08-08T12:00:00.000Z");

function clientWith(options: Parameters<typeof createStubTransport>[0]) {
	const transport = createStubTransport(options);
	const store = createInMemoryIdempotencyStore();
	const client = createUpstashClient({ transport, store, clock: CLOCK });
	return { transport, store, client };
}

describe("createUpstashClient.createDatabase", () => {
	it("sends the idempotency key as a header and no body", async () => {
		const { transport, client } = clientWith({});

		const outcome = await client.createDatabase({
			idempotencyKey: FAKE_DATABASE_ID,
		});

		assert.equal(outcome.adopted, false);
		assert.equal(outcome.database.databaseId, FAKE_DATABASE_ID);
		const request = transport.requests[0];
		assert.ok(request !== undefined);
		assert.equal(request.method, "POST");
		assert.equal(request.headers["idempotency-key"], FAKE_DATABASE_ID);
		assert.equal(request.body, undefined);
	});

	it("refuses a key that is not a UUIDv4", async () => {
		const { client, transport } = clientWith({});

		await assert.rejects(
			client.createDatabase({ idempotencyKey: "my-app-database" }),
			(error: Error) =>
				isProviderError(error) && error.code === "PROVIDER_CONTRACT_CHANGED",
		);
		// The provider derives the id from the key, so a bad key must not
		// reach it at all.
		assert.equal(transport.requests.length, 0);
	});

	it("refuses a response whose database id is not the idempotency key", async () => {
		// If the provider stops deriving the id from the key, re-POST is no
		// longer a safe adoption and this driver must stop assuming it is.
		const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const { client } = clientWith({
			script: [
				{
					status: 200,
					body: VALID_PAYLOAD.replaceAll(FAKE_DATABASE_ID, other),
				},
			],
		});

		await assert.rejects(
			client.createDatabase({ idempotencyKey: FAKE_DATABASE_ID }),
			(error: Error) =>
				isProviderError(error) &&
				error.code === "PROVIDER_CONTRACT_CHANGED" &&
				/no longer a safe adoption/u.test(error.message),
		);
	});

	it("adopts rather than creating a second database on a repeat call", async () => {
		const { client, transport } = clientWith({});

		const first = await client.createDatabase({
			idempotencyKey: FAKE_DATABASE_ID,
		});
		const second = await client.createDatabase({
			idempotencyKey: FAKE_DATABASE_ID,
		});

		assert.equal(first.adopted, false);
		assert.equal(second.adopted, true);
		assert.equal(second.database.databaseId, first.database.databaseId);
		// Two POSTs, but both carry the same key, so the provider returns the
		// same database rather than minting another.
		assert.equal(transport.requests.length, 2);
		assert.deepEqual(
			transport.requests.map((request) => request.headers["idempotency-key"]),
			[FAKE_DATABASE_ID, FAKE_DATABASE_ID],
		);
	});

	it("reports an unacknowledged create as ambiguous and leaves the key in flight", async () => {
		const transport = createStubTransport({
			throws: [new Error("socket hang up")],
			script: [{ status: 200, body: VALID_PAYLOAD }],
		});
		const store = createInMemoryIdempotencyStore();
		const client = createUpstashClient({ transport, store, clock: CLOCK });

		await assert.rejects(
			client.createDatabase({ idempotencyKey: FAKE_DATABASE_ID }),
			(error: Error) =>
				isProviderError(error) && error.code === "PROVIDER_OPERATION_AMBIGUOUS",
		);

		const record = await store.get(FAKE_DATABASE_ID);
		assert.equal(record?.state, "in-flight");
	});

	it("resolves an ambiguous create by adopting, not by creating again", async () => {
		const transport = createStubTransport({
			throws: [new Error("socket hang up")],
			script: [{ status: 200, body: VALID_PAYLOAD }],
		});
		const store = createInMemoryIdempotencyStore();
		const client = createUpstashClient({ transport, store, clock: CLOCK });

		await assert.rejects(
			client.createDatabase({ idempotencyKey: FAKE_DATABASE_ID }),
		);
		const recovered = await client.createDatabase({
			idempotencyKey: FAKE_DATABASE_ID,
		});

		assert.equal(recovered.adopted, true);
		assert.equal(recovered.database.databaseId, FAKE_DATABASE_ID);
		assert.equal((await store.get(FAKE_DATABASE_ID))?.state, "created");
	});

	it("does not silently retry a 500 create; it surfaces the ambiguity", async () => {
		// A create that got a 500 may or may not have created the database.
		// Retrying inside `createDatabase` would resolve that quietly; the
		// caller is told instead, and recovers through `adoptDatabase`.
		const { client, transport, store } = clientWith({
			script: [
				{ status: 500, body: "upstream error" },
				{ status: 200, body: VALID_PAYLOAD },
			],
		});

		await assert.rejects(
			client.createDatabase({ idempotencyKey: FAKE_DATABASE_ID }),
			(error: Error) =>
				isProviderError(error) && error.code === "PROVIDER_OPERATION_AMBIGUOUS",
		);

		assert.equal(transport.requests.length, 1);
		assert.equal((await store.get(FAKE_DATABASE_ID))?.state, "in-flight");
	});

	it("retries inside adoption, where a repeat POST provably cannot duplicate", async () => {
		const { client, transport } = clientWith({
			script: [
				{ status: 500, body: "upstream error" },
				{ status: 200, body: VALID_PAYLOAD },
			],
		});

		const database = await client.adoptDatabase(FAKE_DATABASE_ID);

		assert.equal(database.databaseId, FAKE_DATABASE_ID);
		assert.equal(transport.requests.length, 2);
	});

	it.each([
		{ header: "86400", expected: 300_000 },
		{
			header: new Date(CLOCK() + 86_400_000).toUTCString(),
			expected: 300_000,
		},
		{ header: "Thu, 01 Jan 2099 00:00:00 GMT", expected: 300_000 },
		{ header: "30", expected: 30_000 },
		{
			header: new Date(CLOCK() + 30_000).toUTCString(),
			expected: 30_000,
		},
	])("bounds adoption backoff for Retry-After $header", async ({
		header,
		expected,
	}) => {
		const transport = createStubTransport({
			script: [
				{ status: 429, headers: { "Retry-After": header }, body: "slow down" },
				{ status: 200, body: VALID_PAYLOAD },
			],
		});
		const delays: number[] = [];
		const client = createUpstashClient({
			transport,
			store: createInMemoryIdempotencyStore(),
			clock: CLOCK,
			sleep: async (delay) => {
				delays.push(delay);
			},
		});

		const database = await client.adoptDatabase(FAKE_DATABASE_ID);

		assert.equal(database.databaseId, FAKE_DATABASE_ID);
		assert.deepEqual(delays, [expected]);
		assert.equal(transport.requests.length, 2);
		assert.deepEqual(
			transport.requests.map((request) => request.headers["idempotency-key"]),
			[FAKE_DATABASE_ID, FAKE_DATABASE_ID],
		);
	});

	it("releases the key on a definite refusal so a new attempt is allowed", async () => {
		const transport = createStubTransport({
			script: [
				{ status: 429, headers: { "retry-after": "30" }, body: "slow down" },
				{ status: 200, body: VALID_PAYLOAD },
			],
		});
		const store = createInMemoryIdempotencyStore();
		const client = createUpstashClient({ transport, store, clock: CLOCK });

		await assert.rejects(
			client.createDatabase({ idempotencyKey: FAKE_DATABASE_ID }),
			(error: Error) =>
				isProviderError(error) && error.code === "PROVIDER_RATE_LIMITED",
		);
		assert.equal((await store.get(FAKE_DATABASE_ID))?.state, "failed");

		const retried = await client.createDatabase({
			idempotencyKey: FAKE_DATABASE_ID,
		});
		assert.equal(retried.adopted, false);
	});
});

describe("createUpstashClient.getMetrics", () => {
	it("reads the counters for a live database", async () => {
		const { client } = clientWith({
			script: [
				{ status: 200, body: JSON.stringify({ keys: 4, commands_total: 11 }) },
			],
		});

		const metrics = await client.getMetrics(
			`https://upstash.com/start-redis/metrics/${FAKE_DATABASE_ID}`,
			FAKE_DATABASE_ID,
		);

		assert.equal(metrics.keys, 4);
		assert.equal(metrics.commandsTotal, 11);
	});

	it("maps a 404 to LEASE_EXPIRED, the only teardown signal this surface gives", async () => {
		const { client } = clientWith({
			script: [{ status: 404, body: "not found" }],
		});

		await assert.rejects(
			client.getMetrics(
				`https://upstash.com/start-redis/metrics/${FAKE_DATABASE_ID}`,
				FAKE_DATABASE_ID,
			),
			(error: Error) =>
				isProviderError(error) && error.code === "LEASE_EXPIRED",
		);
	});
});
