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

export type JobWebhookFact = Readonly<{
	kind: "job";
	repository: string;
	repositoryPrivate: boolean;
	runId: number;
	attempt: number;
	seed: InsightRun;
	job: InsightJob;
}>;

export type RunWebhookFact = Readonly<{
	kind: "run";
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

export function isRelayJob(name: string, labels: readonly string[]): boolean {
	return (
		labels.includes(RELAY_LABEL) ||
		/^(?:relay|route)(?:\s*\(.*\))?$/iu.test(name)
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
			createdAtMs: at(run.run_started_at) ?? at(run.created_at) ?? 0,
			...(completedAtMs === undefined ? undefined : { completedAtMs }),
			jobs: [],
			...(run.display_title ? { title: run.display_title } : undefined),
		},
	};
}

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

export class InsightIngest {
	private readonly pending = new Map<string, Promise<InsightRun>>();

	constructor(private readonly store: InsightAttemptStore) {}

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
