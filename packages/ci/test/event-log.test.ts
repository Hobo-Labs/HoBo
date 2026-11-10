import { create, toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CiEventSchema,
	ConnectionSchema,
	JobSchema,
	type SequencedCiEvent,
	SequencedCiEventSchema,
} from "../src/_generated/ci_pb.js";
import {
	accountEventPage,
	accountOwnsEvent,
	EVENT_SCAN_LIMIT,
	eventJob,
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
function jobEvent(type: string, repositoryId: number, installationId = 10) {
	return create(CiEventSchema, {
		type,
		at,
		detail: toJsonString(
			JobSchema,
			create(JobSchema, {
				id: 7,
				runId: 70,
				runAttempt: 1,
				repositoryId,
				installationId,
				repository: "Org/Repo",
				action: "queued",
			}),
		),
	});
}
function leaseEvent(accountId: string, leaseId: string) {
	return create(CiEventSchema, {
		type: "ci.LeaseReserved",
		at,
		accountId,
		leaseId,
	});
}
function log(
	...events: ReturnType<typeof leaseEvent>[]
): readonly SequencedCiEvent[] {
	return events.map((event, index) =>
		create(SequencedCiEventSchema, { seq: index + 1, event }),
	);
}

describe("account event log", () => {
	it("attributes a job event through the repository connection", () => {
		expect(
			accountOwnsEvent(connections, "mine", jobEvent("ci.JobQueued", 101)),
		).toBe(true);
		// The same repository number under another installation is not the
		// connection the account made.
		expect(
			accountOwnsEvent(connections, "mine", jobEvent("ci.JobQueued", 101, 11)),
		).toBe(false);
		expect(
			accountOwnsEvent(connections, "mine", jobEvent("ci.JobQueued", 202)),
		).toBe(false);
		expect(
			accountOwnsEvent(connections, "other", jobEvent("ci.JobQueued", 101)),
		).toBe(false);
		expect(eventJob(jobEvent("ci.JobExpired", 101))?.id).toBe(7);
	});

	it("gives no account an event of the whole partition", () => {
		const changed = create(CiEventSchema, {
			type: "ci.ConfigurationChanged",
			at,
			detail: '{"revision":2}',
		});
		expect(accountOwnsEvent(connections, "mine", changed)).toBe(false);
		expect(eventJob(changed)).toBe(undefined);
		// A job-typed event whose detail is not a job is nobody's either.
		expect(
			accountOwnsEvent(
				connections,
				"mine",
				create(CiEventSchema, { type: "ci.JobQueued", at, detail: "{" }),
			),
		).toBe(false);
		expect(accountOwnsEvent(connections, "mine", leaseEvent("mine", "a"))).toBe(
			true,
		);
		expect(
			accountOwnsEvent(connections, "mine", leaseEvent("other", "a")),
		).toBe(false);
	});

	it("resumes a full page after its last event", () => {
		const scanned = log(
			leaseEvent("mine", "a"),
			leaseEvent("other", "x"),
			leaseEvent("mine", "b"),
			leaseEvent("mine", "c"),
		);
		const page = accountEventPage(scanned, connections, {
			accountId: "mine",
			after: 0,
			limit: 2,
		});
		expect(page.events.map((entry) => entry.event?.leaseId)).toEqual([
			"a",
			"b",
		]);
		expect(page.cursor).toBe(3);
	});

	it("moves a short page past every row it examined", () => {
		const scanned = log(
			leaseEvent("mine", "a"),
			leaseEvent("other", "x"),
			jobEvent("ci.JobQueued", 202),
		);
		const page = accountEventPage(scanned, connections, {
			accountId: "mine",
			after: 0,
			limit: 2,
		});
		expect(page.events.map((entry) => entry.event?.leaseId)).toEqual(["a"]);
		expect(page.cursor).toBe(3);
		expect(
			accountEventPage([], connections, {
				accountId: "mine",
				after: 9,
				limit: 2,
			}).cursor,
		).toBe(9);
	});

	it("returns the newest events when the read has no cursor", () => {
		const scanned = log(
			leaseEvent("mine", "a"),
			leaseEvent("mine", "b"),
			leaseEvent("mine", "c"),
			leaseEvent("other", "x"),
		);
		const page = accountEventPage(scanned, connections, {
			accountId: "mine",
			limit: 2,
		});
		expect(page.events.map((entry) => entry.event?.leaseId)).toEqual([
			"b",
			"c",
		]);
		expect(page.cursor).toBe(4);
		expect(
			accountEventPage([], connections, { accountId: "mine", limit: 2 }).cursor,
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
			expect(() => accountEventPage([], connections, cursor)).toThrow();
	});

	it("keeps making progress through a log longer than one scan", () => {
		const store = new LeaseStore(":memory:");
		try {
			const total = EVENT_SCAN_LIMIT + 5;
			for (let index = 0; index < total; index++)
				store.putControlRecord(`note:${index}`, "mine", "{}", at);
			const seen: number[] = [];
			let after = 0;
			for (;;) {
				const page = store.eventsSince({
					accountId: "mine",
					after,
					limit: 500,
				});
				if (page.events.length === 0) break;
				seen.push(...page.events.map((entry) => entry.seq));
				expect(page.cursor).toBeGreaterThan(after);
				after = page.cursor;
			}
			expect(seen.length).toBe(total);
			expect(new Set(seen).size).toBe(total);
			expect(seen).toEqual([...seen].sort((a, b) => a - b));
			expect(
				store.eventsSince({ accountId: "other", after: 0, limit: 10 }).events,
			).toEqual([]);
		} finally {
			store.close();
		}
	});
});
