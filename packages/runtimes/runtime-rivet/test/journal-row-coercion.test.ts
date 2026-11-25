/**
 * What the journal does with rows SQLite let through.
 *
 * `node:sqlite` is dynamically typed: a column declared `INTEGER` will happily
 * store the string `"5"`, and a `BLOB` column will store text. Every value
 * this journal reads back therefore arrives as `SqliteValue | undefined`, and
 * the coercion helpers — `asNumber`, `asBigInt`, `asBytes`,
 * `parseInboxStatus` — are the boundary that turns a row bag into a typed
 * record.
 *
 * They are not decoration. An actor's revision drives compare-and-swap, and
 * its owner epoch drives fencing (ADR-0135, one partition one writer). A
 * revision read back as `NaN` or a string would make the CAS comparison
 * `current !== expectedRevision` fire on every append, or — worse — pass when
 * it should not.
 *
 * The helpers split into two deliberate halves, and the split is the contract:
 *
 * **Numbers and epochs coerce, defaulting to zero.** A revision is a count;
 * zero is the value for a stream nothing has been written to, so an
 * unreadable revision degrades to "empty stream" rather than throwing. That is
 * the safe direction: an append against a wrongly-zero revision fails its CAS
 * and refuses, while an append against a wrongly-*high* revision would
 * silently write past real events.
 *
 * **Payloads and statuses refuse.** A payload that is not a blob and an inbox
 * status outside the known set have no safe default — guessing either would
 * hand a caller a fabricated event body or run a command in a state the state
 * machine does not have. Both raise `PARSE`.
 *
 * These write the hostile rows directly through a second connection to the
 * same database file, because that is the only way to produce shapes the
 * journal's own writers never emit — and those are exactly the shapes a
 * corrupted file, an older schema, or a different writer would present.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createActorLocalJournal } from "../src/journal.js";
import { RivetJournalError } from "../src/types.js";

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

/** A file-backed journal, plus a raw handle on the same database. */
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

const fact = (overrides: Record<string, unknown> = {}) => ({
	eventId: "evt-1",
	type: "actor.started",
	payload: new Uint8Array([1, 2, 3]),
	metadataJson: "{}",
	tenant: "tenant-a",
	...overrides,
});

describe("optional fact fields", () => {
	it("omits causation, correlation, project and lane when unset", () => {
		// Absent, not null: a consumer spreading a record into a message would
		// otherwise send explicit nulls for fields the producer never set.
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
		// Four separate spreads. One test setting all four could not tell a
		// correctly-omitted field from one dropped by a shared code path.
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
	/** Force the head row to hold `revision` exactly as given. */
	function headWith(revision: unknown) {
		const { journal, raw } = journalOnDisk();
		journal.head("stream-1");
		raw
			.prepare(`UPDATE hobo_actor_head SET revision = ? WHERE stream_id = ?`)
			.run(revision as never, "stream-1");
		return journal;
	}

	it("reads a numeric string as its number", () => {
		// SQLite's dynamic typing permits this in an INTEGER column, and an
		// older writer or a different driver may well have produced it.
		expect(headWith("5").head("stream-1").revision).toBe(5);
	});

	it("falls back to zero for text that is not a number", () => {
		// Zero means "empty stream", so the next append CAS-fails and refuses.
		// The alternative — a NaN revision — makes every comparison false and
		// the failure mode much harder to read.
		expect(headWith("garbage").head("stream-1").revision).toBe(0);
	});

	it("falls back to zero for an empty string", () => {
		// `Number("")` is 0, which would be right by accident. The guard checks
		// for the empty string explicitly so the zero is deliberate.
		expect(headWith("").head("stream-1").revision).toBe(0);
	});

	it("falls back to zero when there is no head row at all", () => {
		// The column is NOT NULL, so an absent *value* is impossible — but an
		// absent *row* is not, and `row?.revision` then yields undefined. A
		// stream nobody has written to is revision zero.
		const { journal } = journalOnDisk();
		expect(journal.head("never-written").revision).toBe(0);
	});

	it("degrades downward, never upward", () => {
		// The direction is the whole safety argument: an append against a
		// wrongly-zero revision fails its CAS and refuses, while one against a
		// wrongly-high revision would silently write past real events.
		const journal = headWith("garbage");
		expect(() => journal.append("stream-1", 9, [fact()])).toThrow(
			/expected revision 9, found 0/,
		);
	});
});

describe("an owner epoch the driver did not return as a bigint", () => {
	function epochWith(epoch: unknown) {
		const { journal, raw } = journalOnDisk();
		journal.head("stream-1");
		raw
			.prepare(`UPDATE hobo_actor_head SET owner_epoch = ? WHERE stream_id = ?`)
			.run(epoch as never, "stream-1");
		return journal;
	}

	it("reads an integer as a bigint", () => {
		// Fencing compares epochs; a number and a bigint do not compare with
		// `===`, so the type has to be normalised here rather than at each use.
		expect(epochWith(7).head("stream-1").ownerEpoch).toBe(7n);
	});

	it("reads a digit string as a bigint", () => {
		expect(epochWith("7").head("stream-1").ownerEpoch).toBe(7n);
	});

	it("reads a negative digit string as a bigint", () => {
		expect(epochWith("-7").head("stream-1").ownerEpoch).toBe(-7n);
	});

	it("falls back to zero for text that is not an integer", () => {
		// Zero is the epoch of a stream no writer has fenced, so an unreadable
		// epoch loses the fence rather than inventing one.
		expect(epochWith("7.5").head("stream-1").ownerEpoch).toBe(0n);
	});

	it("falls back to zero for a float stored in the column", () => {
		// `Number.isSafeInteger` refuses it, and an epoch is a counter — a
		// fractional fence is meaningless, so it loses the fence rather than
		// rounding to a neighbouring writer's epoch.
		expect(epochWith(7.5).head("stream-1").ownerEpoch).toBe(0n);
	});

	it("reports zero for a stream that was never written", () => {
		const { journal } = journalOnDisk();
		expect(journal.head("fresh").ownerEpoch).toBe(0n);
	});
});

describe("a payload that is not a blob", () => {
	it("refuses rather than guessing an encoding", () => {
		// There is no safe default for an event body. Coercing text to bytes
		// would hand a consumer a fabricated payload that looks legitimate.
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
			.run(42 as never, "stream-1");
		expect(() => journal.readFacts("stream-1")).toThrow(/must be a blob/);
	});

	it("classifies it as a parse failure, not a storage one", () => {
		// The row was read fine; it is the *shape* that is wrong. A caller
		// retrying a PARSE would retry forever.
		const { journal, raw } = journalOnDisk();
		journal.append("stream-1", 0, [fact()]);
		raw
			.prepare(`UPDATE hobo_events SET payload = ? WHERE stream_id = ?`)
			.run("not bytes", "stream-1");
		try {
			journal.readFacts("stream-1");
			expect.unreachable("readFacts should have refused");
		} catch (error) {
			expect((error as RivetJournalError).code).toBe("PARSE");
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
			// Every state the machine can be in has to survive a round trip —
			// a status the reader refuses would strand a command that the
			// writer legitimately put there.
			const { journal, raw } = journalOnDisk();
			accepted(journal);
			raw
				.prepare(`UPDATE hobo_inbox SET status = ? WHERE command_id = ?`)
				.run(status, "cmd-1");
			expect(journal.loadCommand("stream-1", "cmd-1")?.status).toBe(status);
		});
	}

	it("refuses a status outside the set", () => {
		// No safe default: running a command in a state the machine does not
		// have is worse than refusing to load it.
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
		// The column is NOT NULL, so this can only arrive from a schema that
		// predates the constraint — which is exactly when a reader must refuse.
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
		// Absent rather than null, for the same reason the fact fields are.
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
