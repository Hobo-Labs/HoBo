import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createActorLocalJournal } from "../src/journal.js";
import { type JournalFact, RivetJournalError } from "../src/types.js";

const dirs: string[] = [];
const open: Array<{ close: () => void }> = [];

afterEach(() => {
	for (const handle of open.splice(0)) {
		try {
			handle.close();
		} catch {
			// already closed by the test
		}
	}
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function journalOnDisk() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-rivet-journal-"));
	dirs.push(dir);
	const path = join(dir, "journal.sqlite");
	const journal = createActorLocalJournal(path);
	open.push(journal);
	const raw = new DatabaseSync(path);
	open.push(raw);
	return { journal, raw };
}

const fact = (overrides: Partial<JournalFact> = {}) => ({
	eventId: "evt-1",
	type: "actor.started",
	payload: new Uint8Array([1, 2, 3]),
	metadataJson: "{}",
	tenant: "tenant-a",
	...overrides,
});

describe("optional fact fields", () => {
	it("omits causation, correlation, project and lane when unset", () => {
		const { journal } = journalOnDisk();
		journal.append("stream-1", 0, [fact()]);
		const [record] = journal.readFacts("stream-1");
		expect(record).toStrictEqual({
			seq: 1,
			eventId: "evt-1",
			type: "actor.started",
			payload: new Uint8Array([1, 2, 3]),
			metadataJson: "{}",
			tenant: "tenant-a",
		});
	});

	it("carries each one back when set", () => {
		const { journal } = journalOnDisk();
		journal.append("stream-1", 0, [
			fact({
				causationId: "cmd-1",
				correlationId: "trace-1",
				project: "proj-a",
				lane: "lane-a",
			}),
		]);
		expect(journal.readFacts("stream-1")[0]).toMatchObject({
			causationId: "cmd-1",
			correlationId: "trace-1",
			project: "proj-a",
			lane: "lane-a",
		});
	});

	it("carries them back independently", () => {
		const { journal } = journalOnDisk();
		journal.append("stream-1", 0, [fact({ correlationId: "trace-1" })]);
		const [record] = journal.readFacts("stream-1");
		expect(record).toMatchObject({ correlationId: "trace-1" });
		expect(record).not.toHaveProperty("causationId");
		expect(record).not.toHaveProperty("project");
		expect(record).not.toHaveProperty("lane");
	});

	it("reads from an explicit sequence", () => {
		const { journal } = journalOnDisk();
		journal.append("stream-1", 0, [
			fact({ eventId: "evt-1" }),
			fact({ eventId: "evt-2" }),
			fact({ eventId: "evt-3" }),
		]);
		expect(
			journal.readFacts("stream-1", 2).map((r) => r.eventId),
		).toStrictEqual(["evt-2", "evt-3"]);
	});
});

describe("a revision the driver did not return as a number", () => {
	function headWith(revision: string) {
		const { journal, raw } = journalOnDisk();
		journal.head("stream-1");
		raw
			.prepare(`UPDATE hobo_actor_head SET revision = ? WHERE stream_id = ?`)
			.run(revision, "stream-1");
		return journal;
	}

	it("reads a numeric string as its number", () => {
		expect(headWith("5").head("stream-1").revision).toBe(5);
	});

	it("falls back to zero for text that is not a number", () => {
		expect(headWith("garbage").head("stream-1").revision).toBe(0);
	});

	it("falls back to zero for an empty string", () => {
		expect(headWith("").head("stream-1").revision).toBe(0);
	});

	it("falls back to zero when there is no head row at all", () => {
		const { journal } = journalOnDisk();
		expect(journal.head("never-written").revision).toBe(0);
	});

	it("degrades downward, never upward", () => {
		const journal = headWith("garbage");
		expect(() => journal.append("stream-1", 9, [fact()])).toThrow(
			/expected revision 9, found 0/,
		);
	});
});

describe("an owner epoch the driver did not return as a bigint", () => {
	function epochWith(epoch: string | number) {
		const { journal, raw } = journalOnDisk();
		journal.head("stream-1");
		raw
			.prepare(`UPDATE hobo_actor_head SET owner_epoch = ? WHERE stream_id = ?`)
			.run(epoch, "stream-1");
		return journal;
	}

	it("reads an integer as a bigint", () => {
		expect(epochWith(7).head("stream-1").ownerEpoch).toBe(7n);
	});

	it("reads a digit string as a bigint", () => {
		expect(epochWith("7").head("stream-1").ownerEpoch).toBe(7n);
	});

	it("reads a negative digit string as a bigint", () => {
		expect(epochWith("-7").head("stream-1").ownerEpoch).toBe(-7n);
	});

	it("falls back to zero for text that is not an integer", () => {
		expect(epochWith("7.5").head("stream-1").ownerEpoch).toBe(0n);
	});

	it("falls back to zero for a float stored in the column", () => {
		expect(epochWith(7.5).head("stream-1").ownerEpoch).toBe(0n);
	});

	it("reports zero for a stream that was never written", () => {
		const { journal } = journalOnDisk();
		expect(journal.head("fresh").ownerEpoch).toBe(0n);
	});
});

describe("a payload that is not a blob", () => {
	it("refuses rather than guessing an encoding", () => {
		const { journal, raw } = journalOnDisk();
		journal.append("stream-1", 0, [fact()]);
		raw
			.prepare(`UPDATE hobo_events SET payload = ? WHERE stream_id = ?`)
			.run("not bytes", "stream-1");
		expect(() => journal.readFacts("stream-1")).toThrow(RivetJournalError);
	});

	it("says the payload must be a blob", () => {
		const { journal, raw } = journalOnDisk();
		journal.append("stream-1", 0, [fact()]);
		raw
			.prepare(`UPDATE hobo_events SET payload = ? WHERE stream_id = ?`)
			.run(42, "stream-1");
		expect(() => journal.readFacts("stream-1")).toThrow(/must be a blob/);
	});

	it("classifies it as a parse failure, not a storage one", () => {
		const { journal, raw } = journalOnDisk();
		journal.append("stream-1", 0, [fact()]);
		raw
			.prepare(`UPDATE hobo_events SET payload = ? WHERE stream_id = ?`)
			.run("not bytes", "stream-1");
		try {
			journal.readFacts("stream-1");
			expect.unreachable("readFacts should have refused");
		} catch (error) {
			expect(error).toBeInstanceOf(RivetJournalError);
			if (!(error instanceof RivetJournalError)) throw error;
			expect(error.code).toBe("PARSE");
		}
	});
});

describe("inbox statuses", () => {
	const accepted = (journal: ReturnType<typeof createActorLocalJournal>) => {
		journal.acceptCommand({
			streamId: "stream-1",
			commandId: "cmd-1",
			digest: "sha256:abc",
			commandType: "actor.start",
			payloadJson: "{}",
			expectedRevision: 0,
		});
		return journal;
	};

	it("reads back the status a fresh command is persisted with", () => {
		const { journal } = journalOnDisk();
		expect(accepted(journal).loadCommand("stream-1", "cmd-1")?.status).toBe(
			"persisted",
		);
	});

	for (const status of [
		"processing",
		"committed",
		"completed",
		"failed-retryable",
		"failed-terminal",
	] as const) {
		it(`accepts \`${status}\``, () => {
			const { journal, raw } = journalOnDisk();
			accepted(journal);
			raw
				.prepare(`UPDATE hobo_inbox SET status = ? WHERE command_id = ?`)
				.run(status, "cmd-1");
			expect(journal.loadCommand("stream-1", "cmd-1")?.status).toBe(status);
		});
	}

	it("refuses a status outside the set", () => {
		const { journal, raw } = journalOnDisk();
		accepted(journal);
		raw
			.prepare(`UPDATE hobo_inbox SET status = ? WHERE command_id = ?`)
			.run("half-done", "cmd-1");
		expect(() => journal.loadCommand("stream-1", "cmd-1")).toThrow(
			/invalid inbox status half-done/,
		);
	});

	it("refuses a null status", () => {
		const { journal, raw } = journalOnDisk();
		accepted(journal);
		raw.exec(`PRAGMA writable_schema = ON`);
		raw
			.prepare(`UPDATE hobo_inbox SET status = '' WHERE command_id = ?`)
			.run("cmd-1");
		expect(() => journal.loadCommand("stream-1", "cmd-1")).toThrow(
			/invalid inbox status/,
		);
	});

	it("omits resultJson until the command completes", () => {
		const { journal } = journalOnDisk();
		expect(
			accepted(journal).loadCommand("stream-1", "cmd-1"),
		).not.toHaveProperty("resultJson");
	});

	it("carries resultJson once it does", () => {
		const { journal } = journalOnDisk();
		accepted(journal);
		journal.completeCommand("stream-1", "cmd-1", '{"ok":true}');
		expect(journal.loadCommand("stream-1", "cmd-1")).toMatchObject({
			status: "completed",
			resultJson: '{"ok":true}',
		});
	});

	it("coerces an attempt count stored as text", () => {
		const { journal, raw } = journalOnDisk();
		accepted(journal);
		raw
			.prepare(`UPDATE hobo_inbox SET attempt = ? WHERE command_id = ?`)
			.run("3", "cmd-1");
		expect(journal.loadCommand("stream-1", "cmd-1")?.attempt).toBe(3);
	});

	it("coerces an expected revision stored as text", () => {
		const { journal, raw } = journalOnDisk();
		accepted(journal);
		raw
			.prepare(
				`UPDATE hobo_inbox SET expected_revision = ? WHERE command_id = ?`,
			)
			.run("4", "cmd-1");
		expect(journal.loadCommand("stream-1", "cmd-1")?.expectedRevision).toBe(4);
	});
});
