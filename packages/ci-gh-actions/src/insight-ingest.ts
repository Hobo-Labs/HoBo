/**
 * Run and job history from GitHub's webhooks (ADR-0183): the one boundary
 * where a `workflow_job` or `workflow_run` payload becomes the run, job and
 * step facts a relay keeps in its `InsightStore`.
 *
 * GitHub sends a run's facts in pieces: `workflow_run` when the attempt is
 * requested, starts and completes, and `workflow_job` as each job is queued,
 * taken and completed. Each piece is folded into the stored attempt:
 *
 * - A job that arrives before its run starts the attempt from what the job
 *   carries (workflow name, branch, commit, sender); the event stays
 *   `unknown` until the run's own webhook fills it in.
 * - A run webhook sets the attempt's own fields and keeps its jobs. A job
 *   webhook replaces that job and touches nothing else.
 * - A finished run or job is never replaced by an older, unfinished view of
 *   it, and a started job never by a queued view of it, so a webhook GitHub
 *   delivers late or twice changes nothing.
 * - A job ran on GitHub's own runners when every label is a hosted label or
 *   its runner group is `GitHub Actions` (larger runners on custom labels).
 *   It is billed when, in addition, the repository is private or the runner
 *   is a larger runner, which GitHub bills in public repositories too
 *   (`githubBillsJob`).
 * - The stored run has no place for the repository's visibility, so each
 *   parsed fact carries it as `repositoryPrivate` for a consumer that keeps
 *   the public repositories a usage report needs.
 *
 * Every folded attempt is checked as a `RunFact` before it is stored, and
 * comes back frozen. `InsightIngest` applies the webhooks for one attempt
 * one at a time, in the order they were delivered; one relay partition owns
 * the store (ADR-0135).
 */
import {
	type InsightStore,
	insightRunOf,
	RELAY_LABEL,
	runFactOf,
} from "@hobo/ci";
import type {
	InsightConclusion,
	InsightJob,
	InsightRun,
	InsightStep,
} from "@hobo/ci/insights";
import { githubBillsJob } from "@hobo/ci/insights/usage";
import { z } from "zod";

// public-contract: the event a run started from a job webhook has until its run webhook arrives.
export const UNKNOWN_EVENT = "unknown";

/** An insight store that can also read back one attempt, which folding needs. */
export interface InsightAttemptStore extends InsightStore {
	attempt(
		repository: string,
		id: number,
		attempt: number,
	): Promise<InsightRun | undefined>;
}

const time = z.string().min(1).nullish();

const RepositorySchema = z.looseObject({
	full_name: z.string().min(1),
	private: z.boolean(),
	default_branch: z.string().nullish(),
});

const SenderSchema = z.looseObject({ login: z.string() }).nullish();

const StepSchema = z.looseObject({
	name: z.string(),
	number: z.number().int().positive(),
	conclusion: z.string().nullish(),
	started_at: time,
	completed_at: time,
});

const WorkflowJobPayload = z.looseObject({
	action: z.string(),
	workflow_job: z.looseObject({
		id: z.number().int().positive(),
		run_id: z.number().int().positive(),
		run_attempt: z.number().int().positive().nullish(),
		name: z.string(),
		workflow_name: z.string().nullish(),
		head_branch: z.string().nullish(),
		head_sha: z.string(),
		conclusion: z.string().nullish(),
		labels: z.array(z.string()).nullish(),
		runner_name: z.string().nullish(),
		runner_group_name: z.string().nullish(),
		created_at: z.string().min(1),
		started_at: time,
		completed_at: time,
		steps: z.array(StepSchema).nullish(),
	}),
	repository: RepositorySchema,
	sender: SenderSchema,
});

const WorkflowRunPayload = z.looseObject({
	action: z.string(),
	workflow_run: z.looseObject({
		id: z.number().int().positive(),
		run_attempt: z.number().int().positive().nullish(),
		name: z.string().nullish(),
		path: z.string().nullish(),
		event: z.string().min(1),
		head_branch: z.string().nullish(),
		head_sha: z.string(),
		status: z.string().nullish(),
		conclusion: z.string().nullish(),
		created_at: z.string().min(1),
		run_started_at: time,
		updated_at: time,
		display_title: z.string().nullish(),
		actor: z.looseObject({ login: z.string() }).nullish(),
	}),
	repository: RepositorySchema,
	sender: SenderSchema,
});

/** A `workflow_job` webhook: one job of one run attempt, and what it says about the run. */
export type JobWebhookFact = Readonly<{
	kind: "job";
	repository: string;
	/** The repository is private: GitHub bills its standard hosted minutes too. */
	repositoryPrivate: boolean;
	runId: number;
	attempt: number;
	/** The attempt as far as the job shows it, without jobs; used only when nothing is stored yet. */
	seed: InsightRun;
	job: InsightJob;
}>;

/** A `workflow_run` webhook: one run attempt's own fields, without jobs. */
export type RunWebhookFact = Readonly<{
	kind: "run";
	/** The repository is private: GitHub bills its standard hosted minutes too. */
	repositoryPrivate: boolean;
	run: InsightRun;
}>;

export type InsightWebhookFact = JobWebhookFact | RunWebhookFact;

function conclusion(value: string | null | undefined): InsightConclusion {
	switch (value) {
		case "success":
		case "failure":
		case "cancelled":
		case "skipped":
		case "timed_out":
			return value;
		case "startup_failure":
			return "failure";
		default:
			return "unknown";
	}
}

function at(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : ms;
}

/** A routing job hands the real work to another runner: it is left out of waits. */
function isRelayJob(name: string, labels: readonly string[]): boolean {
	return (
		labels.includes(RELAY_LABEL) ||
		/^(?:relay|route)(?:$|[\s\-_/(])/iu.test(name)
	);
}

function insightStep(step: z.infer<typeof StepSchema>): InsightStep {
	const startedAtMs = at(step.started_at);
	const completedAtMs = at(step.completed_at);
	return {
		name: step.name,
		number: step.number,
		conclusion: conclusion(step.conclusion),
		...(startedAtMs === undefined ? undefined : { startedAtMs }),
		...(completedAtMs === undefined ? undefined : { completedAtMs }),
	};
}

function jobFact(payload: z.infer<typeof WorkflowJobPayload>): JobWebhookFact {
	const job = payload.workflow_job;
	const labels = job.labels ?? [];
	const queuedAtMs = at(job.created_at) ?? 0;
	// GitHub stamps `started_at` on a job no runner has taken; a runner name
	// is what shows one did.
	const startedAtMs = job.runner_name ? at(job.started_at) : undefined;
	const completedAtMs = at(job.completed_at);
	const relay = isRelayJob(job.name, labels);
	const insight: InsightJob = {
		id: job.id,
		name: job.name,
		labels,
		...(job.runner_name ? { runnerName: job.runner_name } : undefined),
		...(job.runner_group_name
			? { runnerGroup: job.runner_group_name }
			: undefined),
		conclusion: conclusion(job.conclusion),
		queuedAtMs,
		...(startedAtMs === undefined ? undefined : { startedAtMs }),
		...(completedAtMs === undefined ? undefined : { completedAtMs }),
		steps: (job.steps ?? []).map(insightStep),
		billed: githubBillsJob(
			{
				labels,
				...(job.runner_group_name
					? { runnerGroup: job.runner_group_name }
					: undefined),
			},
			payload.repository.private,
		),
		...(relay ? { relay: true } : undefined),
	};
	const repository = payload.repository.full_name;
	const attempt = job.run_attempt ?? 1;
	const workflow = job.workflow_name ?? "workflow";
	return {
		kind: "job",
		repository,
		repositoryPrivate: payload.repository.private,
		runId: job.run_id,
		attempt,
		seed: {
			id: job.run_id,
			attempt,
			repository,
			workflow,
			workflowPath: workflow,
			event: UNKNOWN_EVENT,
			branch: job.head_branch ?? "",
			defaultBranch: payload.repository.default_branch ?? "",
			headSha: job.head_sha,
			actor: payload.sender?.login ?? "",
			conclusion: "unknown",
			createdAtMs: queuedAtMs,
			jobs: [],
		},
		job: insight,
	};
}

function runFact(payload: z.infer<typeof WorkflowRunPayload>): RunWebhookFact {
	const run = payload.workflow_run;
	const finished = run.status === "completed";
	const completedAtMs = finished ? at(run.updated_at) : undefined;
	return {
		kind: "run",
		repositoryPrivate: payload.repository.private,
		run: {
			id: run.id,
			attempt: run.run_attempt ?? 1,
			repository: payload.repository.full_name,
			workflow: run.name ?? run.path ?? "workflow",
			workflowPath: run.path ?? run.name ?? "workflow",
			event: run.event,
			branch: run.head_branch ?? "",
			defaultBranch: payload.repository.default_branch ?? "",
			headSha: run.head_sha,
			actor: run.actor?.login ?? payload.sender?.login ?? "",
			conclusion: finished ? conclusion(run.conclusion) : "unknown",
			// A re-run keeps the run's creation time; this attempt began at run_started_at.
			createdAtMs: at(run.run_started_at) ?? at(run.created_at) ?? 0,
			...(completedAtMs === undefined ? undefined : { completedAtMs }),
			jobs: [],
			...(run.display_title ? { title: run.display_title } : undefined),
		},
	};
}

/**
 * The run, job and step facts in one webhook delivery. Undefined for an event
 * other than `workflow_job` and `workflow_run`; throws when a payload of one
 * of those is not what GitHub sends.
 */
export function parseInsightWebhook(
	event: string,
	body: string,
): InsightWebhookFact | undefined {
	if (event === "workflow_job")
		return jobFact(WorkflowJobPayload.parse(JSON.parse(body)));
	if (event === "workflow_run")
		return runFact(WorkflowRunPayload.parse(JSON.parse(body)));
	return undefined;
}

const finished = (entry: Readonly<{ completedAtMs?: number }>): boolean =>
	entry.completedAtMs !== undefined;

/** How far a job has got: queued, then taken by a runner, then finished. */
const jobStage = (job: InsightJob): number =>
	finished(job) ? 2 : job.startedAtMs !== undefined ? 1 : 0;

function foldJob(
	jobs: readonly InsightJob[],
	incoming: InsightJob,
): readonly InsightJob[] {
	const kept = jobs.find((job) => job.id === incoming.id);
	if (kept !== undefined && jobStage(kept) > jobStage(incoming)) return jobs;
	return [...jobs.filter((job) => job.id !== incoming.id), incoming].sort(
		(left, right) => left.queuedAtMs - right.queuedAtMs || left.id - right.id,
	);
}

function foldRun(previous: InsightRun, incoming: InsightRun): InsightRun {
	if (finished(previous) && !finished(incoming)) return previous;
	return { ...incoming, jobs: previous.jobs };
}

/**
 * One webhook's facts folded into the attempt stored so far (undefined when
 * none is), checked as a `RunFact` and frozen. Throws when the webhook is for
 * another attempt or the result breaks the record's rules.
 */
export function foldInsightWebhook(
	previous: InsightRun | undefined,
	fact: InsightWebhookFact,
): InsightRun {
	const key = fact.kind === "job" ? fact.seed : fact.run;
	if (
		previous !== undefined &&
		(previous.id !== key.id ||
			previous.attempt !== key.attempt ||
			previous.repository.toLowerCase() !== key.repository.toLowerCase())
	) {
		throw new RangeError(
			`a webhook for ${key.repository} run ${key.id} attempt ${key.attempt} belongs to another run`,
		);
	}
	const folded =
		fact.kind === "job"
			? {
					...(previous ?? fact.seed),
					jobs: foldJob(previous?.jobs ?? [], fact.job),
				}
			: previous === undefined
				? fact.run
				: foldRun(previous, fact.run);
	return Object.freeze(insightRunOf(runFactOf(folded)));
}

/**
 * Folds webhook deliveries into an insight store. Deliveries for one attempt
 * are applied one at a time, in the order `deliver` was called.
 */
export class InsightIngest {
	private readonly pending = new Map<string, Promise<InsightRun>>();

	constructor(private readonly store: InsightAttemptStore) {}

	/** The attempt as stored after this delivery, or undefined for an event this does not read. */
	async deliver(event: string, body: string): Promise<InsightRun | undefined> {
		const fact = parseInsightWebhook(event, body);
		if (fact === undefined) return undefined;
		const run = fact.kind === "job" ? fact.seed : fact.run;
		const key = `${run.repository.toLowerCase()}#${run.id}#${run.attempt}`;
		const before = this.pending.get(key);
		const next = (async (): Promise<InsightRun> => {
			if (before !== undefined) await before.catch(() => undefined);
			const previous = await this.store.attempt(
				run.repository,
				run.id,
				run.attempt,
			);
			const folded = foldInsightWebhook(previous, fact);
			await this.store.ingest(folded);
			return folded;
		})();
		this.pending.set(key, next);
		try {
			return await next;
		} finally {
			if (this.pending.get(key) === next) this.pending.delete(key);
		}
	}
}
