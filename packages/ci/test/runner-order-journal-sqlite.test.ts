import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	type RunnerRouteEvent,
	RunnerRouteEventSchema,
} from "../src/_generated/relay_job_pb.js";
import {
	ROUTE_JOURNAL_RETENTION_MS,
	SqliteRouteJournal,
} from "../src/runner-order/journal-sqlite.js";
import {
	routeJournalConformance,
	testRouteRequest,
} from "../src/runner-order/testing.js";

const DAY_MS = 24 * 60 * 60_000;

function decided(
	init: Readonly<{
		atMs: number;
		jobId: string;
		accountId?: string;
		repository?: string;
	}>,
): RunnerRouteEvent {
	return create(RunnerRouteEventSchema, {
		type: "runner.route.Decided",
		accountId: init.accountId ?? "acct-1",
		atMs: init.atMs,
		request: testRouteRequest(init.repository ?? "octo/app"),
		decision: {
			outcome: "routed",
			runner: "ubuntu-24.04",
			step: "github",
			skipped: [{ key: "fleet", reason: "fleet_full", detail: "" }],
		},
		mode: "relay",
		node: "node-1",
		jobId: init.jobId,
	});
}

const all = Object.freeze({
	accountId: "acct-1",
	repository: undefined,
	sinceMs: 0,
	limit: 100,
});

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-route-journal-"));
	dirs.push(dir);
	return join(dir, "ci.sqlite");
}

describe("SqliteRouteJournal", () => {
	it("keeps the route journal's rules", () =>
		routeJournalConformance(
			() =>
				new SqliteRouteJournal(new DatabaseSync(":memory:"), {
					nowMs: () => 10_000,
				}),
		));

	it("keeps entries across a reopen of the same file, intact", async () => {
		const path = tempFile();
		const first = new DatabaseSync(path);
		const journal = new SqliteRouteJournal(first, { nowMs: () => 50_000 });
		await journal.record(decided({ atMs: 10_000, jobId: "j1" }));
		await journal.record(decided({ atMs: 20_000, jobId: "j2" }));
		first.close();
		const reopened = new SqliteRouteJournal(new DatabaseSync(path), {
			nowMs: () => 50_000,
		});
		const read = await reopened.decisions(all);
		expect(read.map((event) => event.jobId)).toEqual(["j2", "j1"]);
		expect(read[0]?.decision?.skipped[0]?.reason).toBe("fleet_full");
		expect(read[0]?.request?.inputs[0]?.labels).toEqual(["ubuntu-24.04"]);
		expect(Object.isFrozen(read[0])).toBe(true);
		await reopened.record(decided({ atMs: 30_000, jobId: "j1" }));
		expect((await reopened.decisions(all)).length).toBe(2);
	});

	it("shares a database handle with other tables and never begins a transaction", async () => {
		const db = new DatabaseSync(":memory:");
		db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, body TEXT)");
		const journal = new SqliteRouteJournal(db, { nowMs: () => 50_000 });
		db.exec("BEGIN IMMEDIATE");
		await journal.record(decided({ atMs: 10_000, jobId: "j1" }));
		db.exec("ROLLBACK");
		expect(await journal.decisions(all)).toEqual([]);
		await journal.record(decided({ atMs: 10_000, jobId: "j1" }));
		expect((await journal.decisions(all)).length).toBe(1);
	});

	it("keeps entries without a job id each time", async () => {
		const journal = new SqliteRouteJournal(new DatabaseSync(":memory:"), {
			nowMs: () => 50_000,
		});
		await journal.record(decided({ atMs: 10_000, jobId: "" }));
		await journal.record(decided({ atMs: 10_000, jobId: "" }));
		expect((await journal.decisions(all)).length).toBe(2);
	});

	it("refuses an entry that breaks the record's rules and keeps nothing", async () => {
		const journal = new SqliteRouteJournal(new DatabaseSync(":memory:"), {
			nowMs: () => 50_000,
		});
		await expect(
			journal.record(
				create(RunnerRouteEventSchema, {
					...decided({ atMs: 10_000, jobId: "j1" }),
					decision: undefined,
				}),
			),
		).rejects.toThrow(/decision/);
		expect(await journal.decisions(all)).toEqual([]);
	});

	it("does not freeze the caller's event", async () => {
		const journal = new SqliteRouteJournal(new DatabaseSync(":memory:"), {
			nowMs: () => 50_000,
		});
		const event = decided({ atMs: 10_000, jobId: "j1" });
		await journal.record(event);
		expect(Object.isFrozen(event)).toBe(false);
	});

	it("reads nothing for a limit of zero or below", async () => {
		const journal = new SqliteRouteJournal(new DatabaseSync(":memory:"), {
			nowMs: () => 50_000,
		});
		await journal.record(decided({ atMs: 10_000, jobId: "j1" }));
		expect(await journal.decisions({ ...all, limit: 0 })).toEqual([]);
		expect(await journal.decisions({ ...all, limit: -3 })).toEqual([]);
	});

	describe("retention", () => {
		it("is 90 days", () => {
			expect(ROUTE_JOURNAL_RETENTION_MS).toBe(90 * DAY_MS);
		});

		it("hides and then deletes entries older than 90 days by the clock it is given", async () => {
			const db = new DatabaseSync(":memory:");
			let now = 60 * DAY_MS;
			const journal = new SqliteRouteJournal(db, { nowMs: () => now });
			await journal.record(decided({ atMs: 5 * DAY_MS, jobId: "old" }));
			await journal.record(decided({ atMs: 50 * DAY_MS, jobId: "kept" }));
			await journal.record(decided({ atMs: 59 * DAY_MS, jobId: "new" }));
			expect((await journal.decisions(all)).length).toBe(3);
			now = 100 * DAY_MS;
			expect((await journal.decisions(all)).map((e) => e.jobId)).toEqual([
				"new",
				"kept",
			]);
			expect(journal.prune()).toBe(1);
			const rows = db.prepare("SELECT COUNT(*) AS n FROM route_journal").get();
			expect(rows?.n).toBe(2);
			now = 141 * DAY_MS;
			expect((await journal.decisions(all)).map((e) => e.jobId)).toEqual([
				"new",
			]);
		});

		it("prunes on record, so the table never holds more than 90 days", async () => {
			const db = new DatabaseSync(":memory:");
			let now = 10 * DAY_MS;
			const journal = new SqliteRouteJournal(db, { nowMs: () => now });
			await journal.record(decided({ atMs: 9 * DAY_MS, jobId: "a" }));
			now = 200 * DAY_MS;
			await journal.record(decided({ atMs: 199 * DAY_MS, jobId: "b" }));
			const rows = db.prepare("SELECT job_key FROM route_journal").all();
			expect(rows.map((row) => row.job_key)).toEqual([
				"b|runner.route.Decided",
			]);
		});

		it("does not keep an entry already past retention", async () => {
			const journal = new SqliteRouteJournal(new DatabaseSync(":memory:"), {
				nowMs: () => 200 * DAY_MS,
			});
			await journal.record(decided({ atMs: DAY_MS, jobId: "late" }));
			expect(await journal.decisions(all)).toEqual([]);
		});

		it("takes a shorter retention when asked", async () => {
			const journal = new SqliteRouteJournal(new DatabaseSync(":memory:"), {
				nowMs: () => 10 * DAY_MS,
				retentionMs: DAY_MS,
			});
			await journal.record(decided({ atMs: 8 * DAY_MS, jobId: "a" }));
			await journal.record(decided({ atMs: 9.5 * DAY_MS, jobId: "b" }));
			expect((await journal.decisions(all)).map((e) => e.jobId)).toEqual(["b"]);
		});

		it("refuses a retention that is not a positive whole number of milliseconds", () => {
			const db = new DatabaseSync(":memory:");
			expect(() => new SqliteRouteJournal(db, { retentionMs: 0 })).toThrow(
				/retention/,
			);
			expect(() => new SqliteRouteJournal(db, { retentionMs: 1.5 })).toThrow(
				/retention/,
			);
		});
	});
});
