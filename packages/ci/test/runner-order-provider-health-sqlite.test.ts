import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { type JobFact, JobFactSchema } from "../src/_generated/relay_job_pb.js";
import {
	answerRelayJob,
	NO_ROUTE_FACTS,
	PROVIDER_HEALTH_DEFAULTS,
	providerHealthKey,
} from "../src/runner-order/index.js";
import {
	feedProviderHealth,
	providerOutcomeOfJob,
	SqliteProviderHealthStore,
} from "../src/runner-order/provider-health-sqlite.js";
import {
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	providerHealthStoreConformance,
	testRelayJobMessage,
} from "../src/runner-order/testing.js";

const MINUTE = 60_000;
const T0 = 1_763_337_600_000;
const LABEL = "depot-ubuntu-24.04";
const KEY = providerHealthKey("depot", LABEL);

const dirs: string[] = [];
function tempPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-provider-health-"));
	dirs.push(dir);
	return join(dir, "provider-health.sqlite");
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function queued(id: number, queuedAtMs: number, labels = [LABEL]): JobFact {
	return create(JobFactSchema, {
		id,
		name: "test",
		labels,
		conclusion: "",
		queuedAtMs,
	});
}

async function missThree(store: SqliteProviderHealthStore): Promise<number> {
	for (const [id, at] of [
		[1, T0],
		[2, T0 + MINUTE],
		[3, T0 + 2 * MINUTE],
	] as const)
		await feedProviderHealth(store, queued(id, at), at + 11 * MINUTE);
	return T0 + 13 * MINUTE;
}

describe("SqliteProviderHealthStore (R09)", () => {
	it("keeps the provider health store's rules", async () => {
		await providerHealthStoreConformance(
			() => new SqliteProviderHealthStore(":memory:"),
		);
	});

	it("keeps a tripped type across a restart", async () => {
		const path = tempPath();
		const first = new SqliteProviderHealthStore(path);
		const now = await missThree(first);
		expect(await first.unhealthy(now)).toEqual(new Set([KEY]));
		first.close();
		const second = new SqliteProviderHealthStore(path);
		expect(await second.unhealthy(now)).toEqual(new Set([KEY]));
		expect((await second.list()).map((record) => record.key)).toEqual([KEY]);
		second.close();
	});

	it("clears a record by hand", async () => {
		const store = new SqliteProviderHealthStore(":memory:");
		const now = await missThree(store);
		expect(await store.clear(KEY)).toBe(true);
		expect(await store.clear(KEY)).toBe(false);
		expect((await store.unhealthy(now)).size).toBe(0);
	});
});

describe("feedProviderHealth (R09)", () => {
	it("counts a job still queued past the wait as one miss, once", async () => {
		const store = new SqliteProviderHealthStore(":memory:");
		const job = queued(1, T0);
		expect(await feedProviderHealth(store, job, T0 + 5 * MINUTE)).toEqual([]);
		const fed = await feedProviderHealth(store, job, T0 + 11 * MINUTE);
		expect(fed.map((entry) => entry.outcome)).toEqual([
			{ atMs: T0 + PROVIDER_HEALTH_DEFAULTS.missedAfterMs, started: false },
		]);
		expect(await feedProviderHealth(store, job, T0 + 20 * MINUTE)).toEqual([]);
		expect((await store.get(KEY)).outcomes).toHaveLength(1);
	});

	it("trips after three misses inside thirty minutes and passes the type over", async () => {
		const store = new SqliteProviderHealthStore(":memory:");
		const now = await missThree(store);
		const journal = new InMemoryRouteJournal();
		const unhealthy = await store.unhealthy(now);
		const answer = await answerRelayJob(
			testRelayJobMessage({
				inputs: [
					["depot", LABEL],
					["github", "ubuntu-24.04"],
				],
			}),
			{
				order: new InMemoryRunnerOrderSource(
					new Map([
						["octo/app", '{"steps":[{"key":"depot"},{"key":"github"}]}'],
					]),
				),
				facts: new InMemoryRouteFactsSource(() => ({
					...NO_ROUTE_FACTS,
					unhealthy,
				})),
				journal,
				nowMs: now,
				mode: "relay",
				node: "node-1",
				accountId: "acct-1",
				checks: undefined,
			},
		);
		expect(
			answer.outputs.find((output) => output.name === "runner")?.value,
		).toBe("ubuntu-24.04");
		const decided = journal.events.find(
			(event) => event.type === "runner.route.Decided",
		);
		expect(decided?.decision?.skipped.map((skip) => skip.reason)).toContain(
			"provider_unhealthy",
		);
	});

	it("backs off, lets a trial through, and a start clears the record", async () => {
		const store = new SqliteProviderHealthStore(":memory:");
		const now = await missThree(store);
		const tripped = await store.get(KEY);
		expect(tripped.backoffMs).toBe(PROVIDER_HEALTH_DEFAULTS.firstBackoffMs);
		const due = tripped.nextTrialAtMs ?? 0;
		expect((await store.unhealthy(due - 1)).has(KEY)).toBe(true);
		expect((await store.unhealthy(due)).has(KEY)).toBe(false);
		// The trial is missed: the back-off doubles.
		await feedProviderHealth(store, queued(4, due), due + 11 * MINUTE);
		expect((await store.get(KEY)).backoffMs).toBe(
			2 * PROVIDER_HEALTH_DEFAULTS.firstBackoffMs,
		);
		// The next trial starts: the type is healthy again.
		const started = create(JobFactSchema, {
			...queued(5, now + 60 * MINUTE),
			startedAtMs: now + 61 * MINUTE,
		});
		await feedProviderHealth(store, started, now + 62 * MINUTE);
		const cleared = await store.get(KEY);
		expect(cleared.trippedAtMs).toBeUndefined();
		expect(cleared.outcomes).toEqual([]);
	});

	it("ignores GitHub's, machine and fleet labels and a job cancelled early", async () => {
		const store = new SqliteProviderHealthStore(":memory:");
		await feedProviderHealth(
			store,
			queued(1, T0, ["ubuntu-24.04", "self-hosted", "hobo"]),
			T0 + 20 * MINUTE,
		);
		expect(await store.list()).toEqual([]);
		const cancelled = create(JobFactSchema, {
			...queued(2, T0),
			completedAtMs: T0 + 2 * MINUTE,
		});
		expect(providerOutcomeOfJob(cancelled, T0 + 20 * MINUTE)).toBeUndefined();
	});
});
