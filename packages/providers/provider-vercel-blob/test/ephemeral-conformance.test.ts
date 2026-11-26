/**
 * The 24-case ephemeral-state conformance suite from
 * `@hobo/kv-redis-compatible`, unchanged, against the Blob binding. Nothing
 * here contacts Vercel: two lanes run on the in-memory store, and one runs
 * the real pinned SDK over HTTP to a local emulator backed by it.
 */
import {
	EPHEMERAL_STATE_CONFORMANCE_CASES,
	runEphemeralStateConformance,
} from "@hobo/kv-redis-compatible";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type BlobLane,
	httpLane,
	memoryLane,
	shuffledLane,
} from "./fixtures/lanes.js";

const lanes: readonly {
	readonly name: string;
	readonly open: () => BlobLane | Promise<BlobLane>;
	readonly timeoutMs?: number;
}[] = [
	{ name: "in-memory store, four clients", open: memoryLane },
	{
		name: "in-memory store, eight clients, shuffled delays and jittered backoff",
		open: shuffledLane,
		timeoutMs: 30_000,
	},
	{
		name: "@vercel/blob 2.8.2 over HTTP to a local emulator, three clients",
		open: httpLane,
		timeoutMs: 30_000,
	},
];

for (const { name, open, timeoutMs } of lanes) {
	describe(`ephemeral-state conformance — Vercel Blob, ${name}`, () => {
		let current: BlobLane;
		beforeAll(async () => {
			current = await open();
		});
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
	it("passes every case outside a test runner on the in-memory store", async () => {
		const current = memoryLane();
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
