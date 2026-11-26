import { describe, expect, it } from "vitest";

import {
	createInMemoryIdempotencyStore,
	createNeonClient,
	type IdempotencyRecord,
} from "../src/client.js";
import type { NeonProviderError } from "../src/errors.js";
import {
	createStubTransport,
	FIXTURE_DATABASE_ID,
	FIXTURE_NOW_MS,
	fixedClock,
	fixture,
} from "./harness.js";

const KEY = "hobo:resource:demo-db:0001";

describe("create idempotency and adoption", () => {
	it("claims a create intent atomically across concurrent clients sharing the store", async () => {
		const store = createInMemoryIdempotencyStore();
		const transport = createStubTransport([
			{ status: 200, body: fixture("create-database.unclaimed.json") },
		]);
		const clients = [0, 1].map(() =>
			createNeonClient({ transport, store, clock: fixedClock(FIXTURE_NOW_MS) }),
		);
		const results = await Promise.allSettled(
			clients.map((client) =>
				client.createDatabase({ ref: "hobo-test", idempotencyKey: KEY }),
			),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(transport.posts).toHaveLength(1);
	});
	it("creates once and records the resulting database id", async () => {
		const transport = createStubTransport([
			{ status: 200, body: fixture("create-database.unclaimed.json") },
		]);
		const store = createInMemoryIdempotencyStore();
		const client = createNeonClient({
			transport,
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});

		const outcome = await client.createDatabase({
			ref: "hobo-test",
			idempotencyKey: KEY,
		});

		expect(outcome.adopted).toBe(false);
		expect(outcome.response.databaseId).toBe(FIXTURE_DATABASE_ID);
		expect((await store.get(KEY))?.state).toBe("created");
		expect(transport.posts).toHaveLength(1);
	});

	it("adopts an existing database instead of creating a second one", async () => {
		const seeded: IdempotencyRecord = {
			key: KEY,
			state: "created",
			ref: "hobo-test",
			attemptedAtMs: FIXTURE_NOW_MS - 1000,
			databaseId: FIXTURE_DATABASE_ID,
		};
		const transport = createStubTransport([
			{ status: 200, body: fixture("get-database.claiming.json") },
		]);
		const client = createNeonClient({
			transport,
			store: createInMemoryIdempotencyStore([seeded]),
			clock: fixedClock(FIXTURE_NOW_MS),
		});

		const outcome = await client.createDatabase({
			ref: "hobo-test",
			idempotencyKey: KEY,
		});

		expect(outcome.adopted).toBe(true);
		expect(outcome.response.status).toBe("CLAIMING");
		expect(transport.posts).toHaveLength(0);
		expect(transport.gets).toHaveLength(1);
	});

	it("after an ambiguous timeout, a retry observes rather than creating a duplicate", async () => {
		const store = createInMemoryIdempotencyStore();
		const firstAttempt = createNeonClient({
			transport: createStubTransport([
				{ status: 0, body: "", throws: new Error("ETIMEDOUT") },
			]),
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});

		await expect(
			firstAttempt.createDatabase({ ref: "hobo-test", idempotencyKey: KEY }),
		).rejects.toMatchObject({ code: "PROVIDER_OPERATION_AMBIGUOUS" });
		expect((await store.get(KEY))?.state).toBe("in-flight");

		// Second attempt: the key is unresolved, so the client must not POST.
		const retryTransport = createStubTransport([]);
		const retry = createNeonClient({
			transport: retryTransport,
			store,
			clock: fixedClock(FIXTURE_NOW_MS + 5000),
		});
		let code: string | undefined;
		try {
			await retry.createDatabase({ ref: "hobo-test", idempotencyKey: KEY });
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			code = (error as NeonProviderError).code;
		}
		expect(code).toBe("PROVIDER_OPERATION_AMBIGUOUS");
		expect(retryTransport.posts).toHaveLength(0);

		// Once the operator supplies the id the attempt produced, adoption works.
		await store.put({
			key: KEY,
			state: "created",
			ref: "hobo-test",
			attemptedAtMs: FIXTURE_NOW_MS,
			databaseId: FIXTURE_DATABASE_ID,
		});
		const adoptTransport = createStubTransport([
			{ status: 200, body: fixture("create-database.unclaimed.json") },
		]);
		const adopt = createNeonClient({
			transport: adoptTransport,
			store,
			clock: fixedClock(FIXTURE_NOW_MS + 6000),
		});
		const outcome = await adopt.createDatabase({
			ref: "hobo-test",
			idempotencyKey: KEY,
		});
		expect(outcome.adopted).toBe(true);
		expect(adoptTransport.posts).toHaveLength(0);
	});

	it("treats a 5xx on create as ambiguous and leaves the key unresolved", async () => {
		const store = createInMemoryIdempotencyStore();
		const client = createNeonClient({
			transport: createStubTransport([
				{ status: 500, body: '{"message":"Failed to create the database."}' },
			]),
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});
		await expect(
			client.createDatabase({ ref: "hobo-test", idempotencyKey: KEY }),
		).rejects.toMatchObject({ code: "PROVIDER_OPERATION_AMBIGUOUS" });
		expect((await store.get(KEY))?.state).toBe("in-flight");
	});

	it("releases the key on a 429 so a later attempt may create", async () => {
		const store = createInMemoryIdempotencyStore();
		const client = createNeonClient({
			transport: createStubTransport([
				{
					status: 429,
					body: '{"message":"slow down"}',
					headers: { "retry-after": "30" },
				},
			]),
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});
		await expect(
			client.createDatabase({ ref: "hobo-test", idempotencyKey: KEY }),
		).rejects.toMatchObject({
			code: "PROVIDER_RATE_LIMITED",
			retryAfterMs: 30_000,
		});
		expect((await store.get(KEY))?.state).toBe("failed");
	});

	it("retries a read on a retryable status with bounded attempts", async () => {
		const slept: number[] = [];
		const transport = createStubTransport([
			{ status: 503, body: "" },
			{ status: 200, body: fixture("create-database.unclaimed.json") },
		]);
		const client = createNeonClient({
			transport,
			store: createInMemoryIdempotencyStore(),
			clock: fixedClock(FIXTURE_NOW_MS),
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		const response = await client.getDatabase(FIXTURE_DATABASE_ID);
		expect(response.databaseId).toBe(FIXTURE_DATABASE_ID);
		expect(slept).toEqual([250]);
	});

	it("refuses a database id that is not a UUID before building a request path", async () => {
		const transport = createStubTransport([]);
		const client = createNeonClient({
			transport,
			store: createInMemoryIdempotencyStore(),
			clock: fixedClock(FIXTURE_NOW_MS),
		});
		await expect(client.getDatabase("../../admin")).rejects.toThrowError(
			/UUID/u,
		);
		expect(transport.requests).toHaveLength(0);
	});
});
