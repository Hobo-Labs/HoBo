import { describe, expect, it } from "vitest";

import {
	createInMemoryIdempotencyStore,
	createPrismaClient,
	type PrismaResourceSnapshot,
} from "../src/client.js";
import type { PrismaProviderError } from "../src/errors.js";
import {
	createStubRunner,
	FIXTURE_NOW_MS,
	fixedClock,
	fixture,
	stdout,
} from "./harness.js";

const KEY = "hobo-prisma-idem-0001";

const SNAPSHOT: PrismaResourceSnapshot = {
	projectId: "proj_fake000000000000",
	claimUrl: "https://create-db.prisma.io/claim?projectID=proj_fake000000000000",
	region: "us-east-1",
	name: "adopted",
	deletionDateIso: "2026-08-09T13:00:00.000Z",
	deletionDateMs: Date.parse("2026-08-09T13:00:00.000Z"),
	host: "db.prisma.io",
	port: 5432,
	databaseName: "postgres",
	tls: true,
	credentialRef: "hobo-secret://test-vault/prisma/secret-1#value",
};

describe("createPrismaClient idempotency", () => {
	it("retains the intent after a successful process returns malformed output", async () => {
		const runner = createStubRunner([
			stdout("not a result document"),
			stdout(fixture("create.success.json")),
		]);
		const client = createPrismaClient({
			runner,
			store: createInMemoryIdempotencyStore(),
			clock: fixedClock(FIXTURE_NOW_MS),
		});
		await expect(client.create({ idempotencyKey: KEY })).rejects.toMatchObject({
			code: "PROVIDER_CONTRACT_CHANGED",
		});
		await expect(client.create({ idempotencyKey: KEY })).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_AMBIGUOUS",
		});
		expect(runner.runs).toHaveLength(1);
	});
	it("claims a CLI intent atomically across concurrent clients sharing the store", async () => {
		const store = createInMemoryIdempotencyStore();
		const runner = createStubRunner([stdout(fixture("create.success.json"))]);
		const clients = [0, 1].map(() =>
			createPrismaClient({ runner, store, clock: fixedClock(FIXTURE_NOW_MS) }),
		);
		const results = await Promise.allSettled(
			clients.map((client) => client.create({ idempotencyKey: KEY })),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(runner.runs).toHaveLength(1);
	});
	it("runs the CLI exactly once for a fresh key", async () => {
		const runner = createStubRunner([stdout(fixture("create.success.json"))]);
		const client = createPrismaClient({
			runner,
			store: createInMemoryIdempotencyStore(),
			clock: fixedClock(FIXTURE_NOW_MS),
		});

		const outcome = await client.create({ idempotencyKey: KEY });

		expect(outcome.kind).toBe("created");
		expect(runner.runs).toHaveLength(1);
	});

	it("adopts the recorded snapshot instead of minting a second project", async () => {
		const runner = createStubRunner([stdout(fixture("create.success.json"))]);
		const store = createInMemoryIdempotencyStore();
		const client = createPrismaClient({
			runner,
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});

		await client.create({ idempotencyKey: KEY });
		await client.recordSnapshot(KEY, SNAPSHOT);
		const second = await client.create({ idempotencyKey: KEY });

		expect(second.kind).toBe("adopted");
		expect(runner.runs).toHaveLength(1);
	});

	it("refuses to re-run after an ambiguous timeout, because a second run would orphan a project", async () => {
		// No read-by-id API exists, so a duplicate anonymous project could
		// never be found again — refusing beats creating one.
		const runner = createStubRunner([
			{ throws: new Error("spawn timed out") },
			stdout(fixture("create.success.json")),
		]);
		const store = createInMemoryIdempotencyStore();
		const client = createPrismaClient({
			runner,
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});

		await expect(client.create({ idempotencyKey: KEY })).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_AMBIGUOUS",
		});

		try {
			await client.create({ idempotencyKey: KEY });
			expect.unreachable("the second attempt must not spawn the CLI again");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).code).toBe(
				"PROVIDER_OPERATION_AMBIGUOUS",
			);
		}
		expect(runner.runs).toHaveLength(1);
	});

	it("adopts once the ambiguous attempt is resolved by recording a snapshot", async () => {
		const runner = createStubRunner([{ throws: new Error("spawn timed out") }]);
		const store = createInMemoryIdempotencyStore();
		const client = createPrismaClient({
			runner,
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});

		await expect(client.create({ idempotencyKey: KEY })).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_AMBIGUOUS",
		});
		await client.recordSnapshot(KEY, SNAPSHOT);

		const outcome = await client.create({ idempotencyKey: KEY });
		expect(outcome).toEqual({ kind: "adopted", snapshot: SNAPSHOT });
		expect(runner.runs).toHaveLength(1);
	});

	it("releases the key when the CLI reports a definite failure", async () => {
		const runner = createStubRunner([
			{ code: 1, stdout: fixture("create.rate-limited.json"), stderr: "" },
			stdout(fixture("create.success.json")),
		]);
		const store = createInMemoryIdempotencyStore();
		const client = createPrismaClient({
			runner,
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});

		await expect(client.create({ idempotencyKey: KEY })).rejects.toMatchObject({
			code: "PROVIDER_RATE_LIMITED",
		});

		// A rate limit is a definite non-create, so a retry is safe.
		const retry = await client.create({ idempotencyKey: KEY });
		expect(retry.kind).toBe("created");
		expect(runner.runs).toHaveLength(2);
	});

	it("holds the key when the CLI exits without printing a document", async () => {
		const runner = createStubRunner([
			{ code: 137, stdout: "", stderr: "killed" },
			stdout(fixture("create.success.json")),
		]);
		const store = createInMemoryIdempotencyStore();
		const client = createPrismaClient({
			runner,
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});

		await expect(client.create({ idempotencyKey: KEY })).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_AMBIGUOUS",
		});
		await expect(client.create({ idempotencyKey: KEY })).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_AMBIGUOUS",
		});
		expect(runner.runs).toHaveLength(1);
	});

	it("rejects an idempotency key too short to be unique", async () => {
		const client = createPrismaClient({
			runner: createStubRunner([]),
			store: createInMemoryIdempotencyStore(),
			clock: fixedClock(FIXTURE_NOW_MS),
		});
		await expect(
			client.create({ idempotencyKey: "short" }),
		).rejects.toMatchObject({
			code: "PROVIDER_CONTRACT_CHANGED",
		});
	});
});
