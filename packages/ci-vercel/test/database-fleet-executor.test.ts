import { describe, expect, it } from "vitest";
import {
	DatabaseFenceError,
	meteredClient,
	pgExecutor,
} from "../src/database-fleet-executor.js";

function fakePool() {
	const released: (Error | boolean | undefined)[] = [];
	const statements: string[] = [];
	const query = async (sql: string) => {
		statements.push(sql);
		if (sql === "FAIL") throw new Error("statement failed");
		return { rows: [{ value: "1" }] };
	};
	return {
		released,
		statements,
		pool: {
			query,
			connect: async () => ({
				query,
				release(error?: Error | boolean) {
					released.push(error);
				},
			}),
		},
	};
}

describe("pg executor for the fleet", () => {
	it("returns rows as they arrive and passes parameters through", async () => {
		const fake = fakePool();
		const executor = pgExecutor(fake.pool);
		expect(await executor.query("SELECT 1", [1])).toEqual({
			rows: [{ value: "1" }],
		});
		expect(fake.statements).toEqual(["SELECT 1"]);
	});

	it("returns a session's client to the pool when the callback succeeds", async () => {
		const fake = fakePool();
		const executor = pgExecutor(fake.pool);
		expect(
			await executor.session(async (session) => {
				await session.query("BEGIN");
				await session.query("COMMIT");
				return "done";
			}),
		).toBe("done");
		expect(fake.released).toEqual([false]);
	});

	it("destroys a session's client when the callback rejects", async () => {
		const fake = fakePool();
		const executor = pgExecutor(fake.pool);
		await expect(
			executor.session(async (session) => {
				await session.query("BEGIN");
				await session.query("FAIL");
			}),
		).rejects.toThrow("statement failed");
		// `true` makes the pool close the connection instead of reusing a
		// client that may still hold an open transaction.
		expect(fake.released).toEqual([true]);
	});
});

describe("metered client", () => {
	it("asks before every statement and lets a refusal stop it", () => {
		const seen: boolean[] = [];
		const Client = meteredClient((refusable) => {
			seen.push(refusable);
			if (refusable) throw new DatabaseFenceError();
		});
		const client = new Client({ host: "127.0.0.1", port: 1 });
		expect(() => client.query("INSERT INTO t VALUES (1)")).toThrow(
			DatabaseFenceError,
		);
		expect(() => client.query("SELECT 1", [])).toThrow(DatabaseFenceError);
		expect(seen).toEqual([true, true]);
	});
});
