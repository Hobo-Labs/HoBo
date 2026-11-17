/**
 * Automatic retry of a routed job that failed for a reason outside its own
 * steps (ADR-0183, case R10).
 *
 * When a run attempt completes with a failure, the relay that routed it reads
 * what it already keeps: the run's stored job facts (`InsightStore`), the
 * route journal's decision for the run, and the machine events. From those it
 * builds the failed job's `FailedJob` facts and asks `retryVerdict` whether to
 * run it again. On a yes it:
 *
 * 1. writes the `job.retried` row to the retry ledger first. The ledger keeps
 *    one row per run attempt, so a redelivered `workflow_run` webhook, or two
 *    deliveries racing, finds the row already there and retries nothing;
 * 2. re-runs the relay job through GitHub (`POST .../actions/jobs/{id}/rerun`,
 *    which re-runs a job and every job that needs it), so the relay decides
 *    afresh and the job behind it runs again on whatever it picks.
 *
 * The fresh decision knows it is a retry: `RetryRouteFacts` wraps the relay's
 * facts source and, for the attempt after a retried one, adds the ledger
 * row's `RouteRetry` (the failed step, the machine and the policy's target),
 * which `retryOrder` uses to put the failed step first or last.
 *
 * Only a run with one relay is retried (re-running one relay of several
 * would re-run failed jobs this failure says nothing about), and only when
 * every failed job that relay routed failed for a reason outside its steps:
 * a failing test is never retried here. The account cap and the policy's
 * per-run maximum count the ledger's rows.
 *
 * GitHub's endpoints: "Re-run a job from a workflow run" and "List check run
 * annotations" in GitHub's REST reference
 * (docs.github.com/en/rest/actions/workflow-runs, /checks/runs; read
 * 2026-11-17). A job's check run id is its job id.
 */
import type { DatabaseSync } from "node:sqlite";
import {
	type FailedJob,
	MACHINE_DISCONNECT_SLACK_MS,
	type MachineEvent,
	orderRetryPolicy,
	RELAY_LABEL,
	type RetryVerdict,
	type RouteFacts,
	type RouteFactsSource,
	type RouteJournal,
	type RouteRetry,
	RUNNER_RETRY_KINDS,
	RUNNER_RETRY_TARGETS,
	type RunnerOrderSource,
	type RunnerRetryKind,
	type RunnerRetryTarget,
	type RunnerRouteEvent,
	type RunnerRouteRequest,
	retryKind,
	retryVerdict,
	runnerStepKey,
	workflowGitRef,
} from "@hobo/ci";
import { type InsightJob, type InsightRun, ranSteps } from "@hobo/ci/insights";
import { z } from "zod";
import { type GithubTransport, rerunWorkflowJob } from "./github.js";

// public-contract: the event type a retry row is sent as.
export const JOB_RETRIED_EVENT = "job.retried";

/** One automatic retry, as the ledger keeps it and the event sink sends it. */
export type JobRetried = Readonly<{
	type: typeof JOB_RETRIED_EVENT;
	accountId: string;
	repository: string;
	runId: number;
	/** The attempt that failed. The retry runs as the next one. */
	attempt: number;
	/** GitHub's id of the relay job that is run again. */
	relayJobId: number;
	/** The relay job's id in its workflow file. */
	relayJob: string;
	/** GitHub's id and name of the failed job. */
	jobId: number;
	jobName: string;
	kind: RunnerRetryKind;
	target: RunnerRetryTarget;
	/** The step the failed job was routed to; empty when not known. */
	failedStep: string;
	/** The machine it ran on; empty when it was not a machine. */
	failedMachineId: string;
	atMs: number;
}>;

/**
 * Where retries are written before they happen. One row per repository, run
 * and attempt: `claim` writes it and answers true, or finds one already there
 * and answers false without changing it.
 */
export interface RetryLedger {
	claim(row: JobRetried): Promise<boolean>;
	/** The run's rows, oldest attempt first. Repository case is ignored. */
	forRun(repository: string, runId: number): Promise<readonly JobRetried[]>;
	/** How many rows the account has at or after `sinceMs`. */
	countSince(accountId: string, sinceMs: number): Promise<number>;
}

const JobRetriedSchema = z
	.object({
		type: z.literal(JOB_RETRIED_EVENT),
		accountId: z.string().min(1),
		repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
		runId: z.number().int().positive(),
		attempt: z.number().int().positive(),
		relayJobId: z.number().int().positive(),
		relayJob: z.string().min(1),
		jobId: z.number().int().positive(),
		jobName: z.string().min(1),
		kind: z.enum(RUNNER_RETRY_KINDS),
		target: z.enum(RUNNER_RETRY_TARGETS),
		failedStep: z.string(),
		failedMachineId: z.string(),
		atMs: z.number().int().positive(),
	})
	.strict()
	.readonly();

/** A retry row, checked and frozen. Throws a `ZodError` naming the broken field. */
export function defineJobRetried(row: JobRetried): JobRetried {
	return Object.freeze(JobRetriedSchema.parse(row));
}

function runKey(repository: string, runId: number): string {
	return `${repository.toLowerCase()}#${runId}`;
}

/** Rows in memory; for tests and a relay with no database. */
export class InMemoryRetryLedger implements RetryLedger {
	readonly rows: JobRetried[] = [];

	async claim(row: JobRetried): Promise<boolean> {
		const parsed = defineJobRetried(row);
		const key = runKey(parsed.repository, parsed.runId);
		if (
			this.rows.some(
				(kept) =>
					runKey(kept.repository, kept.runId) === key &&
					kept.attempt === parsed.attempt,
			)
		)
			return false;
		this.rows.push(parsed);
		return true;
	}

	async forRun(
		repository: string,
		runId: number,
	): Promise<readonly JobRetried[]> {
		const key = runKey(repository, runId);
		return this.rows
			.filter((row) => runKey(row.repository, row.runId) === key)
			.sort((left, right) => left.attempt - right.attempt);
	}

	async countSince(accountId: string, sinceMs: number): Promise<number> {
		return this.rows.filter(
			(row) => row.accountId === accountId && row.atMs >= sinceMs,
		).length;
	}
}

const LEDGER_SCHEMA = `CREATE TABLE IF NOT EXISTS job_retried (
  repository TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (repository, run_id, attempt)
);
CREATE INDEX IF NOT EXISTS job_retried_account_at ON job_retried(account_id, at_ms);`;

const BodyRow = z.object({ body: z.string() });
const CountRow = z.object({
	count: z.union([z.number(), z.bigint()]).transform(Number),
});
const ChangeCount = z.union([z.number(), z.bigint()]).transform(Number);

/**
 * The ledger on SQLite (ADR-0135). It takes the store's existing database
 * handle, so the rows live in the relay's one partition with its one writer.
 * A claim is one `INSERT ... ON CONFLICT DO NOTHING`, so two deliveries
 * racing through one handle still write one row and only one sees true.
 */
export class SqliteRetryLedger implements RetryLedger {
	constructor(private readonly db: DatabaseSync) {
		this.db.exec(LEDGER_SCHEMA);
	}

	async claim(row: JobRetried): Promise<boolean> {
		const parsed = defineJobRetried(row);
		const result = this.db
			.prepare(
				`INSERT INTO job_retried (repository, run_id, attempt, account_id, at_ms, body)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repository, run_id, attempt) DO NOTHING`,
			)
			.run(
				parsed.repository.toLowerCase(),
				parsed.runId,
				parsed.attempt,
				parsed.accountId,
				parsed.atMs,
				JSON.stringify(parsed),
			);
		return ChangeCount.parse(result.changes) === 1;
	}

	async forRun(
		repository: string,
		runId: number,
	): Promise<readonly JobRetried[]> {
		return this.db
			.prepare(
				"SELECT body FROM job_retried WHERE repository = ? AND run_id = ? ORDER BY attempt",
			)
			.all(repository.toLowerCase(), runId)
			.map((row) =>
				defineJobRetried(
					JobRetriedSchema.parse(JSON.parse(BodyRow.parse(row).body)),
				),
			);
	}

	async countSince(accountId: string, sinceMs: number): Promise<number> {
		const row = this.db
			.prepare(
				"SELECT COUNT(*) AS count FROM job_retried WHERE account_id = ? AND at_ms >= ?",
			)
			.get(accountId, sinceMs);
		return CountRow.parse(row).count;
	}
}

/** A retry ledger broke one of its rules. The message names the rule. */
export class RetryLedgerConformanceError extends Error {
	override readonly name = "RetryLedgerConformanceError";
}

function rule(ok: boolean, text: string): void {
	if (!ok) throw new RetryLedgerConformanceError(text);
}

/** A retry row for tests: attempt 1 of run 9001 in `octo/app`, overridable field by field. */
export function testJobRetried(init: Partial<JobRetried> = {}): JobRetried {
	return defineJobRetried({
		type: JOB_RETRIED_EVENT,
		accountId: "acct-1",
		repository: "octo/app",
		runId: 9001,
		attempt: 1,
		relayJobId: 1,
		relayJob: "route",
		jobId: 2,
		jobName: "build",
		kind: "runner_start",
		target: "any",
		failedStep: "github",
		failedMachineId: "",
		atMs: 1_000,
		...init,
	});
}

/** A retry ledger keeps its rules: one row per attempt, scoped reads, counted by account and time. */
export async function retryLedgerConformance(
	make: () => RetryLedger | Promise<RetryLedger>,
): Promise<void> {
	const ledger = await make();
	rule(
		await ledger.claim(testJobRetried({ attempt: 1, atMs: 1_000 })),
		"the first claim for an attempt is written",
	);
	rule(
		!(await ledger.claim(
			testJobRetried({ attempt: 1, atMs: 5_000, repository: "Octo/App" }),
		)),
		"a second claim for the same attempt is refused, repository case ignored",
	);
	rule(
		await ledger.claim(testJobRetried({ attempt: 2, atMs: 2_000 })),
		"the next attempt is its own row",
	);
	await ledger.claim(testJobRetried({ runId: 9002, atMs: 3_000 }));
	await ledger.claim(
		testJobRetried({ accountId: "acct-2", repository: "octo/other" }),
	);
	const rows = await ledger.forRun("OCTO/app", 9001);
	rule(
		rows.map((row) => row.attempt).join(",") === "1,2",
		"a run's rows come back oldest attempt first, the first claim kept",
	);
	rule(rows[0]?.atMs === 1_000, "a refused claim changes nothing");
	rule(Object.isFrozen(rows[0]), "rows come back frozen");
	rule(
		(await ledger.countSince("acct-1", 0)) === 3,
		"the count is the account's rows",
	);
	rule(
		(await ledger.countSince("acct-1", 2_000)) === 2,
		"the count starts at sinceMs",
	);
}

// --- What the retry reads -----------------------------------------------

/** When a machine disconnected between two times. */
export type MachineDisconnects = (
	query: Readonly<{
		accountId: string;
		machineId: string;
		fromMs: number;
		untilMs: number;
	}>,
) => Promise<readonly number[]>;

/** Disconnect times from machine events the relay kept. */
export function machineEventDisconnects(
	events: () => Promise<readonly MachineEvent[]>,
): MachineDisconnects {
	return async (query) =>
		(await events())
			.filter(
				(event) =>
					event.type === "machine.disconnected" &&
					event.accountId === query.accountId &&
					event.machineId === query.machineId &&
					event.atMs >= query.fromMs &&
					event.atMs <= query.untilMs,
			)
			.map((event) => event.atMs);
}

/** The annotation messages on a job's check run; empty when they cannot be read. */
export type CheckRunAnnotations = (
	repository: string,
	jobId: number,
) => Promise<readonly string[]>;

const AnnotationList = z.array(z.looseObject({ message: z.string() }));

/** Annotations read from GitHub. A failed read is no annotations, never an error. */
export function githubCheckRunAnnotations(
	github: GithubTransport,
	installationId: number,
): CheckRunAnnotations {
	return async (repository, jobId) => {
		try {
			const response = await github.request(
				installationId,
				`/repos/${repository}/check-runs/${jobId}/annotations?per_page=50`,
			);
			if (!response.ok) return [];
			const parsed = AnnotationList.safeParse(await response.json());
			return parsed.success ? parsed.data.map((entry) => entry.message) : [];
		} catch {
			return [];
		}
	};
}

/** What GitHub said to a re-run. */
export type RerunReply = Readonly<{ ok: boolean; status: number }>;

/** Re-runs one job and every job that needs it. */
export type RerunJob = (
	repository: string,
	jobId: number,
) => Promise<RerunReply>;

/** Re-run through GitHub. A network failure is status 0, never an error. */
export function githubRerunJob(
	github: GithubTransport,
	installationId: number,
): RerunJob {
	return async (repository, jobId) => {
		try {
			const response = await rerunWorkflowJob(
				github,
				installationId,
				repository,
				jobId,
			);
			return { ok: response.status === 201, status: response.status };
		} catch {
			return { ok: false, status: 0 };
		}
	};
}

// --- Choosing and running the retry -------------------------------------

/**
 * A routing job: one that asks `hobo-relay`, or is named `relay` or `route`.
 * The same rule `insight-ingest.ts` stores `relay` by, so a job read from
 * GitHub by hand is recognised as the stored one is.
 */
export function isRelayJobOf(name: string, labels: readonly string[]): boolean {
	return (
		labels.includes(RELAY_LABEL) ||
		/^(?:relay|route)(?:$|[\s\-_/(])/iu.test(name)
	);
}

const FAILED = new Set(["failure", "timed_out"]);

/** How far back from a run's creation its relay's decision is looked for. */
// public-contract: clock slack between GitHub's run time and the relay's journal time.
export const DECISION_LOOKBACK_MS = 10 * 60_000;
/** Journal entries read to find one run's decisions. */
// public-contract: the most route journal entries one retry reads.
export const DECISION_READ_LIMIT = 500;

export type AutoRetryDeps = Readonly<{
	/** The HoBo account whose journal and ledger these are. */
	accountId: string;
	nowMs: number;
	journal: RouteJournal;
	ledger: RetryLedger;
	order: RunnerOrderSource;
	annotations: CheckRunAnnotations;
	machineDisconnects: MachineDisconnects;
	rerun: RerunJob;
}>;

export type AutoRetrySkip =
	| "not_failed"
	| "no_relay_decision"
	| "no_relay_job"
	| "no_routed_failure"
	| "broken_order"
	| "already_retried";

export type AutoRetryOutcome =
	| Readonly<{ retried: true; row: JobRetried; status: number }>
	| Readonly<{
			retried: false;
			/** GitHub refused the re-run after the row was written. */
			reason: "rerun_refused";
			row: JobRetried;
			status: number;
	  }>
	| Readonly<{
			retried: false;
			reason: AutoRetrySkip | Extract<RetryVerdict, { retry: false }>["reason"];
	  }>;

function utcDayStartMs(nowMs: number): number {
	const day = new Date(nowMs);
	return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

/** The journal's decisions for one run attempt, one per relay job. */
async function runDecisions(
	run: InsightRun,
	deps: AutoRetryDeps,
): Promise<readonly RunnerRouteEvent[]> {
	const events = await deps.journal.decisions({
		accountId: deps.accountId,
		repository: run.repository,
		sinceMs: run.createdAtMs - DECISION_LOOKBACK_MS,
		limit: DECISION_READ_LIMIT,
	});
	const byJob = new Map<string, RunnerRouteEvent>();
	for (const event of events)
		if (
			event.type === "runner.route.Decided" &&
			event.request?.runId === run.id &&
			event.request.runAttempt === run.attempt
		)
			byJob.set(event.jobId === "" ? `#${byJob.size}` : event.jobId, event);
	return [...byJob.values()];
}

function routedBy(job: InsightJob, runner: string): boolean {
	const wanted = runner.toLowerCase();
	return job.labels.some((label) => label.toLowerCase() === wanted);
}

async function failedJobFacts(
	run: InsightRun,
	job: InsightJob,
	machineId: string,
	deps: AutoRetryDeps,
): Promise<FailedJob> {
	const started = ranSteps(job);
	const machineDisconnects =
		machineId === "" || job.startedAtMs === undefined
			? []
			: await deps.machineDisconnects({
					accountId: deps.accountId,
					machineId,
					fromMs: job.startedAtMs,
					untilMs:
						(job.completedAtMs ?? deps.nowMs) + MACHINE_DISCONNECT_SLACK_MS,
				});
	return {
		ranSteps: started,
		startedAtMs: job.startedAtMs,
		completedAtMs: job.completedAtMs,
		// A job that never reached its steps is a runner start whatever it says.
		annotations: started ? await deps.annotations(run.repository, job.id) : [],
		machineDisconnects,
	};
}

/**
 * Retry a completed, failed run attempt when its failure was not its own
 * doing. `run` is the attempt as the relay stores it once GitHub's
 * `workflow_run` `completed` webhook is folded in.
 */
export async function autoRetryRun(
	run: InsightRun,
	deps: AutoRetryDeps,
): Promise<AutoRetryOutcome> {
	if (run.completedAtMs === undefined || run.conclusion !== "failure")
		return { retried: false, reason: "not_failed" };
	const decisions = await runDecisions(run, deps);
	const decision = decisions[0];
	if (!decision?.decision || !decision.request)
		return { retried: false, reason: "no_relay_decision" };
	const relays = run.jobs.filter((job) => job.relay === true);
	const relay = relays[0];
	if (!relay) return { retried: false, reason: "no_relay_job" };
	const routed = run.jobs.filter(
		(job) =>
			job.relay !== true &&
			FAILED.has(job.conclusion) &&
			routedBy(job, decision.decision?.runner ?? ""),
	);
	if (routed.length === 0)
		return { retried: false, reason: "no_routed_failure" };
	const lookup = await deps.order.order(
		run.repository,
		workflowGitRef(decision.request.workflowRef),
	);
	if (lookup.problem !== "") return { retried: false, reason: "broken_order" };
	const machineId = decision.decision.machineId;
	const facts: { job: InsightJob; failed: FailedJob }[] = [];
	for (const job of routed)
		facts.push({
			job,
			failed: await failedJobFacts(run, job, machineId, deps),
		});
	// A job that failed on its own decides: a failing test is never retried.
	const chosen =
		facts.find(({ failed }) => retryKind(failed) === undefined) ?? facts[0];
	if (!chosen) return { retried: false, reason: "no_routed_failure" };
	const rows = await deps.ledger.forRun(run.repository, run.id);
	if (rows.some((row) => row.attempt === run.attempt))
		return { retried: false, reason: "already_retried" };
	const verdict = retryVerdict(orderRetryPolicy(lookup.order), {
		job: chosen.failed,
		relaysInRun: Math.max(relays.length, decisions.length),
		retriesThisRun: rows.length,
		retriesToday: await deps.ledger.countSince(
			deps.accountId,
			utcDayStartMs(deps.nowMs),
		),
	});
	if (!verdict.retry) return { retried: false, reason: verdict.reason };
	const row = defineJobRetried({
		type: JOB_RETRIED_EVENT,
		accountId: deps.accountId,
		repository: run.repository,
		runId: run.id,
		attempt: run.attempt,
		relayJobId: relay.id,
		relayJob: decision.request.job,
		jobId: chosen.job.id,
		jobName: chosen.job.name,
		kind: verdict.kind,
		target: verdict.target,
		failedStep: decision.decision.step,
		failedMachineId: machineId,
		atMs: deps.nowMs,
	});
	if (!(await deps.ledger.claim(row)))
		return { retried: false, reason: "already_retried" };
	const reply = await deps.rerun(run.repository, relay.id);
	return reply.ok
		? { retried: true, row, status: reply.status }
		: { retried: false, reason: "rerun_refused", row, status: reply.status };
}

// --- The retry in the fresh decision ------------------------------------

/**
 * The retry a relay request is answering: the ledger row of the attempt just
 * before it, for the same relay job. Undefined for a first attempt, a re-run
 * someone started by hand, or another relay job.
 */
export async function routeRetryFor(
	ledger: RetryLedger,
	request: RunnerRouteRequest,
): Promise<RouteRetry | undefined> {
	if (request.runAttempt <= 1) return undefined;
	const row = (await ledger.forRun(request.repository, request.runId)).find(
		(kept) =>
			kept.attempt === request.runAttempt - 1 && kept.relayJob === request.job,
	);
	if (!row) return undefined;
	return {
		target: row.target,
		failedStep: runnerStepKey(row.failedStep),
		failedMachineId:
			row.failedMachineId === "" ? undefined : row.failedMachineId,
	};
}

/** A facts source that adds the retry a request answers, from the ledger. */
export class RetryRouteFacts implements RouteFactsSource {
	constructor(
		private readonly inner: RouteFactsSource,
		private readonly ledger: RetryLedger,
	) {}

	async facts(request: RunnerRouteRequest, nowMs: number): Promise<RouteFacts> {
		const facts = await this.inner.facts(request, nowMs);
		const retry = await routeRetryFor(this.ledger, request);
		return retry === undefined ? facts : { ...facts, retry };
	}
}
