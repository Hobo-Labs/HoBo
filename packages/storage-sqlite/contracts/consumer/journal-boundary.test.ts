import { describe, expect, it } from "vitest";

import {
	createMemoryNodeSqliteDriver,
	SqliteJournal,
} from "../../src/index.js";

/**
 * Consumer-side boundary evidence: DurableEventStore commit + fence + position.
 * Provider implementations (runtime-local, runtime-browser) must satisfy the same shapes.
 */
describe("storage-sqlite journal consumer boundary", () => {
	it("commits events with positions and rejects stale expectedSeq", async () => {
		const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
			nativePragmas: false,
			clock: { now: () => "2026-07-27T00:00:00.000Z" },
		});
		const opts = {
			expectedSeq: 0,
			actor: { kind: "system" as const, id: "test" },
			tenant: "t1",
		};
		const first = await journal.append(
			"order:1",
			[{ type: "order.Created", data: { n: 1 } }],
			opts,
		);
		expect(first.appended).toHaveLength(1);
		expect(first.firstPosition).toBe(1n);

		await expect(
			journal.append("order:1", [{ type: "order.Raced", data: {} }], {
				...opts,
				expectedSeq: 0,
			}),
		).rejects.toMatchObject({ code: "OPTIMISTIC_SEQUENCE_CONFLICT" });

		journal.close();
	});

	it("rejects stale fence tokens distinctly from sequence conflicts", async () => {
		const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
			nativePragmas: false,
			clock: { now: () => "2026-07-27T00:00:00.000Z" },
		});
		await journal.append("actor:a", [{ type: "actor.Opened", data: {} }], {
			expectedSeq: 0,
			actor: { kind: "system", id: "test" },
			tenant: "t1",
			fenceToken: 5n,
		});
		await expect(
			journal.append("actor:a", [{ type: "actor.Stale", data: {} }], {
				expectedSeq: 1,
				actor: { kind: "system", id: "test" },
				tenant: "t1",
				fenceToken: 3n,
			}),
		).rejects.toMatchObject({ code: "STALE_FENCE" });

		await expect(
			journal.append("actor:a", [{ type: "actor.Unfenced", data: {} }], {
				expectedSeq: 1,
				actor: { kind: "system", id: "test" },
				tenant: "t1",
			}),
		).rejects.toMatchObject({ code: "MISSING_FENCE" });

		journal.close();
	});
});
