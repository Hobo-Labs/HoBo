/**
 * What the conformance suite cannot see from the port: the table is created
 * on first use, expired rows are purged in bounded steps without a scan, the
 * counter guard leaves a rejected value untouched, a large getMany is still
 * one request, and the rows estimate matches the documented cost.
 */
import {
	EPHEMERAL_STATE_COMMAND_COST,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "@hobo/core";
import { KvRedisCompatibleError } from "@hobo/kv-redis-compatible";
import { type Client, createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import {
	createLibsqlEphemeralState,
	createLibsqlUsageMeter,
	LIBSQL_EPHEMERAL_COST,
	type LibsqlRowsCharge,
	meterLibsqlClient,
} from "../src/index.js";
import { temporaryDatabase } from "./fixtures/contexts.js";

const key = (name: string) => parseEphemeralKey(`binding:${name}`);
const ttl = parseEphemeralTtlMs(1_000);

const open: { client: Client; remove(): void }[] = [];

function fresh() {
	const database = temporaryDatabase();
	const client = createClient({ url: database.url });
	open.push({ client, remove: database.remove });
	let nowMs = 1_000_000;
	return {
		client,
		now: () => nowMs,
		advance(ms: number) {
			nowMs += ms;
		},
	};
}

async function rowCount(client: Client, table = "hobo_ephemeral_state") {
	const result = await client.execute(`SELECT count(*) FROM "${table}"`);
	return Number(result.rows[0]?.[0]);
}

afterEach(() => {
	for (const { client, remove } of open.splice(0)) {
		client.close();
		remove();
	}
});

describe("schema", () => {
	it("creates its table on first use, under the configured name", async () => {
		const { client, now } = fresh();
		const metered = meterLibsqlClient(client);
		const state = createLibsqlEphemeralState({
			client: metered,
			table: "relay_cache",
			now,
		});
		expect(await state.get(key("a"))).toBeUndefined();
		// The failed read, the schema batch, and the retried read.
		expect(metered.requests()).toEqual({
			total: 3,
			byKind: { execute: 2, batch: 1 },
		});
		expect(await state.putIfAbsent(key("a"), "x", ttl)).toMatchObject({
			applied: true,
		});
		expect(await rowCount(client, "relay_cache")).toBe(1);
	});

	it("refuses a table name that is not a plain identifier", () => {
		const { client } = fresh();
		expect(() =>
			createLibsqlEphemeralState({ client, table: 'x"; DROP TABLE y; --' }),
		).toThrow(RangeError);
	});

	it("uses a query plan that never scans the table", async () => {
		const { client, now } = fresh();
		await createLibsqlEphemeralState({ client, now }).get(key("warm"));
		const plan = async (sql: string) =>
			(await client.execute(`EXPLAIN QUERY PLAN ${sql}`)).rows
				.map((row) => String(row[3]))
				.join(" | ");
		expect(
			await plan(
				`SELECT v FROM "hobo_ephemeral_state" WHERE k = 'a' AND e > 0`,
			),
		).toMatch(/SEARCH .*PRIMARY KEY/u);
		expect(
			await plan(
				`SELECT k FROM "hobo_ephemeral_state" WHERE e <= 5 ORDER BY e LIMIT 3`,
			),
		).toMatch(/SEARCH .*USING (COVERING )?INDEX hobo_ephemeral_state_e/u);
	});
});

describe("expiry", () => {
	it("purges expired rows in bounded steps riding along with writes", async () => {
		const { client, now, advance } = fresh();
		const charges: LibsqlRowsCharge[] = [];
		const state = createLibsqlEphemeralState({
			client,
			now,
			purge: { everyMs: 0, limit: 3 },
			onRows: (charge) => charges.push(charge),
		});
		for (let index = 0; index < 5; index += 1) {
			await state.putIfAbsent(key(`old-${index}`), "x", ttl);
		}
		advance(2_000);
		await state.putIfAbsent(key("live"), "x", ttl);
		expect(await rowCount(client)).toBe(3); // 5 expired − 3 purged + 1 live
		await state.putIfAbsent(key("live-2"), "x", ttl);
		expect(await rowCount(client)).toBe(2); // the last 2 expired are gone
		expect(
			charges.filter((charge) => charge.operation === "purge").at(-1),
		).toEqual({ operation: "purge", rowsRead: 5, rowsWritten: 2 });
	});

	it("purges at most once per interval per client", async () => {
		const { client, now, advance } = fresh();
		const metered = meterLibsqlClient(client);
		const state = createLibsqlEphemeralState({
			client: metered,
			now,
			purge: { everyMs: 60_000, limit: 64 },
		});
		await state.get(key("warm")); // create the table
		metered.reset();
		await state.putIfAbsent(key("a"), "x", ttl);
		await state.putIfAbsent(key("b"), "x", ttl);
		advance(60_000);
		await state.putIfAbsent(key("c"), "x", ttl);
		expect(metered.requests()).toEqual({
			total: 3,
			byKind: { execute: 1, batch: 2 },
		});
	});

	it("reads an expired row as absent and replaces it with a new incarnation", async () => {
		const { client, now, advance } = fresh();
		const state = createLibsqlEphemeralState({ client, now, purge: false });
		const first = await state.putIfAbsent(key("k"), "old", ttl);
		advance(1_000);
		expect(await state.get(key("k"))).toBeUndefined();
		expect(await rowCount(client)).toBe(1); // still stored, lazily
		const second = await state.putIfAbsent(key("k"), "new", ttl);
		expect(second.applied && first.applied && second.version).not.toBe(
			first.applied && first.version,
		);
		expect(await rowCount(client)).toBe(1); // replaced in place
	});
});

describe("counters", () => {
	it.each([
		["a value with an embedded NUL", "5\u0000x"],
		["more than 16 digits", "12345678901234567"],
		["a float", "1.5"],
		["a bare sign", "-"],
	])("rejects %s and leaves it untouched", async (_name, stored) => {
		const { client, now } = fresh();
		const state = createLibsqlEphemeralState({ client, now });
		await state.putIfAbsent(key("n"), stored, ttl);
		await expect(state.increment(key("n"), 1, ttl)).rejects.toBeInstanceOf(
			KvRedisCompatibleError,
		);
		expect((await state.get(key("n")))?.value).toBe(stored);
	});

	it("rejects a step that would leave the safe integer range", async () => {
		const { client, now } = fresh();
		const state = createLibsqlEphemeralState({ client, now });
		expect(
			await state.increment(key("n"), Number.MAX_SAFE_INTEGER - 1, ttl),
		).toBe(Number.MAX_SAFE_INTEGER - 1);
		expect(await state.increment(key("n"), 1, ttl)).toBe(
			Number.MAX_SAFE_INTEGER,
		);
		await expect(state.increment(key("n"), 1, ttl)).rejects.toMatchObject({
			code: "EPHEMERAL_BACKEND_REJECTED",
		});
		expect((await state.get(key("n")))?.value).toBe(
			String(Number.MAX_SAFE_INTEGER),
		);
	});

	it("counts a negative value stored by putIfAbsent", async () => {
		const { client, now } = fresh();
		const state = createLibsqlEphemeralState({ client, now });
		await state.putIfAbsent(key("n"), "-7", ttl);
		expect(await state.increment(key("n"), 2, ttl)).toBe(-5);
	});
});

describe("cost", () => {
	it("answers a getMany of more keys than one statement takes in one request, index-aligned", async () => {
		const { client, now } = fresh();
		const metered = meterLibsqlClient(client);
		const state = createLibsqlEphemeralState({ client: metered, now });
		const keys = Array.from({ length: 600 }, (_, index) => key(`k${index}`));
		for (const each of keys.filter((_, index) => index % 3 === 0)) {
			await state.putIfAbsent(each, each, ttl);
		}
		metered.reset();
		const found = await state.getMany([...keys, keys[0] ?? key("k0")]);
		expect(metered.requests().total).toBe(1);
		expect(found).toHaveLength(601);
		for (const [index, entry] of found.entries()) {
			expect(entry?.value).toBe(
				index % 3 === 0 || index === 600
					? `binding:k${index % 600}`
					: undefined,
			);
		}
	});

	it("charges each call within the documented rows bounds", async () => {
		const { client, now } = fresh();
		const meter = createLibsqlUsageMeter();
		const state = createLibsqlEphemeralState({
			client: meterLibsqlClient(client, { onRequest: meter.onRequest }),
			now,
			purge: false,
			onRows: meter.onRows,
		});
		await state.get(key("warm"));
		meter.reset();
		const created = await state.putIfAbsent(key("a"), "x", ttl);
		await state.putIfAbsent(key("a"), "y", ttl); // lost race: no write
		if (created.applied) {
			await state.compareAndSet(key("a"), created.version, "z", ttl);
		}
		await state.increment(key("n"), 1, ttl);
		await state.expire(key("n"), ttl);
		await state.get(key("a"));
		await state.getMany([key("a"), key("b")]);
		await state.delete(key("n"));
		expect(meter.usage()).toEqual({
			requests: 8,
			requestsByKind: { execute: 8 },
			rowsRead: 9,
			rowsWritten: 5,
		});
		const bound = (operation: keyof typeof LIBSQL_EPHEMERAL_COST) =>
			LIBSQL_EPHEMERAL_COST[operation];
		expect(
			bound("putIfAbsent").rowsReadMax * 2 +
				bound("compareAndSet").rowsReadMax +
				bound("increment").rowsReadMax +
				bound("expire").rowsReadMax +
				bound("get").rowsReadMax +
				bound("getMany").rowsReadMax * 2 +
				bound("delete").rowsReadMax,
		).toBe(9);
	});

	it("documents the same request count per operation as the Redis binding's command count", () => {
		const requests = Object.fromEntries(
			Object.entries(LIBSQL_EPHEMERAL_COST).map(([operation, cost]) => [
				operation,
				cost.requests,
			]),
		);
		expect(requests).toEqual({ ...EPHEMERAL_STATE_COMMAND_COST });
	});
});
