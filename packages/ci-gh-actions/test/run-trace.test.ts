import { create } from "@bufbuild/protobuf";
import { type RunnerRouteEvent, RunnerRouteEventSchema } from "@hobo/ci";
import type { InsightJob, InsightRun } from "@hobo/ci/insights";
import {
	InMemoryInsightStore,
	InMemoryRouteJournal,
	testRouteRequest,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import type { InsightAttemptStore } from "../src/insight-ingest.js";
import type { RelaySpan, RelayTraceSink } from "../src/relay-trace.js";
import { runTraceId } from "../src/relay-trace.js";
import {
	exportRunTrace,
	finishedRunSpans,
	jobSpanId,
	journalRunRoutes,
	RUNNER_WAIT_SPAN_NAME,
	RunTraceIngest,
	runAttemptSpanId,
	runAttemptTraceId,
	runTraceSpans,
} from "../src/run-trace.js";
import { verifyWebhookSignature } from "../src/webhook-signature.js";
import { GithubSimulator } from "./support/github-simulator/index.js";

type ExportedSpan = Readonly<{
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	status: { code: number };
	attributes: readonly { key: string; value: { stringValue?: string } }[];
}>;

function collector() {
	const payloads: string[] = [];
	const sink: RelayTraceSink = async (payload) => {
		payloads.push(payload);
	};
	const exports = (): ExportedSpan[][] =>
		payloads.map(
			(payload) => JSON.parse(payload).resourceSpans[0].scopeSpans[0].spans,
		);
	return { sink, payloads, exports };
}

class History extends InMemoryInsightStore implements InsightAttemptStore {
	async attempt(
		repository: string,
		id: number,
		attempt: number,
	): Promise<InsightRun | undefined> {
		const all = await this.runs({
			repository,
			sinceMs: 0,
			limit: Number.MAX_SAFE_INTEGER,
		});
		return all.find((run) => run.id === id && run.attempt === attempt);
	}
}

const T0 = Date.parse("2026-11-10T09:00:00Z");

function job(overrides: Partial<InsightJob> = {}): InsightJob {
	return {
		id: 501,
		name: "build",
		labels: ["ubuntu-24.04"],
		runnerName: "GitHub Actions 7",
		conclusion: "success",
		queuedAtMs: T0 + 1_000,
		startedAtMs: T0 + 6_000,
		completedAtMs: T0 + 60_000,
		billed: true,
		steps: [
			{
				name: "Set up job",
				number: 1,
				conclusion: "success",
				startedAtMs: T0 + 6_000,
				completedAtMs: T0 + 8_000,
			},
			{
				name: "Test",
				number: 2,
				conclusion: "success",
				startedAtMs: T0 + 8_000,
				completedAtMs: T0 + 59_000,
			},
			{ name: "Deploy", number: 3, conclusion: "skipped" },
		],
		...overrides,
	};
}

function run(overrides: Partial<InsightRun> = {}): InsightRun {
	return {
		id: 9001,
		attempt: 1,
		repository: "octo/app",
		workflow: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "main",
		defaultBranch: "main",
		headSha: "0123456789abcdef0123456789abcdef01234567",
		actor: "octocat",
		conclusion: "success",
		createdAtMs: T0,
		completedAtMs: T0 + 61_000,
		jobs: [job()],
		...overrides,
	};
}

const attribute = (span: RelaySpan, key: string) => span.attributes[key];

function decided(
	init: Readonly<{
		job: string;
		atMs: number;
		step: string;
		runId?: number;
		attempt?: number;
	}>,
): RunnerRouteEvent {
	const request = testRouteRequest("octo/app", init.runId ?? 9001);
	request.job = init.job;
	request.runAttempt = init.attempt ?? 1;
	return create(RunnerRouteEventSchema, {
		type: "runner.route.Decided",
		accountId: "acct-1",
		atMs: init.atMs,
		request,
		decision: {
			outcome: "routed",
			runner: "depot-ubuntu-24.04",
			step: init.step,
			skipped: [{ key: "fleet", reason: "full", detail: "" }],
		},
		mode: "relay",
		node: "node-1",
		jobId: `${init.job}-${init.atMs}`,
	});
}

describe("runAttemptTraceId", () => {
	it("keeps the run's own trace for the first attempt and gives a re-run its own", () => {
		expect(runAttemptTraceId(9001, 1)).toBe(runTraceId(9001));
		expect(runAttemptTraceId(9001, 2)).toMatch(/^[0-9a-f]{32}$/);
		expect(runAttemptTraceId(9001, 2)).not.toBe(runAttemptTraceId(9001, 1));
		expect(runAttemptTraceId(9001, 2)).toBe(runAttemptTraceId(9001, 2));
		expect(runAttemptTraceId(9001, 2)).not.toBe(runAttemptTraceId(9002, 2));
		expect(runAttemptSpanId(9001, 1)).toMatch(/^[0-9a-f]{16}$/);
		expect(runAttemptSpanId(9001, 1)).not.toBe(runAttemptSpanId(9001, 2));
	});
});

describe("runTraceSpans", () => {
	it("has a root per attempt, a job from queued to finished with its wait, and each step that ran", () => {
		const spans = runTraceSpans(run(), []);
		const traceId = runAttemptTraceId(9001, 1);
		expect(spans.every((span) => span.traceId === traceId)).toBe(true);
		expect(spans.map((span) => span.name)).toEqual([
			"RUN CI",
			"build",
			RUNNER_WAIT_SPAN_NAME,
			"Set up job",
			"Test",
		]);
		const [root, build, wait, setup] = spans;
		expect(root).toMatchObject({
			parentSpanId: "",
			spanId: runAttemptSpanId(9001, 1),
			startMs: T0,
			endMs: T0 + 61_000,
			error: false,
		});
		expect(build).toMatchObject({
			spanId: jobSpanId(501),
			parentSpanId: root?.spanId,
			startMs: T0 + 1_000,
			endMs: T0 + 60_000,
		});
		expect(wait).toMatchObject({
			parentSpanId: build?.spanId,
			startMs: T0 + 1_000,
			endMs: T0 + 6_000,
		});
		expect(setup?.parentSpanId).toBe(build?.spanId);
		expect(root && attribute(root, "cicd.pipeline.result")).toBe("success");
		expect(root && attribute(root, "cicd.pipeline.run.id")).toBe("9001");
		expect(root && attribute(root, "vcs.repository.name")).toBe("octo/app");
		expect(root && attribute(root, "vcs.ref.head.name")).toBe("main");
		expect(root && attribute(root, "vcs.ref.head.revision")).toBe(
			"0123456789abcdef0123456789abcdef01234567",
		);
		expect(build && attribute(build, "cicd.pipeline.task.run.id")).toBe("501");
		expect(build && attribute(build, "cicd.pipeline.task.run.url.full")).toBe(
			"https://github.com/octo/app/actions/runs/9001/job/501",
		);
		expect(build && attribute(build, "cicd.worker.name")).toBe(
			"GitHub Actions 7",
		);
	});

	it("marks a failure with an error status and a timeout as a timeout, but not a cancel", () => {
		const spans = runTraceSpans(
			run({
				conclusion: "failure",
				jobs: [
					job({
						conclusion: "failure",
						steps: [
							{
								name: "Test",
								number: 2,
								conclusion: "failure",
								startedAtMs: T0 + 8_000,
								completedAtMs: T0 + 30_000,
							},
						],
					}),
					job({ id: 502, name: "lint", conclusion: "timed_out", steps: [] }),
					job({ id: 503, name: "docs", conclusion: "cancelled", steps: [] }),
				],
			}),
			[],
		);
		const named = (name: string) => spans.find((span) => span.name === name);
		expect(named("RUN CI")?.error).toBe(true);
		expect(named("RUN CI")?.attributes["error.type"]).toBe("failure");
		expect(named("build")?.error).toBe(true);
		expect(named("Test")?.error).toBe(true);
		expect(named("lint")?.attributes["cicd.pipeline.task.run.result"]).toBe(
			"timeout",
		);
		expect(named("lint")?.error).toBe(true);
		expect(named("docs")?.error).toBe(false);
		expect(named("docs")?.attributes["cicd.pipeline.task.run.result"]).toBe(
			"cancellation",
		);
		expect(named("docs")?.attributes["error.type"]).toBeUndefined();
	});

	it("leaves out a run and jobs that have not finished, and counts a job no runner took as all wait", () => {
		const spans = runTraceSpans(
			run({
				completedAtMs: undefined,
				conclusion: "unknown",
				jobs: [
					job({ id: 601, completedAtMs: undefined, conclusion: "unknown" }),
					job({
						id: 602,
						name: "never",
						startedAtMs: undefined,
						completedAtMs: T0 + 90_000,
						conclusion: "cancelled",
						steps: [],
					}),
				],
			}),
			[],
		);
		expect(spans.map((span) => span.name)).toEqual([
			"never",
			RUNNER_WAIT_SPAN_NAME,
		]);
		expect(spans[1]).toMatchObject({ startMs: T0 + 1_000, endMs: T0 + 90_000 });
		expect(spans[1]?.attributes["hobo.ci.runner_taken"]).toBe(false);
	});

	it("puts the route decision on the relay job and the jobs that need it", () => {
		const routes = [
			decided({ job: "route", atMs: T0 + 2_000, step: "fleet" }),
			decided({ job: "route", atMs: T0 + 3_000, step: "depot" }),
			decided({ job: "route", atMs: T0 + 3_000, step: "other", runId: 1 }),
		];
		const spans = runTraceSpans(
			run({
				jobs: [
					job({ id: 701, name: "route", relay: true, steps: [] }),
					job({ id: 702, name: "build", needs: ["route"], steps: [] }),
					job({ id: 703, name: "alone", steps: [] }),
				],
			}),
			routes,
		);
		const named = (name: string) => spans.find((span) => span.name === name);
		for (const name of ["route", "build"]) {
			expect(named(name)?.attributes).toMatchObject({
				"hobo.ci.route.step": "depot",
				"hobo.ci.route.outcome": "routed",
				"hobo.ci.route.skipped": "fleet:full",
			});
		}
		expect(named("route")?.attributes["hobo.ci.relay"]).toBe(true);
		expect(named("alone")?.attributes["hobo.ci.route.step"]).toBeUndefined();
	});
});

describe("finishedRunSpans", () => {
	it("returns only what this webhook finished", () => {
		const running = run({
			completedAtMs: undefined,
			conclusion: "unknown",
			jobs: [job({ completedAtMs: undefined, conclusion: "unknown" })],
		});
		const jobDone = run({ completedAtMs: undefined, conclusion: "unknown" });
		const runDone = run();
		expect(finishedRunSpans(undefined, running, [])).toEqual([]);
		expect(
			finishedRunSpans(running, jobDone, []).map((span) => span.name),
		).toEqual(["build", RUNNER_WAIT_SPAN_NAME, "Set up job", "Test"]);
		expect(
			finishedRunSpans(jobDone, runDone, []).map((span) => span.name),
		).toEqual(["RUN CI"]);
		expect(finishedRunSpans(runDone, runDone, [])).toEqual([]);
	});
});

describe("exportRunTrace", () => {
	it("sends one OTLP export through the sink, and nothing for no spans", async () => {
		const { sink, exports } = collector();
		await exportRunTrace(sink, { "service.name": "hobo-ci-relay" }, []);
		expect(exports()).toEqual([]);
		await exportRunTrace(
			sink,
			{ "service.name": "hobo-ci-relay" },
			runTraceSpans(run({ conclusion: "failure" }), []),
		);
		const [spans] = exports();
		expect(spans?.[0]?.status.code).toBe(2);
		expect(spans?.[1]?.parentSpanId).toBe(spans?.[0]?.spanId);
	});
});

describe("RunTraceIngest against the GitHub simulator (I07)", () => {
	async function scenario(attempt: number) {
		const sim = new GithubSimulator();
		const { sink, exports } = collector();
		const journal = new InMemoryRouteJournal();
		const ingest = new RunTraceIngest({
			store: new History(),
			sink,
			resource: { "service.name": "hobo-ci-relay" },
			routes: journalRunRoutes(journal, "acct-1"),
		});
		const handler = async (request: Request) => {
			const body = await request.text();
			expect(
				verifyWebhookSignature(
					sim.webhookSecret,
					new TextEncoder().encode(body),
					request.headers.get("x-hub-signature-256") ?? undefined,
				),
			).toBe("valid");
			await ingest.deliver(request.headers.get("x-github-event") ?? "", body);
			return new Response(null, { status: 202 });
		};
		const first = sim.queueJob({
			repository: "octo/app",
			name: "route",
			labels: ["hobo-relay"],
			runAttempt: attempt,
		});
		sim.queueJob({
			repository: "octo/app",
			name: "build",
			labels: ["linux"],
			runId: first.runId,
			runAttempt: attempt,
		});
		await journal.record(
			decided({
				job: "route",
				atMs: sim.nowMs(),
				step: "github",
				runId: first.runId,
				attempt,
			}),
		);
		sim.registerRunner({ name: "relay", labels: ["hobo-relay"] });
		sim.registerRunner({ name: "box", labels: ["linux"] });
		sim.advance(1_000);
		const relay = sim.claim("relay");
		sim.advance(1_000);
		sim.complete(relay?.id ?? 0, {
			conclusion: "success",
			steps: [{ name: "Route", conclusion: "success" }],
		});
		await sim.deliver(handler);
		const afterJob = exports().length;
		sim.advance(60_000);
		const build = sim.claim("box");
		sim.advance(30_000);
		sim.complete(build?.id ?? 0, {
			conclusion: "failure",
			steps: [{ name: "Test", conclusion: "failure" }],
		});
		await sim.deliver(handler);
		return {
			sim,
			handler,
			exports,
			afterJob,
			runId: first.runId,
			relayId: relay?.id,
		};
	}

	it("joins a job span and the run span sent at different times in one trace", async () => {
		const { exports, afterJob, runId, relayId } = await scenario(1);
		const sent = exports();
		expect(afterJob).toBeGreaterThan(0);
		const early = sent.slice(0, afterJob).flat();
		const late = sent.slice(afterJob).flat();
		const root = late.find((span) => span.parentSpanId === undefined);
		expect(early.some((span) => span.name === "route")).toBe(true);
		expect(early.some((span) => span.parentSpanId === undefined)).toBe(false);
		expect(root).toBeDefined();
		const traceId = runAttemptTraceId(runId, 1);
		expect(sent.flat().every((span) => span.traceId === traceId)).toBe(true);
		const routeSpan = early.find((span) => span.name === "route");
		expect(routeSpan?.spanId).toBe(jobSpanId(relayId ?? 0));
		expect(routeSpan?.parentSpanId).toBe(root?.spanId);
		expect(
			routeSpan?.attributes.find((entry) => entry.key === "hobo.ci.route.step")
				?.value.stringValue,
		).toBe("github");
		expect(root?.status.code).toBe(2);
	});

	it("gives a re-run attempt a trace of its own", async () => {
		const { exports, runId } = await scenario(2);
		const ids = new Set(
			exports()
				.flat()
				.map((span) => span.traceId),
		);
		expect([...ids]).toEqual([runAttemptTraceId(runId, 2)]);
		expect(runAttemptTraceId(runId, 2)).not.toBe(runTraceId(runId));
	});

	it("exports nothing again for a webhook delivered twice", async () => {
		const { sim, handler, exports } = await scenario(1);
		const before = exports().length;
		for (const delivery of sim.deliveries()) sim.redeliver(delivery.id);
		await sim.deliver(handler);
		expect(exports().length).toBe(before);
	});
});
