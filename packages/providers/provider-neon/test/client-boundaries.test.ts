import { describe, expect, it } from "vitest";
import {
	createInMemoryIdempotencyStore,
	createNeonClient,
} from "../src/client.js";
import {
	createStubTransport,
	FIXTURE_DATABASE_ID,
	FIXTURE_NOW_MS,
	fixture,
} from "./harness.js";

describe("Neon native identity and cache boundaries", () => {
	it("rejects a successful GET belonging to a different native database", async () => {
		const foreign = "01999999-0000-7000-8000-000000000002";
		const transport = createStubTransport([
			{
				status: 200,
				body: fixture("create-database.unclaimed.json").replaceAll(
					FIXTURE_DATABASE_ID,
					foreign,
				),
			},
		]);
		const client = createNeonClient({
			transport,
			store: createInMemoryIdempotencyStore(),
			clock: () => FIXTURE_NOW_MS,
		});
		await expect(client.getDatabase(FIXTURE_DATABASE_ID)).rejects.toMatchObject(
			{
				code: "PROVISIONING_CONFLICT",
				message: "provider observation returned a foreign database identity",
			},
		);
		expect(transport.gets).toHaveLength(1);
		expect(transport.posts).toHaveLength(0);
	});
	it("requires explicit private custody for native cache keys before any provider IO", () => {
		const transport = createStubTransport([]);
		const store = createInMemoryIdempotencyStore();
		Object.defineProperty(store, "visibility", { value: "public-events" });
		expect(() =>
			createNeonClient({ transport, store, clock: () => FIXTURE_NOW_MS }),
		).toThrow("native idempotency state requires private custody");
		expect(transport.requests).toHaveLength(0);
	});
});
