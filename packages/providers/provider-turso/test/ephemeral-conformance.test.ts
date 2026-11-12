/**
 * The 24-case ephemeral-state conformance suite from
 * `@hobo/kv-redis-compatible`, unchanged, against the libSQL binding on local
 * databases. Nothing here touches a network or Turso: the binding sends the
 * same statements to a `file:` database as to a remote libSQL server, and the
 * server's atomicity is SQLite's.
 */
import {
	EPHEMERAL_STATE_CONFORMANCE_CASES,
	runEphemeralStateConformance,
} from "@hobo/kv-redis-compatible";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	inProcessLane,
	type LibsqlLane,
	serverClockLane,
	workerLane,
} from "./fixtures/contexts.js";

const lanes: readonly {
	readonly name: string;
	readonly open: () => LibsqlLane | Promise<LibsqlLane>;
	readonly timeoutMs?: number;
}[] = [
	{ name: "file:, four in-process clients", open: () => inProcessLane("file") },
	{ name: ":memory:, one client", open: () => inProcessLane("memory") },
	{
		name: "file:, one client here and three in worker threads",
		open: () => workerLane(),
		timeoutMs: 30_000,
	},
	{
		name: "file:, the database's own clock with real sleeps",
		// Real time: a TTL long enough that a loaded CI machine's scheduling
		// delays stay well inside the cases' 0.4–0.6 × TTL margins.
		open: () => serverClockLane(2_000),
		timeoutMs: 30_000,
	},
];

for (const { name, open, timeoutMs } of lanes) {
	describe(`ephemeral-state conformance — libSQL ${name}`, () => {
		let current: LibsqlLane;
		beforeAll(async () => {
			current = await open();
		}, 30_000);
		afterAll(async () => {
			await current.close();
		});

		for (const entry of EPHEMERAL_STATE_CONFORMANCE_CASES) {
			it(
				entry.id,
				async () => {
					await entry.run(current.context);
				},
				timeoutMs,
			);
		}
	});
}

describe("the suite as a report", () => {
	it("passes every case outside a test runner on a file: database", async () => {
		const current = inProcessLane("file");
		try {
			const results = await runEphemeralStateConformance(current.context);
			expect(results.filter((result) => result.status !== "pass")).toEqual([]);
			expect(results).toHaveLength(EPHEMERAL_STATE_CONFORMANCE_CASES.length);
			expect(results).toHaveLength(24);
		} finally {
			await current.close();
		}
	});
});
