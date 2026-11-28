import { bench, describe } from "vitest";

import { createMemoryNodeSqliteDriver, SqliteJournal } from "../src/index.js";

const actor = { kind: "system" as const, id: "bench" };

describe("sqlite journal append/read (no COUNT(*) path)", () => {
	const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
		nativePragmas: false,
		clock: { now: () => "2026-07-27T00:00:00.000Z" },
	});
	let seq = 0;

	bench("single-event append", async () => {
		await journal.append(
			"bench:stream",
			[{ type: "bench.Tick", data: { n: seq } }],
			{ expectedSeq: seq, actor, tenant: "t" },
		);
		seq += 1;
	});

	bench("stream-tail head lookup", () => {
		journal.getStreamHead("bench:stream");
	});

	bench("readAll page after 0", async () => {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (const _ of journal.readAll({ limit: 50 })) {
		}
	});
});
