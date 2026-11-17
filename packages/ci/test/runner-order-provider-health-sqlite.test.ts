import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { type JobFact, JobFactSchema } from "../src/_generated/relay_job_pb.js";
import {
	answerRelayJob,
	NO_ROUTE_FACTS,
	newProviderHealth,
	PROVIDER_HEALTH_DEFAULTS,
	providerHealthKey,
	recordProviderOutcome,
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

	it("does not count a burst routed before the trip as failed trials", async () => {
		const store = new SqliteProviderHealthStore(":memory:");
		// Six jobs fanned out in the same second, and all of them missed.
		for (let id = 1; id <= 6; id += 1)
			await feedProviderHealth(store, queued(id, T0), T0 + 11 * MINUTE);
		const health = await store.get(KEY);
		expect(health.trippedAtMs).toBe(
			T0 + PROVIDER_HEALTH_DEFAULTS.missedAfterMs,
		);
		expect(health.backoffMs).toBe(PROVIDER_HEALTH_DEFAULTS.firstBackoffMs);
		expect(health.nextTrialAtMs).toBe(
			T0 +
				PROVIDER_HEALTH_DEFAULTS.missedAfterMs +
				PROVIDER_HEALTH_DEFAULTS.firstBackoffMs,
		);
	});

	it("counts only the miss of a job queued once the trial was let through", async () => {
		const store = new SqliteProviderHealthStore(":memory:");
		await missThree(store);
		const due = (await store.get(KEY)).nextTrialAtMs ?? 0;
		await store.put(KEY, {
			...(await store.get(KEY)),
			trialStartedAtMs: due + MINUTE,
		});
		// Queued after the trip but before the trial: not the trial.
		await feedProviderHealth(store, queued(4, due), due + 20 * MINUTE);
		expect((await store.get(KEY)).backoffMs).toBe(
			PROVIDER_HEALTH_DEFAULTS.firstBackoffMs,
		);
		// The trial itself misses: the back-off doubles.
		await feedProviderHealth(store, queued(5, due + MINUTE), due + 20 * MINUTE);
		expect((await store.get(KEY)).backoffMs).toBe(
			2 * PROVIDER_HEALTH_DEFAULTS.firstBackoffMs,
		);
	});

	it("does not let a late start from before the outage clear a tripped type", async () => {
		const store = new SqliteProviderHealthStore(":memory:");
		const now = await missThree(store);
		const old = create(JobFactSchema, {
			...queued(9, T0 - 30 * MINUTE),
			startedAtMs: T0 - 29 * MINUTE,
		});
		expect(await feedProviderHealth(store, old, now)).toEqual([]);
		expect((await store.unhealthy(now)).has(KEY)).toBe(true);
	});

	it("does not count misses reported out of order as three in thirty minutes", async () => {
		const store = new SqliteProviderHealthStore(":memory:");
		// A backfill reads the newest job first: misses at T+30m, T-10m, T-5m.
		for (const [id, at] of [
			[1, T0 + 20 * MINUTE],
			[2, T0 - 20 * MINUTE],
			[3, T0 - 15 * MINUTE],
		] as const)
			await feedProviderHealth(store, queued(id, at), T0 + 60 * MINUTE);
		const health = await store.get(KEY);
		expect(health.trippedAtMs).toBeUndefined();
		expect(health.outcomes).toEqual([
			{ atMs: T0 + 30 * MINUTE, started: false },
		]);
		expect((await store.unhealthy(T0 + 60 * MINUTE)).has(KEY)).toBe(false);
	});

	it("keeps neither the mark nor the record when writing fails", async () => {
		const store = new SqliteProviderHealthStore(":memory:");
		const outcome = { atMs: T0, started: false };
		await expect(
			store.recordJobOutcome(KEY, 1, outcome, () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		const written = await store.recordJobOutcome(
			KEY,
			1,
			outcome,
			(current) => ({
				...current,
				outcomes: [outcome],
			}),
		);
		expect(written?.outcomes).toEqual([outcome]);
		expect((await store.get(KEY)).outcomes).toEqual([outcome]);
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

describe("recordProviderOutcome window (R09)", () => {
	it("measures the window from the earliest to the latest miss, whatever their order", () => {
		const record = (times: readonly number[]) =>
			times.reduce(
				(health, atMs) =>
					recordProviderOutcome(health, { atMs, started: false }),
				newProviderHealth(),
			);
		expect(record([40 * MINUTE, 0, 5 * MINUTE]).trippedAtMs).toBeUndefined();
		const inside = record([20 * MINUTE, 0, 5 * MINUTE]);
		expect(inside.trippedAtMs).toBe(20 * MINUTE);
		expect(inside.nextTrialAtMs).toBe(
			20 * MINUTE + PROVIDER_HEALTH_DEFAULTS.firstBackoffMs,
		);
	});
});
