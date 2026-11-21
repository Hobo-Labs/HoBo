/**
 * One OpenTelemetry trace per workflow run attempt, built from the run, job
 * and step facts a relay already stores (ADR-0183), and sent through the
 * relay's existing OTLP sink (`./relay-trace.ts`).
 *
 * The trace has a root span for the attempt, a span per job from the moment
 * it was queued to the moment it finished with a "waiting for a runner"
 * child, and a span per step that ran. Every trace and span id is a hash of
 * GitHub's own ids, so a job span sent when its job finishes and the run span
 * sent minutes later, by this process or another relay node, land in one
 * trace with the right parent and never need to pass context to each other.
 *
 * A part is exported once it has finished: `finishedRunSpans` compares the
 * attempt before and after a webhook and returns only what that webhook
 * finished, so a webhook GitHub delivers twice exports nothing the second
 * time.
 *
 * Attributes follow OpenTelemetry's `cicd.*` and `vcs.*` semantic
 * conventions (https://opentelemetry.io/docs/specs/semconv/registry/attributes/cicd/
 * and .../vcs/, and the pipeline span rules at
 * https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/, read on
 * 2026-11-17). A job that a relay routed also carries the route decision as
 * `hobo.ci.route.step`, `hobo.ci.route.outcome` and `hobo.ci.route.skipped`.
 *
 * Nothing here reads a clock, a log or a secret: a span holds only what the
 * stored facts hold.
 */
import { createHash } from "node:crypto";
import type { RouteJournal, RunnerRouteEvent } from "@hobo/ci";
import type {
	InsightConclusion,
	InsightJob,
	InsightRun,
	InsightStep,
} from "@hobo/ci/insights";
import {
	type InsightAttemptStore,
	InsightIngest,
	parseInsightWebhook,
} from "./insight-ingest.js";
import {
	type RelaySpan,
	type RelayTraceSink,
	runTraceId,
	type TraceFields,
	toOtlpTraces,
} from "./relay-trace.js";

// public-contract: the name of the span for the time a job waited for a runner.
export const RUNNER_WAIT_SPAN_NAME = "waiting for a runner";

const hash = (text: string, bytes: number): string =>
	createHash("sha256")
		.update(text)
		.digest("hex")
		.slice(0, bytes * 2);

/**
 * The trace of one run attempt. The first attempt keeps the run's own trace
 * (`runTraceId`), which the relay's GitHub-call spans and a job's Turbo trace
 * (`scripts/ci/ci-trace.mts`) already write into; a re-run is a trace of its
 * own.
 */
export function runAttemptTraceId(runId: number, attempt: number): string {
	return attempt <= 1
		? runTraceId(runId)
		: hash(`github-actions-run:${runId}:attempt:${attempt}`, 16);
}

/** The root span of a run attempt. */
export function runAttemptSpanId(runId: number, attempt: number): string {
	return hash(`github-actions-run:${runId}:attempt:${attempt}:span`, 8);
}

/** A job's span. GitHub job ids are unique across runs and attempts. */
export function jobSpanId(jobId: number): string {
	return hash(`github-actions-job:${jobId}`, 8);
}

const waitSpanId = (jobId: number): string =>
	hash(`github-actions-job:${jobId}:wait`, 8);

const stepSpanId = (jobId: number, step: number): string =>
	hash(`github-actions-job:${jobId}:step:${step}`, 8);

/** `cicd.pipeline.result` and `cicd.pipeline.task.run.result` for a conclusion. */
const CICD_RESULT = new Map<InsightConclusion, string>([
	["success", "success"],
	["failure", "failure"],
	["cancelled", "cancellation"],
	["skipped", "skip"],
	["timed_out", "timeout"],
	["unknown", "error"],
]);

const cicdResult = (conclusion: InsightConclusion): string =>
	CICD_RESULT.get(conclusion) ?? "error";

/** A failure sets the span's error status and `error.type`; a cancel or skip does not. */
const failed = (conclusion: InsightConclusion): boolean =>
	conclusion === "failure" || conclusion === "timed_out";

const errorFields = (conclusion: InsightConclusion): TraceFields =>
	failed(conclusion) ? { "error.type": conclusion } : {};

const runUrl = (run: InsightRun): string =>
	`https://github.com/${run.repository}/actions/runs/${run.id}/attempts/${run.attempt}`;

const jobUrl = (run: InsightRun, job: InsightJob): string =>
	`https://github.com/${run.repository}/actions/runs/${run.id}/job/${job.id}`;

/** The route decision a job's span carries, as span attributes. */
function routeFields(route: RunnerRouteEvent | undefined): TraceFields {
	const decision = route?.decision;
	if (decision === undefined) return {};
	return {
		"hobo.ci.route.step": decision.step,
		"hobo.ci.route.outcome": decision.outcome,
		"hobo.ci.route.runner": decision.runner,
		"hobo.ci.route.skipped": decision.skipped
			.map((skip) => `${skip.key}:${skip.reason}`)
			.join(","),
		"hobo.ci.route.mode": route?.mode ?? "",
	};
}

/**
 * The decision behind a job: the relay job's own, matched by the relay job's
 * id (`request.job`) against the job's name, or the one of a relay job it
 * `needs`. Of several decisions for one relay job, the newest is used.
 */
export function routeForJob(
	run: InsightRun,
	job: InsightJob,
	routes: readonly RunnerRouteEvent[],
): RunnerRouteEvent | undefined {
	let chosen: RunnerRouteEvent | undefined;
	for (const route of routes) {
		const request = route.request;
		if (
			route.type !== "runner.route.Decided" ||
			route.decision === undefined ||
			request === undefined ||
			request.runId !== BigInt(run.id) ||
			Math.max(1, request.runAttempt) !== run.attempt ||
			request.repository.toLowerCase() !== run.repository.toLowerCase()
		)
			continue;
		const matches =
			request.job === job.name || (job.needs ?? []).includes(request.job);
		if (matches && (chosen === undefined || route.atMs >= chosen.atMs))
			chosen = route;
	}
	return chosen;
}

function vcsFields(run: InsightRun): TraceFields {
	return {
		"vcs.provider.name": "github",
		"vcs.repository.name": run.repository,
		"vcs.repository.url.full": `https://github.com/${run.repository}`,
		"vcs.ref.head.name": run.branch,
		"vcs.ref.head.type": "branch",
		"vcs.ref.head.revision": run.headSha,
	};
}

/** The root span of a finished attempt; undefined while it runs. */
export function runSpan(run: InsightRun): RelaySpan | undefined {
	if (run.completedAtMs === undefined) return undefined;
	return {
		traceId: runAttemptTraceId(run.id, run.attempt),
		spanId: runAttemptSpanId(run.id, run.attempt),
		parentSpanId: "",
		name: `RUN ${run.workflow}`,
		kind: "internal",
		startMs: run.createdAtMs,
		endMs: run.completedAtMs,
		error: failed(run.conclusion),
		attributes: {
			"cicd.pipeline.name": run.workflow,
			"cicd.pipeline.action.name": "RUN",
			"cicd.pipeline.run.id": `${run.id}`,
			"cicd.pipeline.run.url.full": runUrl(run),
			"cicd.pipeline.result": cicdResult(run.conclusion),
			"hobo.ci.run.attempt": run.attempt,
			"hobo.ci.event": run.event,
			"hobo.ci.workflow.path": run.workflowPath,
			...vcsFields(run),
			"vcs.change.title": run.title ?? "",
			...errorFields(run.conclusion),
		},
	};
}

function stepSpan(
	run: InsightRun,
	job: InsightJob,
	step: InsightStep,
): RelaySpan | undefined {
	if (
		step.conclusion === "skipped" ||
		step.startedAtMs === undefined ||
		step.completedAtMs === undefined
	)
		return undefined;
	return {
		traceId: runAttemptTraceId(run.id, run.attempt),
		spanId: stepSpanId(job.id, step.number),
		parentSpanId: jobSpanId(job.id),
		name: step.name,
		kind: "internal",
		startMs: step.startedAtMs,
		endMs: step.completedAtMs,
		error: failed(step.conclusion),
		attributes: {
			"hobo.ci.step.number": step.number,
			"cicd.pipeline.task.run.result": cicdResult(step.conclusion),
			...errorFields(step.conclusion),
		},
	};
}

/**
 * A finished job's spans: the job from queued to finished, the time it waited
 * for a runner (to when one took it, or to the end when none did), and each
 * step that ran. Empty while the job runs.
 */
export function jobSpans(
	run: InsightRun,
	job: InsightJob,
	routes: readonly RunnerRouteEvent[],
): readonly RelaySpan[] {
	if (job.completedAtMs === undefined) return [];
	const traceId = runAttemptTraceId(run.id, run.attempt);
	const route = routeForJob(run, job, routes);
	const waitEndMs = job.startedAtMs ?? job.completedAtMs;
	const spans: RelaySpan[] = [
		{
			traceId,
			spanId: jobSpanId(job.id),
			parentSpanId: runAttemptSpanId(run.id, run.attempt),
			name: job.name,
			kind: "internal",
			startMs: job.queuedAtMs,
			endMs: job.completedAtMs,
			error: failed(job.conclusion),
			attributes: {
				"cicd.pipeline.name": run.workflow,
				"cicd.pipeline.run.id": `${run.id}`,
				"cicd.pipeline.task.name": job.name,
				"cicd.pipeline.task.run.id": `${job.id}`,
				"cicd.pipeline.task.run.url.full": jobUrl(run, job),
				"cicd.pipeline.task.run.result": cicdResult(job.conclusion),
				"cicd.worker.name": job.runnerName ?? "",
				"hobo.ci.runs_on": job.labels.join(","),
				"hobo.ci.runner_group": job.runnerGroup ?? "",
				"hobo.ci.billed": job.billed,
				"hobo.ci.relay": job.relay === true,
				"vcs.repository.name": run.repository,
				...routeFields(route),
				...errorFields(job.conclusion),
			},
		},
		{
			traceId,
			spanId: waitSpanId(job.id),
			parentSpanId: jobSpanId(job.id),
			name: RUNNER_WAIT_SPAN_NAME,
			kind: "internal",
			startMs: job.queuedAtMs,
			endMs: Math.max(job.queuedAtMs, waitEndMs),
			error: false,
			attributes: {
				"hobo.ci.runner_taken": job.startedAtMs !== undefined,
			},
		},
	];
	for (const step of job.steps) {
		const span = stepSpan(run, job, step);
		if (span !== undefined) spans.push(span);
	}
	return spans;
}

/** Every finished part of an attempt: the run when it has finished, and each finished job. */
export function runTraceSpans(
	run: InsightRun,
	routes: readonly RunnerRouteEvent[],
): readonly RelaySpan[] {
	const root = runSpan(run);
	return [
		...(root === undefined ? [] : [root]),
		...run.jobs.flatMap((job) => jobSpans(run, job, routes)),
	];
}

/**
 * The spans one webhook finished: the run, if `after` finished it, and each
 * job `after` finished. Nothing that was already finished in `before`.
 */
export function finishedRunSpans(
	before: InsightRun | undefined,
	after: InsightRun,
	routes: readonly RunnerRouteEvent[],
): readonly RelaySpan[] {
	const spans: RelaySpan[] = [];
	if (before?.completedAtMs === undefined) {
		const root = runSpan(after);
		if (root !== undefined) spans.push(root);
	}
	for (const job of after.jobs) {
		const earlier = before?.jobs.find((each) => each.id === job.id);
		if (earlier?.completedAtMs === undefined)
			spans.push(...jobSpans(after, job, routes));
	}
	return spans;
}

/** Sends `spans` through an OTLP sink as one export. Sends nothing for none. */
export async function exportRunTrace(
	sink: RelayTraceSink,
	resource: TraceFields,
	spans: readonly RelaySpan[],
): Promise<void> {
	if (spans.length === 0) return;
	await sink(JSON.stringify(toOtlpTraces(resource, spans)));
}

/** The route decisions about one attempt, read when its spans are built. */
export type RunRoutes = (
	run: InsightRun,
) => Promise<readonly RunnerRouteEvent[]>;

// public-contract: how long before a run was created a decision about it is still read.
export const ROUTE_LOOKBACK_MS = 60 * 60_000;

// public-contract: the most journal entries read for one attempt's spans.
export const ROUTE_READ_LIMIT = 500;

/** The decisions an account's journal holds for one attempt's repository around its time. */
export function journalRunRoutes(
	journal: RouteJournal,
	accountId: string,
): RunRoutes {
	return (run) =>
		journal.decisions({
			accountId,
			repository: run.repository,
			sinceMs: run.createdAtMs - ROUTE_LOOKBACK_MS,
			limit: ROUTE_READ_LIMIT,
		});
}

const NO_ROUTES: RunRoutes = async () => [];

/**
 * Folds run and job webhooks into the insight store, as `InsightIngest` does,
 * and exports what each one finished. Deliveries are applied one at a time,
 * in the order `deliver` was called; one relay partition owns the store
 * (ADR-0135). A failed export does not undo the stored facts; it is thrown
 * after them, and the export is not retried.
 */
export class RunTraceIngest {
	private readonly ingest: InsightIngest;
	private readonly routes: RunRoutes;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly options: Readonly<{
			store: InsightAttemptStore;
			sink: RelayTraceSink;
			resource: TraceFields;
			/** No route decisions are read when absent. */
			routes?: RunRoutes;
		}>,
	) {
		this.ingest = new InsightIngest(options.store);
		this.routes = options.routes ?? NO_ROUTES;
	}

	/** The spans this delivery exported, in the order they were sent. */
	deliver(event: string, body: string): Promise<readonly RelaySpan[]> {
		const next = this.queue
			.catch(() => undefined)
			.then(() => this.apply(event, body));
		this.queue = next;
		return next;
	}

	private async apply(
		event: string,
		body: string,
	): Promise<readonly RelaySpan[]> {
		const fact = parseInsightWebhook(event, body);
		if (fact === undefined) return [];
		const key = fact.kind === "job" ? fact.seed : fact.run;
		const before = await this.options.store.attempt(
			key.repository,
			key.id,
			key.attempt,
		);
		const after = await this.ingest.deliver(event, body);
		if (after === undefined) return [];
		const spans = finishedRunSpans(before, after, await this.routes(after));
		await exportRunTrace(this.options.sink, this.options.resource, spans);
		return spans;
	}
}
