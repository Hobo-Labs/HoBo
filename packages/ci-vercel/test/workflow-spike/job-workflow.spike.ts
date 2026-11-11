// SPIKE: proves the Workflow SDK behaviours the relay would rely on, against
// the Local World (no network). Run: pnpm --filter @hobo/ci-vercel test:workflow-spike

import { waitForHook } from "@workflow/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { getWorld } from "workflow/runtime";
import {
	type JobDelivery,
	type JobOutcome,
	jobToken,
	jobWorkflow,
	lateHookWorkflow,
	type SpikeJob,
	shortHookWorkflow,
} from "../../src/workflow-spike/job-workflow.js";

interface SpikeProbe {
	dispatchFailures?: number;
	dispatchGate?: Promise<void>;
	calls: string[];
}

// SAFETY: the probe global is optional and written only by this file.
const scope = globalThis as { __workflowSpikeProbe?: SpikeProbe };

function installProbe(init: Omit<SpikeProbe, "calls"> = {}): SpikeProbe {
	const probe: SpikeProbe = { ...init, calls: [] };
	scope.__workflowSpikeProbe = probe;
	return probe;
}

interface Gate {
	readonly promise: Promise<void>;
	readonly open: () => void;
}

function gate(): Gate {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

let nextJob = 1000;
function freshJob(): SpikeJob {
	nextJob += 1;
	return { repo: "hobo-labs/hobo", jobId: nextJob, attempt: 1 };
}

const longDeadlines = { pickup: 600_000, run: 600_000 } as const;

/** The run's event log once its terminal event is written. */
async function eventTypes(runId: string): Promise<string[]> {
	const world = await getWorld();
	let types: string[] = [];
	for (let i = 0; i < 40; i++) {
		const page = await world.events.list({ runId });
		types = page.data.map((event) => event.eventType);
		if (types.some((type) => /^run_(completed|failed|cancelled)$/.test(type)))
			return types;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return types;
}

async function ownerOf(token: string): Promise<{ runId: string }> {
	for (let i = 0; i < 300; i++) {
		try {
			return await getHookByToken(token);
		} catch (error) {
			if (!HookNotFoundError.is(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error(`no run registered ${token}`);
}

function tally(types: readonly string[]) {
	const counts = new Map<string, number>();
	for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
	return counts;
}

afterEach(() => {
	delete scope.__workflowSpikeProbe;
});

describe("2a: one run per job token", () => {
	it("N concurrent starts create N runs; exactly one owns the token (workflow@5.2.3)", async () => {
		installProbe();
		const job = freshJob();
		const N = 8;
		const runs = await Promise.all(
			Array.from({ length: N }, () => start(jobWorkflow, [job, longDeadlines])),
		);
		// On 5.2.x start() has no atomic admission: every call is a run.
		expect(new Set(runs.map((run) => run.runId)).size).toBe(N);

		const owner = await ownerOf(jobToken(job));
		const duplicates = runs.filter((run) => run.runId !== owner.runId);
		const losers: JobOutcome[] = await Promise.all(
			duplicates.map((run) => run.returnValue),
		);
		expect(losers).toHaveLength(N - 1);
		for (const loser of losers) {
			expect(loser).toEqual({ kind: "duplicate", ownerRunId: owner.runId });
		}
		// Losers ran no step: getConflict() is awaited before the first step.
		const ownerRun = runs.find((run) => run.runId === owner.runId);
		await resumeHook<JobDelivery>(jobToken(job), {
			deliveryId: "d-done",
			action: "completed",
			conclusion: "success",
		});
		expect(await ownerRun?.returnValue).toMatchObject({ kind: "completed" });
		const loserEvents = tally(await eventTypes(duplicates[0]?.runId ?? ""));
		// A duplicate run costs run + hook_conflict events, but runs no step.
		expect(loserEvents.get("step_created")).toBeUndefined();
		console.log(
			`[2a] ${N} starts -> ${N} runs, owner ${owner.runId}, ${losers.length} returned duplicate; one loser's events`,
			Object.fromEntries(loserEvents),
		);
	});

	it("start({ experimental_hook }) is not available on 5.2.3: the option is silently ignored", async () => {
		installProbe();
		const job = freshJob();
		// SAFETY: deliberately passes an option 5.2.3's types lack, to observe the runtime.
		const options = { experimental_hook: { token: jobToken(job) } } as never;
		const a = await start(jobWorkflow, [job, longDeadlines], options);
		const b = await start(jobWorkflow, [job, longDeadlines], options);
		// No HookConflictError was thrown: both calls became runs.
		expect(a.runId).not.toBe(b.runId);
		const outcomes = await Promise.race([
			a.returnValue.then((value) => ({ run: "a", value })),
			b.returnValue.then((value) => ({ run: "b", value })),
		]);
		expect(outcomes.value).toMatchObject({ kind: "duplicate" });
		await resumeHook<JobDelivery>(jobToken(job), {
			deliveryId: "d-done",
			action: "completed",
			conclusion: "success",
		});
		await Promise.all([a.returnValue, b.returnValue]);
	});
});

describe("1: starting a run from untransformed code", () => {
	it("start() accepts the manifest workflowId, so the relay's api/ functions need no SWC transform", async () => {
		installProbe();
		const job = freshJob();
		// The id the builder writes to manifest.json for this file and export.
		const workflowId =
			"workflow//./src/workflow-spike/job-workflow//jobWorkflow";
		const run = await start({ workflowId }, [
			job,
			{ pickup: 200, run: 600_000 },
		]);
		expect(await run.returnValue).toMatchObject({ kind: "timed_out" });
	});
});

describe("2b: hook delivery", () => {
	it("resumeHook before the run registers its hook is refused, not buffered", async () => {
		const held = gate();
		installProbe({ dispatchGate: held.promise });
		const token = `late:${freshJob().jobId}`;
		const run = await start(lateHookWorkflow, [token]);
		// The run is parked in a step before createHook(): nothing holds the token.
		await expect(
			resumeHook<JobDelivery>(token, { deliveryId: "early", action: "queued" }),
		).rejects.toBeInstanceOf(HookNotFoundError);
		held.open();
		await waitForHook(run, { token });
		await resumeHook<JobDelivery>(token, {
			deliveryId: "d1",
			action: "completed",
		});
		const received = await run.returnValue;
		expect(received.map((d) => d.deliveryId)).toEqual(["d1"]);
	});

	it("payloads sent after registration but before the run awaits are buffered in order; duplicates are redelivered and deduped in-run", async () => {
		const held = gate();
		const probe = installProbe({ dispatchGate: held.promise });
		const job = freshJob();
		const token = jobToken(job);
		const run = await start(jobWorkflow, [job, longDeadlines]);
		await waitForHook(run, { token });
		// The run is now blocked inside the dispatch step, not awaiting the hook.
		const send = (delivery: JobDelivery) => resumeHook(token, delivery);
		await send({ deliveryId: "gh-1", action: "queued" });
		await send({ deliveryId: "gh-2", action: "in_progress" });
		await send({ deliveryId: "gh-2", action: "in_progress" }); // redelivery
		await send({
			deliveryId: "gh-3",
			action: "completed",
			conclusion: "success",
		});
		held.open();
		const outcome = await run.returnValue;
		expect(outcome).toEqual({
			kind: "completed",
			conclusion: "success",
			accepted: ["gh-1", "gh-2", "gh-3"],
			duplicatesDropped: 1,
			dispatchAttempt: 1,
		});
		expect(probe.calls).toContain(`settle:${job.jobId}:success`);
		const counts = tally(await eventTypes(run.runId));
		// Both copies of gh-2 were recorded and delivered to the run.
		expect(counts.get("hook_received")).toBe(4);
		console.log(
			"[2b] events for a buffered lifecycle",
			Object.fromEntries(counts),
		);
	});
});

describe("2c: retries and timeouts", () => {
	it("a throwing step is retried until it succeeds", async () => {
		const probe = installProbe({ dispatchFailures: 2 });
		const job = freshJob();
		const run = await start(jobWorkflow, [job, longDeadlines]);
		await waitForHook(run, { token: jobToken(job) });
		await resumeHook<JobDelivery>(jobToken(job), {
			deliveryId: "gh-9",
			action: "completed",
			conclusion: "failure",
		});
		const outcome = await run.returnValue;
		expect(outcome).toMatchObject({ kind: "completed", dispatchAttempt: 3 });
		expect(probe.calls.filter((call) => call.startsWith("dispatch:"))).toEqual([
			`dispatch:${job.jobId}:hobo-${job.jobId}-1:attempt-1`,
			`dispatch:${job.jobId}:hobo-${job.jobId}-1:attempt-2`,
			`dispatch:${job.jobId}:hobo-${job.jobId}-1:attempt-3`,
		]);
		const counts = tally(await eventTypes(run.runId));
		console.log(
			"[2c] events with 2 dispatch retries",
			Object.fromEntries(counts),
		);
	});

	it("a durable sleep() deadline fires when no webhook arrives", async () => {
		const probe = installProbe();
		const job = freshJob();
		const startedAt = Date.now();
		const run = await start(jobWorkflow, [job, { pickup: 300, run: 600_000 }]);
		const outcome = await run.returnValue;
		const elapsed = Date.now() - startedAt;
		expect(outcome).toMatchObject({
			kind: "timed_out",
			conclusion: "pickup_timeout",
			accepted: [],
		});
		expect(elapsed).toBeGreaterThanOrEqual(300);
		expect(probe.calls).toContain(`settle:${job.jobId}:pickup_timeout`);
		const counts = tally(await eventTypes(run.runId));
		console.log(
			`[2c] pickup timeout after ${elapsed}ms`,
			Object.fromEntries(counts),
		);
	});
});

describe("2d: token after the run ends", () => {
	it("without retention the token is released when the run ends", async () => {
		const token = `reuse:${freshJob().jobId}`;
		const first = await start(shortHookWorkflow, [token]);
		await waitForHook(first, { token });
		await resumeHook<JobDelivery>(token, {
			deliveryId: "a",
			action: "completed",
		});
		expect(await first.returnValue).toBe("a");
		const second = await start(shortHookWorkflow, [token]);
		await waitForHook(second, { token });
		await resumeHook<JobDelivery>(token, {
			deliveryId: "b",
			action: "completed",
		});
		expect(await second.returnValue).toBe("b");
	});

	it("with experimental_minRetention a finished run keeps refusing the token until retention passes", async () => {
		const token = `retain:${freshJob().jobId}`;
		const retainMs = 3_000;
		const first = await start(shortHookWorkflow, [token, retainMs]);
		const createdAt = Date.now();
		await waitForHook(first, { token });
		await resumeHook<JobDelivery>(token, {
			deliveryId: "a",
			action: "completed",
		});
		expect(await first.returnValue).toBe("a");
		expect(await getRun(first.runId).status).toBe("completed");

		const blocked = await start(shortHookWorkflow, [token]);
		expect(await blocked.returnValue).toBe(`duplicate:${first.runId}`);
		await expect(
			resumeHook<JobDelivery>(token, { deliveryId: "x", action: "completed" }),
		).rejects.toBeInstanceOf(HookNotFoundError);

		const wait = retainMs - (Date.now() - createdAt) + 500;
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		const after = await start(shortHookWorkflow, [token]);
		await waitForHook(after, { token });
		await resumeHook<JobDelivery>(token, {
			deliveryId: "c",
			action: "completed",
		});
		expect(await after.returnValue).toBe("c");
	});
});
