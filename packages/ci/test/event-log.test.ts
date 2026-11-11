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
	EVENT_SCAN_SPAN,
	eventJob,
	eventScan,
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

	it("looks along a bounded span of the journal", () => {
		const cursor = { accountId: "mine", limit: 2 };
		expect(eventScan({ ...cursor, after: 5 }, 9)).toEqual({
			from: 5,
			to: 9,
			head: 9,
		});
		expect(eventScan({ ...cursor, after: 5 }, 5 + EVENT_SCAN_SPAN + 7)).toEqual(
			{
				from: 5,
				to: 5 + EVENT_SCAN_SPAN,
				head: 5 + EVENT_SCAN_SPAN + 7,
			},
		);
		// A cursor past the head (another journal's) reads nothing and does not move back.
		expect(eventScan({ ...cursor, after: 50 }, 9)).toEqual({
			from: 50,
			to: 50,
			head: 9,
		});
		expect(eventScan(cursor, 9)).toEqual({ from: 0, to: 9, head: 9 });
		expect(eventScan(cursor, EVENT_SCAN_SPAN + 9)).toEqual({
			from: 9,
			to: EVENT_SCAN_SPAN + 9,
			head: EVENT_SCAN_SPAN + 9,
		});
	});

	it("resumes a full page after its last event and says there is more", () => {
		const page = accountEventPage(
			found(1, 3, 4),
			{ accountId: "mine", after: 0, limit: 2 },
			{ from: 0, to: 9, head: 9 },
		);
		expect(page.events.map((entry) => entry.seq)).toEqual([1, 3]);
		expect(page.cursor).toBe(3);
		expect(page.more).toBe(true);
	});

	it("moves a short page to the end of its scan", () => {
		const cursor = { accountId: "mine", after: 0, limit: 2 };
		const caughtUp = accountEventPage(found(1), cursor, {
			from: 0,
			to: 9,
			head: 9,
		});
		expect(caughtUp.events.map((entry) => entry.seq)).toEqual([1]);
		expect(caughtUp.cursor).toBe(9);
		expect(caughtUp.more).toBe(false);
		// The scan stopped short of the head: an empty page is not "caught up".
		const cut = accountEventPage([], cursor, { from: 0, to: 9, head: 30 });
		expect(cut.events).toEqual([]);
		expect(cut.cursor).toBe(9);
		expect(cut.more).toBe(true);
	});

	it("returns the newest events and says when older ones went unread", () => {
		const cursor = { accountId: "mine", limit: 2 };
		const full = accountEventPage(found(7, 8), cursor, {
			from: 5,
			to: 9,
			head: 9,
		});
		expect(full.events.map((entry) => entry.seq)).toEqual([7, 8]);
		expect(full.cursor).toBe(9);
		expect(full.truncated).toBe(false);
		expect(full.more).toBe(false);
		// Fewer than asked for, and the scan did not reach the journal's start.
		expect(
			accountEventPage(found(8), cursor, { from: 5, to: 9, head: 9 }).truncated,
		).toBe(true);
		expect(
			accountEventPage(found(8), cursor, { from: 0, to: 9, head: 9 }).truncated,
		).toBe(false);
		expect(
			accountEventPage([], cursor, { from: 0, to: 0, head: 0 }).cursor,
		).toBe(0);
	});

	it("refuses a read outside its bounds", () => {
		for (const cursor of [
			{ accountId: "", limit: 1 },
			{ accountId: "mine", limit: 0 },
			{ accountId: "mine", limit: 501 },
			{ accountId: "mine", limit: 1.5 },
			{ accountId: "mine", limit: 1, after: -1 },
			{ accountId: "mine", limit: 1, after: 1.5 },
		])
			expect(() => eventScan(cursor, 9)).toThrow();
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

	it("says when a read stopped short, whoever filled the journal", () => {
		const database = new DatabaseSync(":memory:");
		const store = new LeaseStore(":memory:", database);
		try {
			store.putControlRecord("first", "mine", "{}", at);
			// A neighbour writes more than two scans cover. The store writes the
			// neighbour's first event; the rest are copies of that row, made in
			// one statement. 20,500 writes through the store took 1.5 s alone and
			// passed vitest's 5 s limit on a loaded machine, and the read under
			// test only needs the rows to be there.
			const neighbour = 2 * EVENT_SCAN_SPAN + 500;
			store.putControlRecord("n", "theirs", "{}", at);
			database
				.prepare(
					`WITH RECURSIVE copy(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM copy WHERE n < ?)
					 INSERT INTO events(body) SELECT (SELECT body FROM events WHERE seq = 2) FROM copy`,
				)
				.run(neighbour - 1);
			store.putControlRecord("last", "mine", "{}", at);
			const head = neighbour + 2;

			// From the start: the account's first event, and more to read.
			const first = store.eventsSince({
				accountId: "mine",
				after: 0,
				limit: 10,
			});
			expect(first.events.map((entry) => entry.seq)).toEqual([1]);
			expect(first.cursor).toBe(EVENT_SCAN_SPAN);
			expect(first.more).toBe(true);
			// The next scan holds nothing of the account's and still is not the end.
			const empty = store.eventsSince({
				accountId: "mine",
				after: first.cursor,
				limit: 10,
			});
			expect(empty.events).toEqual([]);
			expect(empty.more).toBe(true);
			expect(empty.cursor).toBe(2 * EVENT_SCAN_SPAN);
			const last = store.eventsSince({
				accountId: "mine",
				after: empty.cursor,
				limit: 10,
			});
			expect(last.events.map((entry) => entry.seq)).toEqual([head]);
			expect(last.cursor).toBe(head);
			expect(last.more).toBe(false);

			// The newest read finds the account's latest event behind the
			// neighbour's rows, and says that older ones went unread.
			const newest = store.eventsSince({ accountId: "mine", limit: 10 });
			expect(newest.events.map((entry) => entry.seq)).toEqual([head]);
			expect(newest.cursor).toBe(head);
			expect(newest.truncated).toBe(true);
			const one = store.eventsSince({ accountId: "mine", limit: 1 });
			expect(one.events.map((entry) => entry.seq)).toEqual([head]);
			expect(one.truncated).toBe(false);
		} finally {
			store.close();
		}
	});
});
