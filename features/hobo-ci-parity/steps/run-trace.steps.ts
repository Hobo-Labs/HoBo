/**
 * Steps for gauntlet case I07 (features/hobo-ci-parity/insights.feature): one
 * OpenTelemetry trace per run attempt. The GitHub simulator sends signed
 * `workflow_job` and `workflow_run` webhooks to a handler that folds them
 * into an in-memory insight store through `RunTraceIngest`, the code a relay
 * runs, and every OTLP export it makes is kept. No step reaches the network.
 */
import assert from "node:assert/strict";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import type { InsightRun } from "../../../packages/ci/src/insights/types.js";
import { InMemoryInsightStore } from "../../../packages/ci/src/runner-order/testing.js";
import type { InsightAttemptStore } from "../../../packages/ci-gh-actions/src/insight-ingest.js";
import {
	jobSpanId,
	RunTraceIngest,
	runAttemptSpanId,
	runAttemptTraceId,
} from "../../../packages/ci-gh-actions/src/run-trace.js";
import { verifyWebhookSignature } from "../../../packages/ci-gh-actions/src/webhook-signature.js";
import { GithubSimulator } from "../../../packages/ci-gh-actions/test/support/github-simulator/index.js";

type ExportedSpan = Readonly<{
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
}>;

/** The in-memory store, with the one keyed read folding needs. */
class TraceHistory extends InMemoryInsightStore implements InsightAttemptStore {
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

type TraceState = {
	runId: number;
	attempt: number;
	jobId: number;
	/** The OTLP exports made by each delivery round, in order. */
	rounds: ExportedSpan[][];
};

let trace: TraceState;

Before({ tags: "@I07" }, () => {
	trace = { runId: 0, attempt: 2, jobId: 0, rounds: [] };
});

Given(
	"job and run webhooks for one run attempt delivered at different times",
	async () => {
		const sim = new GithubSimulator();
		const payloads: string[] = [];
		const ingest = new RunTraceIngest({
			store: new TraceHistory(),
			sink: async (payload) => {
				payloads.push(payload);
			},
			resource: { "service.name": "hobo-ci-relay" },
		});
		const handler = async (request: Request): Promise<Response> => {
			const body = await request.text();
			const signature = verifyWebhookSignature(
				sim.webhookSecret,
				new TextEncoder().encode(body),
				request.headers.get("x-hub-signature-256") ?? undefined,
			);
			assert.equal(signature, "valid");
			await ingest.deliver(request.headers.get("x-github-event") ?? "", body);
			return new Response(null, { status: 202 });
		};
		const round = async (): Promise<void> => {
			const already = payloads.length;
			await sim.deliver(handler);
			trace.rounds.push(
				payloads
					.slice(already)
					.flatMap(
						(payload): ExportedSpan[] =>
							JSON.parse(payload).resourceSpans[0].scopeSpans[0].spans,
					),
			);
		};
		const relay = sim.queueJob({
			repository: "octo/app",
			name: "route",
			labels: ["hobo-relay"],
			runAttempt: trace.attempt,
		});
		sim.queueJob({
			repository: "octo/app",
			name: "build",
			labels: ["linux"],
			runId: relay.runId,
			runAttempt: trace.attempt,
		});
		trace.runId = relay.runId;
		trace.jobId = relay.id;
		sim.registerRunner({ name: "relay", labels: ["hobo-relay"] });
		sim.registerRunner({ name: "box", labels: ["linux"] });
		sim.advance(1_000);
		sim.claim("relay");
		sim.advance(1_000);
		sim.complete(relay.id, {
			conclusion: "success",
			steps: [{ name: "Route", conclusion: "success" }],
		});
		await round();
		sim.advance(60_000);
		const build = sim.claim("box");
		sim.advance(30_000);
		sim.complete(build?.id ?? 0, {
			conclusion: "success",
			steps: [{ name: "Build", conclusion: "success" }],
		});
		await round();
	},
);

When("their spans are exported", () => {
	assert.equal(trace.rounds.length, 2);
	assert.ok(trace.rounds.every((spans) => spans.length > 0));
});

Then("they share one trace id derived from the run id and attempt", () => {
	const [early = [], late = []] = trace.rounds;
	const expected = runAttemptTraceId(trace.runId, trace.attempt);
	assert.ok(expected !== runAttemptTraceId(trace.runId, 1));
	for (const span of [...early, ...late]) assert.equal(span.traceId, expected);
	const job = early.find((span) => span.spanId === jobSpanId(trace.jobId));
	const root = late.find((span) => span.parentSpanId === undefined);
	assert.ok(job, "the relay job's span went out with its own webhook");
	assert.equal(
		early.some((span) => span.parentSpanId === undefined),
		false,
		"the run span was not sent with the job's",
	);
	assert.ok(root, "the run span went out with the run's webhook");
	assert.equal(root.spanId, runAttemptSpanId(trace.runId, trace.attempt));
	assert.equal(job.parentSpanId, root.spanId);
});
