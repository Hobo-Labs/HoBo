import { DatabaseSync } from "node:sqlite";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	AccountSchema,
	CiEventSchema,
	ConfigurationSchema,
	ConnectionSchema,
	JobSchema,
	OfferSchema,
	type SequencedCiEvent,
	SequencedCiEventSchema,
} from "../src/_generated/ci_pb.js";
import {
	accountEventPage,
	accountOwnsJob,
	eventCursorBounds,
	eventJob,
	jobAccountId,
} from "../src/event-log.js";
import { LeaseStore } from "../src/store.js";

const at = "2026-11-02T12:00:00Z";
const connections = [
	create(ConnectionSchema, {
		accountId: "mine",
		repository: "Org/Repo",
		repositoryId: 101,
		installationId: 10,
	}),
];
function job(id: number, repositoryId = 101, installationId = 10) {
	return create(JobSchema, {
		id,
		runId: 70,
		runAttempt: 1,
		repositoryId,
		installationId,
		repository: "Org/Repo",
		labels: ["hobo"],
		action: "queued",
	});
}
function found(...positions: number[]): SequencedCiEvent[] {
	return positions.map((seq) =>
		create(SequencedCiEventSchema, {
			seq,
			event: create(CiEventSchema, {
				type: "ci.LeaseReserved",
				at,
				accountId: "mine",
				leaseId: `lease-${seq}`,
			}),
		}),
	);
}
/** One account, or two, each with a zero-price box and one connected repository. */
function configuration(owner: "mine" | "theirs" = "mine") {
	const account = (id: string) =>
		create(AccountSchema, {
			id,
			budgetMicros: 0,
			maxRuntimeMinutes: 30,
			startupMinutes: 5,
			offers: [
				create(OfferSchema, {
					id: `box-${id}`,
					provider: "kubernetes",
					providerAccountId: `box-${id}`,
					enabled: true,
					runsOn: "hobo-isolated-worker",
					backend: "isolated-container",
					freeMinutes: 0,
					priceMicrosPerMinute: 0,
					budgetMicros: 0,
					concurrency: 2,
					observedAt: "2026-11-02T00:00:00Z",
					validUntil: "2026-12-31T23:59:59Z",
					sourceUrl: "https://example.test/box-evidence",
					bridgeAcknowledged: true,
				}),
			],
		});
	return create(ConfigurationSchema, {
		accounts: [account("mine"), account("theirs")],
		connections: [
			create(ConnectionSchema, {
				accountId: owner,
				repository: "Org/Repo",
				repositoryId: 101,
				installationId: 10,
				runnerGroupId: 1,
				isolatedOnly: true,
				acceptAllMatchingRepositoryJobs: true,
				trustedRepositoryAcknowledged: true,
				publicRepositoryAcknowledged: true,
			}),
		],
	});
}

describe("account event journal", () => {
	it("names a job's owner by the connection that holds its repository", () => {
		expect(jobAccountId(connections, job(7))).toBe("mine");
		// The same repository number under another installation is not the
		// connection the account made.
		expect(jobAccountId(connections, job(7, 101, 11))).toBe("");
		expect(jobAccountId(connections, job(7, 202))).toBe("");
		expect(accountOwnsJob(connections, "mine", job(7))).toBe(true);
		expect(accountOwnsJob(connections, "other", job(7))).toBe(false);
		// Nobody owns an unconnected repository's job, least of all "nobody".
		expect(accountOwnsJob(connections, "", job(7, 202))).toBe(false);
		expect(
			eventJob(
				create(CiEventSchema, {
					type: "ci.JobExpired",
					at,
					detail: '{"id":7,"repositoryId":101}',
				}),
			)?.id,
		).toBe(7);
		expect(
			eventJob(
				create(CiEventSchema, { type: "ci.JobQueued", at, detail: "{" }),
			),
		).toBe(undefined);
		expect(
			eventJob(create(CiEventSchema, { type: "ci.LeaseReserved", at })),
		).toBe(undefined);
	});

	it("resumes a full page after its last event and says the account has more", () => {
		const page = accountEventPage(found(1, 3, 4), {
			accountId: "mine",
			after: 0,
			limit: 2,
		});
		expect(page.events.map((entry) => entry.seq)).toEqual([1, 3]);
		expect(page.cursor).toBe(3);
		expect(page.more).toBe(true);
		expect(page.truncated).toBe(false);
	});

	it("leaves the cursor on the account's own last event, or where it was", () => {
		const cursor = { accountId: "mine", after: 5, limit: 2 };
		// Exactly a page: nothing was left behind, so there is no more.
		const caughtUp = accountEventPage(found(7, 9), cursor);
		expect(caughtUp.events.map((entry) => entry.seq)).toEqual([7, 9]);
		expect(caughtUp.cursor).toBe(9);
		expect(caughtUp.more).toBe(false);
		// Nothing of the account's after the cursor: it does not move, wherever
		// the journal's end has got to.
		const idle = accountEventPage([], cursor);
		expect(idle.events).toEqual([]);
		expect(idle.cursor).toBe(5);
		expect(idle.more).toBe(false);
	});

	it("returns the newest events and says when the account has older ones", () => {
		const cursor = { accountId: "mine", limit: 2 };
		const all = accountEventPage(found(7, 8), cursor);
		expect(all.events.map((entry) => entry.seq)).toEqual([7, 8]);
		expect(all.cursor).toBe(8);
		expect(all.truncated).toBe(false);
		expect(all.more).toBe(false);
		// One more than the page holds was found: the oldest stays behind.
		const full = accountEventPage(found(3, 7, 8), cursor);
		expect(full.events.map((entry) => entry.seq)).toEqual([7, 8]);
		expect(full.cursor).toBe(8);
		expect(full.truncated).toBe(true);
		// Fewer than asked for is everything the account has.
		expect(accountEventPage(found(8), cursor).truncated).toBe(false);
		// An account with no events reads on from the journal's start.
		expect(accountEventPage([], cursor).cursor).toBe(0);
	});

	it("refuses a read outside its bounds", () => {
		for (const cursor of [
			{ accountId: "", limit: 1 },
			{ accountId: "mine", limit: 0 },
			{ accountId: "mine", limit: 501 },
			{ accountId: "mine", limit: 1.5 },
			{ accountId: "mine", limit: 1, after: -1 },
			{ accountId: "mine", limit: 1, after: 1.5 },
		]) {
			expect(() => eventCursorBounds(cursor)).toThrow();
			expect(() => accountEventPage([], cursor)).toThrow();
		}
	});
});

describe("LeaseStore event journal", () => {
	it("records a job event for the account that owns the repository when it is written", () => {
		const store = new LeaseStore(":memory:");
		try {
			store.configure(configuration("mine"), 0, at);
			store.queue(job(1), at);
			// The repository moves to another account; its history does not.
			store.configure(configuration("theirs"), 1, at);
			store.queue(job(2), at);
			const mine = store.eventsSince({
				accountId: "mine",
				after: 0,
				limit: 10,
			});
			const theirs = store.eventsSince({
				accountId: "theirs",
				after: 0,
				limit: 10,
			});
			expect(
				mine.events.map((entry) => [
					entry.event?.type,
					eventJob(entry.event ?? create(CiEventSchema))?.id,
				]),
			).toEqual([["ci.JobQueued", 1]]);
			expect(
				theirs.events.map((entry) => [
					entry.event?.type,
					eventJob(entry.event ?? create(CiEventSchema))?.id,
				]),
			).toEqual([["ci.JobQueued", 2]]);
			// Configuration changes are the partition's, and nobody's to read.
			expect(
				store.eventsSince({ accountId: "nobody", after: 0, limit: 10 }).events,
			).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("reads exactly the account's events, whoever filled the journal", () => {
		const database = new DatabaseSync(":memory:");
		const store = new LeaseStore(":memory:", database);
		try {
			store.putControlRecord("first", "mine", "{}", at);
			// A neighbour writes far more than the old bounded scan covered
			// (10,000 rows). The store writes the neighbour's first event; the
			// rest are copies of that row, made in one statement: writing them
			// through the store is slow, and the read under test only needs the
			// rows to be there.
			const neighbour = 20_500;
			store.putControlRecord("n", "theirs", "{}", at);
			database
				.prepare(
					`WITH RECURSIVE copy(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM copy WHERE n < ?)
					 INSERT INTO events(body) SELECT (SELECT body FROM events WHERE seq = 2) FROM copy`,
				)
				.run(neighbour - 1);
			store.putControlRecord("last", "mine", "{}", at);
			const head = neighbour + 2;
			expect(store.journalHead()).toBe(head);

			// From the start: both of the account's events in one read, with
			// nothing more to read, and the cursor on the account's own last.
			const all = store.eventsSince({
				accountId: "mine",
				after: 0,
				limit: 10,
			});
			expect(all.events.map((entry) => entry.seq)).toEqual([1, head]);
			expect(all.cursor).toBe(head);
			expect(all.more).toBe(false);
			// A page of one stops at the page, not at the neighbour's rows.
			const first = store.eventsSince({
				accountId: "mine",
				after: 0,
				limit: 1,
			});
			expect(first.events.map((entry) => entry.seq)).toEqual([1]);
			expect(first.cursor).toBe(1);
			expect(first.more).toBe(true);
			const last = store.eventsSince({
				accountId: "mine",
				after: first.cursor,
				limit: 1,
			});
			expect(last.events.map((entry) => entry.seq)).toEqual([head]);
			expect(last.cursor).toBe(head);
			expect(last.more).toBe(false);

			// The newest read reaches behind the neighbour's rows for the
			// account's older event; only the page's size leaves one unread.
			const newest = store.eventsSince({ accountId: "mine", limit: 10 });
			expect(newest.events.map((entry) => entry.seq)).toEqual([1, head]);
			expect(newest.cursor).toBe(head);
			expect(newest.truncated).toBe(false);
			const one = store.eventsSince({ accountId: "mine", limit: 1 });
			expect(one.events.map((entry) => entry.seq)).toEqual([head]);
			expect(one.truncated).toBe(true);

			// The neighbour journals on; this account's cursor does not move.
			store.putControlRecord("n2", "theirs", "{}", at);
			const idle = store.eventsSince({
				accountId: "mine",
				after: all.cursor,
				limit: 10,
			});
			expect(idle.events).toEqual([]);
			expect(idle.cursor).toBe(all.cursor);
			expect(store.eventsSince({ accountId: "mine", limit: 10 }).cursor).toBe(
				all.cursor,
			);
		} finally {
			store.close();
		}
	});

	it("reads through the account index and fails without it, never by walking the journal", () => {
		const database = new DatabaseSync(":memory:");
		const store = new LeaseStore(":memory:", database);
		try {
			store.putControlRecord("first", "mine", "{}", at);
			const mine =
				"SELECT seq, body FROM events INDEXED BY events_account_seq WHERE json_extract(body,'$.accountId')=?";
			// SQLite's own plan for both reads: a search of the account index,
			// already in journal order, and no scan of the journal.
			for (const [statement, values] of [
				[`${mine} ORDER BY seq DESC LIMIT ?`, ["mine", 11]],
				[`${mine} AND seq>? ORDER BY seq LIMIT ?`, ["mine", 0, 11]],
			] as const) {
				const plan = database
					.prepare(`EXPLAIN QUERY PLAN ${statement}`)
					.all(...values)
					.map((step) => String(step.detail))
					.join("\n");
				expect(plan).toMatch(/SEARCH events USING INDEX events_account_seq/);
				expect(plan).not.toMatch(/SCAN events|TEMP B-TREE/);
			}
			// Without the index the read fails. It does not quietly fall back
			// to a walk of the whole journal, which would stop the host.
			database.exec("DROP INDEX events_account_seq");
			expect(() =>
				store.eventsSince({ accountId: "mine", after: 0, limit: 10 }),
			).toThrow(/no such index/);
			expect(() => store.eventsSince({ accountId: "mine", limit: 10 })).toThrow(
				/no such index/,
			);
		} finally {
			store.close();
		}
	});

	it("builds the account index on a journal written before it existed", () => {
		const database = new DatabaseSync(":memory:");
		// A journal as an earlier release left it: no account index, a job
		// event from before owners were recorded, and one that names its owner.
		database.exec(
			"CREATE TABLE events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)",
		);
		const insert = database.prepare("INSERT INTO events(body) VALUES (?)");
		insert.run(`{"type":"ci.JobQueued","at":"${at}","detail":"{}"}`);
		insert.run(`{"type":"ci.LeaseReserved","at":"${at}","accountId":"mine"}`);
		const store = new LeaseStore(":memory:", database);
		try {
			expect(
				store
					.eventsSince({ accountId: "mine", after: 0, limit: 10 })
					.events.map((entry) => [entry.seq, entry.event?.type]),
			).toEqual([[2, "ci.LeaseReserved"]]);
			// The unowned job event is still in the journal and in nobody's feed.
			expect(store.events().map((event) => event.type)).toEqual([
				"ci.JobQueued",
				"ci.LeaseReserved",
			]);
		} finally {
			store.close();
		}
	});
});
