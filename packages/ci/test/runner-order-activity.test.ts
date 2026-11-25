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
	ACTIVITY_PAGE_MAX,
	ACTIVITY_PAGE_SIZE,
	type ActivityEntry,
	activityFeed,
	journalActivity,
} from "../src/runner-order/activity.js";
import { answerRelayJob } from "../src/runner-order/answer.js";
import { NO_ROUTE_FACTS, type RouteFacts } from "../src/runner-order/decide.js";
import { SqliteRouteJournal } from "../src/runner-order/journal-sqlite.js";
import type { MachineCandidate } from "../src/runner-order/machines.js";
import type { RouteJournal } from "../src/runner-order/ports.js";
import {
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	testRelayJobMessage,
	testRouteRequest,
} from "../src/runner-order/testing.js";

const NOW = 1_763_337_600_000;
const MINUTE = 60_000;

function machine(init: Partial<MachineCandidate> = {}): MachineCandidate {
	return {
		id: "m-1",
		name: "studio",
		runsOn: "hobo-machine-m-1",
		labels: ["self-hosted", "Linux", "X64"],
		online: true,
		paused: false,
		slots: 1,
		busy: 0,
		sharing: "only_me",
		ownerId: "42",
		ownerCanRead: true,
		lastPickedAtMs: 0,
		repository: undefined,
		...init,
	};
}

function event(
	init: Readonly<{
		type?: "runner.route.Requested" | "runner.route.Decided";
		atMs: number;
		jobId: string;
		repository?: string;
		runId?: number;
		outcome?: string;
		step?: string;
		runner?: string;
		machineId?: string;
	}>,
): RunnerRouteEvent {
	const type = init.type ?? "runner.route.Decided";
	const outcome = init.outcome ?? "routed";
	return create(RunnerRouteEventSchema, {
		type,
		accountId: "acct-1",
		atMs: init.atMs,
		request: testRouteRequest(init.repository ?? "octo/app", init.runId),
		decision:
			type === "runner.route.Decided"
				? {
						outcome,
						runner: outcome === "none" ? "" : (init.runner ?? "ubuntu-24.04"),
						step: outcome === "none" ? "" : (init.step ?? "github"),
						machineId: init.machineId ?? "",
						reason:
							outcome === "none" ? "No runner available. nothing fits." : "",
						skipped: [
							{ key: "fleet", reason: "fleet_full", detail: "" },
							{ key: "machine", reason: "not_configured", detail: "" },
						],
						notInOrder: ["depot"],
					}
				: undefined,
		mode: "relay",
		node: "relay-iad-1",
		jobId: init.jobId,
	});
}

describe("activityFeed", () => {
	it("gives one entry per job with where it ran, why, and every step passed over in words", () => {
		const page = activityFeed([
			event({ type: "runner.route.Requested", atMs: 1_000, jobId: "j1" }),
			event({ atMs: 1_200, jobId: "j1" }),
		]);
		expect(page.next).toBeUndefined();
		expect(page.entries).toEqual([
			{
				key: "j1",
				jobId: "j1",
				repository: "octo/app",
				runId: 9001,
				runAttempt: 1,
				job: "route",
				event: "push",
				mode: "relay",
				node: "relay-iad-1",
				requestedAtMs: 1_000,
				decidedAtMs: 1_200,
				atMs: 1_200,
				outcome: "routed",
				runner: "ubuntu-24.04",
				step: "github",
				machineId: "",
				unhealthyFallback: false,
				why: "Routed to ubuntu-24.04 (github).",
				passedOver: [
					"fleet: the fleet is full",
					"machine: the relay did not name it",
					"depot: not in the runner order, so never tried",
				],
			} satisfies ActivityEntry,
		]);
		expect(Object.isFrozen(page.entries[0])).toBe(true);
		expect(Object.isFrozen(page.entries[0]?.passedOver)).toBe(true);
	});

	it("shows a job asked but not yet answered as pending", () => {
		const [entry] = activityFeed([
			event({ type: "runner.route.Requested", atMs: 1_000, jobId: "j1" }),
		]).entries;
		expect(entry?.outcome).toBe("pending");
		expect(entry?.decidedAtMs).toBeUndefined();
		expect(entry?.atMs).toBe(1_000);
		expect(entry?.passedOver).toEqual([]);
		expect(entry?.why).toBe("Asked; no answer is recorded yet.");
	});

	it("says why nothing took a job", () => {
		const [entry] = activityFeed([
			event({ atMs: 1_000, jobId: "j1", outcome: "none" }),
		]).entries;
		expect(entry?.outcome).toBe("none");
		expect(entry?.why).toBe("No runner available. nothing fits.");
	});

	it("keeps jobs without a runner-service id apart by run, attempt and job", () => {
		const page = activityFeed([
			event({ type: "runner.route.Requested", atMs: 1_000, jobId: "" }),
			event({ atMs: 1_000, jobId: "" }),
			event({ atMs: 2_000, jobId: "", runId: 9002 }),
		]);
		expect(page.entries.map((entry) => [entry.runId, entry.outcome])).toEqual([
			[9002, "routed"],
			[9001, "routed"],
		]);
		expect(page.entries[1]?.requestedAtMs).toBe(1_000);
	});

	it("keeps the first answer of a redelivered job, as the journal does", () => {
		const page = activityFeed([
			event({ atMs: NOW, jobId: "j1", runner: "ubuntu-24.04" }),
			event({ atMs: NOW + MINUTE, jobId: "j1", runner: "other" }),
		]);
		expect(page.entries.map((entry) => [entry.runner, entry.atMs])).toEqual([
			["ubuntu-24.04", NOW],
		]);
	});

	it("comes back newest first whatever order the events arrive in", () => {
		const page = activityFeed([
			event({ atMs: 1_000, jobId: "a" }),
			event({ atMs: 3_000, jobId: "c" }),
			event({ atMs: 2_000, jobId: "b" }),
		]);
		expect(page.entries.map((entry) => entry.jobId)).toEqual(["c", "b", "a"]);
	});

	describe("filters", () => {
		const events = [
			event({ atMs: 1_000, jobId: "a", repository: "octo/app" }),
			event({
				atMs: 2_000,
				jobId: "b",
				repository: "octo/other",
				outcome: "none",
			}),
			event({
				atMs: 3_000,
				jobId: "c",
				step: "machine",
				runner: "hobo-machine-m-1",
				machineId: "m-1",
			}),
			event({
				atMs: 4_000,
				jobId: "d",
				outcome: "waiting",
				step: "machine",
				runner: "hobo-machine-m-2",
				machineId: "m-2",
			}),
			event({ type: "runner.route.Requested", atMs: 5_000, jobId: "e" }),
		];
		const ids = (filter: Parameters<typeof activityFeed>[1]) =>
			activityFeed(events, filter).entries.map((entry) => entry.jobId);

		it("by repository, case ignored", () => {
			expect(ids({ repository: "Octo/Other" })).toEqual(["b"]);
		});
		it("by outcome", () => {
			expect(ids({ outcome: "none" })).toEqual(["b"]);
			expect(ids({ outcome: "waiting" })).toEqual(["d"]);
			expect(ids({ outcome: "pending" })).toEqual(["e"]);
		});
		it("by the step that took the job", () => {
			expect(ids({ step: "machine" })).toEqual(["d", "c"]);
		});
		it("by machine", () => {
			expect(ids({ machineId: "m-1" })).toEqual(["c"]);
		});
		it("by start time", () => {
			expect(ids({ sinceMs: 3_000 })).toEqual(["e", "d", "c"]);
		});
		it("together", () => {
			expect(
				ids({ repository: "octo/app", step: "machine", sinceMs: 3_500 }),
			).toEqual(["d"]);
		});
	});

	describe("paging", () => {
		const events = [1, 2, 3, 4, 5].map((n) =>
			event({ atMs: n * 1_000, jobId: `j${n}` }),
		);

		it("walks every entry once, newest first, a page at a time", () => {
			const first = activityFeed(events, { limit: 2 });
			expect(first.entries.map((entry) => entry.jobId)).toEqual(["j5", "j4"]);
			const second = activityFeed(events, { limit: 2, after: first.next });
			expect(second.entries.map((entry) => entry.jobId)).toEqual(["j3", "j2"]);
			const third = activityFeed(events, { limit: 2, after: second.next });
			expect(third.entries.map((entry) => entry.jobId)).toEqual(["j1"]);
			expect(third.next).toBeUndefined();
		});

		it("keeps its place when newer jobs arrive between pages", () => {
			const first = activityFeed(events, { limit: 2 });
			const grown = [...events, event({ atMs: 9_000, jobId: "j9" })];
			const second = activityFeed(grown, { limit: 2, after: first.next });
			expect(second.entries.map((entry) => entry.jobId)).toEqual(["j3", "j2"]);
		});

		it("breaks a tie in time by job, so no entry is lost between pages", () => {
			const tied = ["a", "b", "c"].map((id) =>
				event({ atMs: 1_000, jobId: id }),
			);
			const first = activityFeed(tied, { limit: 2 });
			const second = activityFeed(tied, { limit: 2, after: first.next });
			expect(
				[...first.entries, ...second.entries].map((entry) => entry.jobId),
			).toEqual(["c", "b", "a"]);
		});

		it("defaults to a page of 50 and caps a page at 500", () => {
			const many = Array.from({ length: 600 }, (_, n) =>
				event({ atMs: n + 1, jobId: `j${n}` }),
			);
			expect(ACTIVITY_PAGE_SIZE).toBe(50);
			expect(ACTIVITY_PAGE_MAX).toBe(500);
			expect(activityFeed(many).entries.length).toBe(50);
			expect(activityFeed(many, { limit: 10_000 }).entries.length).toBe(500);
			expect(activityFeed(many, { limit: 0 }).entries.length).toBe(0);
		});
	});
});

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

class TeeJournal implements RouteJournal {
	constructor(private readonly journals: readonly RouteJournal[]) {}
	async record(entry: RunnerRouteEvent): Promise<void> {
		for (const journal of this.journals) await journal.record(entry);
	}
	decisions(): never {
		throw new Error("not read");
	}
}

describe("journalActivity", () => {
	it("rebuilds from the SQLite journal the same feed the live events give", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-activity-"));
		dirs.push(dir);
		const path = join(dir, "ci.sqlite");
		const live = new InMemoryRouteJournal();
		const db = new DatabaseSync(path);
		const clock = () => NOW + 10 * MINUTE;
		const stored = new SqliteRouteJournal(db, { nowMs: clock });
		const journal = new TeeJournal([live, stored]);
		const answer = (
			jobId: string,
			atMs: number,
			facts: RouteFacts,
			init: Parameters<typeof testRelayJobMessage>[0],
		) =>
			answerRelayJob(testRelayJobMessage({ jobId, ...init }), {
				order: new InMemoryRunnerOrderSource(),
				facts: new InMemoryRouteFactsSource(() => facts),
				journal,
				nowMs: atMs,
				mode: "relay",
				node: "relay-iad-1",
				accountId: "acct-1",
				checks: undefined,
			});
		await answer(
			"j1",
			NOW,
			{
				...NO_ROUTE_FACTS,
				fleet: { enabled: true, taking: false, isolated: false },
			},
			{
				inputs: [
					["fleet", "hobo"],
					["github", "ubuntu-24.04"],
				],
			},
		);
		await answer(
			"j2",
			NOW + MINUTE,
			{ ...NO_ROUTE_FACTS, machines: [machine({ busy: 1 })] },
			{ inputs: [["machine", "self-hosted"]] },
		);
		await answer(
			"j3",
			NOW + 2 * MINUTE,
			{ ...NO_ROUTE_FACTS, machines: [machine()] },
			{ inputs: [["machine", "self-hosted"]], private: false },
		);
		await answer(
			"j4",
			NOW + 3 * MINUTE,
			{ ...NO_ROUTE_FACTS, machines: [machine({ id: "m-7" })] },
			{ inputs: [["machine", "self-hosted"]], repository: "octo/other" },
		);
		await answer("j1", NOW + 4 * MINUTE, NO_ROUTE_FACTS, {});
		db.close();

		const liveFeed = activityFeed(live.events, { limit: 500 });
		expect(
			liveFeed.entries.map((entry) => [entry.jobId, entry.outcome]),
		).toEqual([
			["j4", "routed"],
			["j3", "none"],
			["j2", "waiting"],
			["j1", "routed"],
		]);
		expect(liveFeed.entries[3]?.passedOver).toEqual([
			"fleet: the fleet is full",
			"machine: the relay did not name it",
		]);
		expect(liveFeed.entries[0]?.machineId).toBe("m-7");

		const reopened = new SqliteRouteJournal(new DatabaseSync(path), {
			nowMs: clock,
		});
		expect(await journalActivity(reopened, "acct-1", { limit: 500 })).toEqual(
			liveFeed,
		);
		for (const filter of [
			{ repository: "octo/other" },
			{ outcome: "waiting" as const },
			{ step: "machine" },
			{ machineId: "m-7" },
			{ sinceMs: NOW + MINUTE },
			{ limit: 2 },
		])
			expect(await journalActivity(reopened, "acct-1", filter)).toEqual(
				activityFeed(live.events, filter),
			);
		const firstPage = await journalActivity(reopened, "acct-1", { limit: 3 });
		expect(
			await journalActivity(reopened, "acct-1", {
				limit: 3,
				after: firstPage.next,
			}),
		).toEqual(activityFeed(live.events, { limit: 3, after: firstPage.next }));
		expect(await journalActivity(reopened, "acct-2", {})).toEqual({
			entries: [],
			next: undefined,
		});
	});

	it("keeps the request time of a job asked before the start time and answered after it", async () => {
		const live = new InMemoryRouteJournal();
		const stored = new SqliteRouteJournal(new DatabaseSync(":memory:"), {
			nowMs: () => NOW + 10 * MINUTE,
		});
		const journal = new TeeJournal([live, stored]);
		await journal.record(
			event({ type: "runner.route.Requested", atMs: NOW, jobId: "j1" }),
		);
		await journal.record(event({ atMs: NOW + 2 * MINUTE, jobId: "j1" }));
		const filter = { sinceMs: NOW + MINUTE };
		const rebuilt = await journalActivity(stored, "acct-1", filter);
		expect(rebuilt.entries.map((entry) => entry.requestedAtMs)).toEqual([NOW]);
		expect(rebuilt).toEqual(activityFeed(live.events, filter));
	});
});
