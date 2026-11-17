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
 *    afresh and the job behind it runs again on whatever it picks;
 * 3. records GitHub's answer on the row: `started`, `refused` (final, and
 *    counted against no limit) or `failed` (no answer or a server error),
 *    which one later delivery takes back and asks again.
 *
 * The row is the protobuf record `JobRetried` (`@hobo/ci`,
 * `data-models/job_retried.proto` and `job_retried.cue`), stored as its
 * protobuf JSON.
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
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	type FailedJob,
	type JobRetried as JobRetriedRecord,
	JobRetriedSchema,
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

/**
 * What became of a retry's re-run. `pending`: the row is written and GitHub
 * not yet answered. `started`: GitHub accepted it. `failed`: no answer, or a
 * server error, so a redelivered webhook may ask again. `refused`: GitHub said
 * no, which is final and counts against no limit.
 */
export const RETRY_RERUN_STATES = [
	"pending",
	"started",
	"failed",
	"refused",
] as const;
export type RetryRerun = (typeof RETRY_RERUN_STATES)[number];

declare const parsedJobRetried: unique symbol;

/**
 * One automatic retry, as the ledger keeps it and the event sink sends it:
 * the generated `JobRetried` record (`@hobo/ci` `data-models/job_retried.proto`)
 * after every rule in `job_retried.cue` held, frozen.
 */
export type JobRetried = Readonly<
	Omit<JobRetriedRecord, "kind" | "target" | "rerun">
> &
	Readonly<{
		kind: RunnerRetryKind;
		target: RunnerRetryTarget;
		rerun: RetryRerun;
	}> & { readonly [parsedJobRetried]: true };

/** A retry row's fields as a caller writes them; the re-run starts `pending`. */
export type JobRetriedFields = Readonly<{
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
	rerun?: RetryRerun;
	/** GitHub's HTTP status for the last ask; zero when there was no answer. */
	rerunStatus?: number;
}>;

/** A retry row broke one of its rules. The message names the rule. */
export class RetryRowRejection extends Error {
	override readonly name = "RetryRowRejection";
}

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const RELAY_JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u;

function need(ok: boolean, problem: string): void {
	if (!ok) throw new RetryRowRejection(problem);
}

function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function oneOf<T extends string>(
	values: readonly T[],
	value: string,
): value is T {
	return values.some((entry) => entry === value);
}

/** The re-run state GitHub's answer puts a row in. */
export function rerunStateOf(status: number): RetryRerun {
	if (status === 201) return "started";
	return status === 0 || status >= 500 ? "failed" : "refused";
}

function rerunStatusFits(rerun: RetryRerun, status: number): boolean {
	switch (rerun) {
		case "pending":
			return status === 0;
		case "started":
			return status === 201;
		case "failed":
			return status === 0 || (status >= 500 && status <= 599);
		case "refused":
			return status >= 200 && status <= 499 && status !== 201;
	}
}

function checked(record: JobRetriedRecord): JobRetried {
	need(record.type === JOB_RETRIED_EVENT, `type must be ${JOB_RETRIED_EVENT}`);
	need(record.accountId !== "", "accountId is empty");
	need(REPOSITORY.test(record.repository), "repository is not owner/name");
	need(positiveInteger(record.runId), "runId is not a positive integer");
	need(
		Number.isSafeInteger(record.attempt) &&
			record.attempt >= 1 &&
			record.attempt <= 1000,
		"attempt is not between 1 and 1000",
	);
	need(
		positiveInteger(record.relayJobId),
		"relayJobId is not a positive integer",
	);
	need(RELAY_JOB_ID.test(record.relayJob), "relayJob is not a job id");
	need(positiveInteger(record.jobId), "jobId is not a positive integer");
	need(record.jobName !== "", "jobName is empty");
	need(positiveInteger(record.atMs), "atMs is not a positive integer");
	const { kind, target, rerun } = record;
	need(oneOf(RUNNER_RETRY_KINDS, kind), `kind ${kind} is not a retry kind`);
	need(
		oneOf(RUNNER_RETRY_TARGETS, target),
		`target ${target} is not a retry target`,
	);
	need(oneOf(RETRY_RERUN_STATES, rerun), `rerun ${rerun} is not a state`);
	need(
		oneOf(RETRY_RERUN_STATES, rerun) &&
			rerunStatusFits(rerun, record.rerunStatus),
		`rerun ${rerun} does not go with status ${record.rerunStatus}`,
	);
	Object.freeze(record);
	// SAFETY: every rule of job_retried.cue held just above, kind, target and
	// rerun among them, and the record is frozen.
	return record as JobRetried;
}

/** A retry row, checked and frozen. Throws `RetryRowRejection` naming the broken rule. */
export function defineJobRetried(
	fields: JobRetriedFields | JobRetried,
): JobRetried {
	return checked(
		create(JobRetriedSchema, {
			...fields,
			rerun: fields.rerun ?? "pending",
			rerunStatus: fields.rerunStatus ?? 0,
		}),
	);
}

/** A retry row from its protobuf JSON, as the ledger stores and the sink sends it. */
export function parseJobRetried(json: string): JobRetried {
	return checked(fromJsonString(JobRetriedSchema, json));
}

/** The row's canonical encoding: protobuf JSON. */
export function jobRetriedJson(row: JobRetried): string {
	return toJsonString(JobRetriedSchema, row);
}

function settled(row: JobRetried, status: number): JobRetried {
	return defineJobRetried({
		...row,
		rerun: rerunStateOf(status),
		rerunStatus: status,
	});
}

function runKey(repository: string, runId: number): string {
	return `${repository.toLowerCase()}#${runId}`;
}

/**
 * Where retries are written before they happen. One row per repository, run
 * and attempt: `claim` writes it and answers true, or finds one already there
 * and answers false without changing it. Repository case is ignored.
 */
export interface RetryLedger {
	claim(row: JobRetried): Promise<boolean>;
	/**
	 * Record GitHub's answer on a `pending` row and return the row as kept. A
	 * row in any other state is returned unchanged; a missing one is undefined.
	 */
	settle(
		repository: string,
		runId: number,
		attempt: number,
		status: number,
	): Promise<JobRetried | undefined>;
	/**
	 * Take a `failed` row back to `pending`, so exactly one delivery asks GitHub
	 * again. False when the row is in any other state or missing.
	 */
	reclaim(repository: string, runId: number, attempt: number): Promise<boolean>;
	/** The run's rows, oldest attempt first. */
	forRun(repository: string, runId: number): Promise<readonly JobRetried[]>;
	/** How many rows the account has at or after `sinceMs`, refused ones left out. */
	countSince(accountId: string, sinceMs: number): Promise<number>;
}

/** Rows in memory; for tests and a relay with no database. */
export class InMemoryRetryLedger implements RetryLedger {
	readonly rows: JobRetried[] = [];

	private index(repository: string, runId: number, attempt: number): number {
		const key = runKey(repository, runId);
		return this.rows.findIndex(
			(kept) =>
				runKey(kept.repository, kept.runId) === key && kept.attempt === attempt,
		);
	}

	async claim(row: JobRetried): Promise<boolean> {
		const parsed = defineJobRetried(row);
		if (this.index(parsed.repository, parsed.runId, parsed.attempt) !== -1)
			return false;
		this.rows.push(parsed);
		return true;
	}

	async settle(
		repository: string,
		runId: number,
		attempt: number,
		status: number,
	): Promise<JobRetried | undefined> {
		const at = this.index(repository, runId, attempt);
		const kept = this.rows[at];
		if (!kept || kept.rerun !== "pending") return kept;
		const next = settled(kept, status);
		this.rows[at] = next;
		return next;
	}

	async reclaim(
		repository: string,
		runId: number,
		attempt: number,
	): Promise<boolean> {
		const at = this.index(repository, runId, attempt);
		const kept = this.rows[at];
		if (!kept || kept.rerun !== "failed") return false;
		this.rows[at] = defineJobRetried({
			...kept,
			rerun: "pending",
			rerunStatus: 0,
		});
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
			(row) =>
				row.accountId === accountId &&
				row.atMs >= sinceMs &&
				row.rerun !== "refused",
		).length;
	}
}

const LEDGER_SCHEMA = `CREATE TABLE IF NOT EXISTS job_retried (
  repository TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  rerun TEXT NOT NULL,
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
 * A row's body is its protobuf JSON. A claim is one `INSERT ... ON CONFLICT DO
 * NOTHING` and a state change one `UPDATE ... WHERE rerun = <expected>`, so two
 * deliveries racing through one handle still see one winner.
 */
export class SqliteRetryLedger implements RetryLedger {
	constructor(private readonly db: DatabaseSync) {
		this.db.exec(LEDGER_SCHEMA);
	}

	async claim(row: JobRetried): Promise<boolean> {
		const parsed = defineJobRetried(row);
		const result = this.db
			.prepare(
				`INSERT INTO job_retried (repository, run_id, attempt, account_id, at_ms, rerun, body)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repository, run_id, attempt) DO NOTHING`,
			)
			.run(
				parsed.repository.toLowerCase(),
				parsed.runId,
				parsed.attempt,
				parsed.accountId,
				parsed.atMs,
				parsed.rerun,
				jobRetriedJson(parsed),
			);
		return ChangeCount.parse(result.changes) === 1;
	}

	private row(
		repository: string,
		runId: number,
		attempt: number,
	): JobRetried | undefined {
		const found = this.db
			.prepare(
				"SELECT body FROM job_retried WHERE repository = ? AND run_id = ? AND attempt = ?",
			)
			.get(repository.toLowerCase(), runId, attempt);
		return found === undefined
			? undefined
			: parseJobRetried(BodyRow.parse(found).body);
	}

	private replace(row: JobRetried, expected: RetryRerun): boolean {
		const result = this.db
			.prepare(
				`UPDATE job_retried SET rerun = ?, body = ?
         WHERE repository = ? AND run_id = ? AND attempt = ? AND rerun = ?`,
			)
			.run(
				row.rerun,
				jobRetriedJson(row),
				row.repository.toLowerCase(),
				row.runId,
				row.attempt,
				expected,
			);
		return ChangeCount.parse(result.changes) === 1;
	}

	async settle(
		repository: string,
		runId: number,
		attempt: number,
		status: number,
	): Promise<JobRetried | undefined> {
		const kept = this.row(repository, runId, attempt);
		if (!kept || kept.rerun !== "pending") return kept;
		const next = settled(kept, status);
		return this.replace(next, "pending")
			? next
			: this.row(repository, runId, attempt);
	}

	async reclaim(
		repository: string,
		runId: number,
		attempt: number,
	): Promise<boolean> {
		const kept = this.row(repository, runId, attempt);
		if (!kept || kept.rerun !== "failed") return false;
		return this.replace(
			defineJobRetried({ ...kept, rerun: "pending", rerunStatus: 0 }),
			"failed",
		);
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
			.map((row) => parseJobRetried(BodyRow.parse(row).body));
	}

	async countSince(accountId: string, sinceMs: number): Promise<number> {
		const row = this.db
			.prepare(
				"SELECT COUNT(*) AS count FROM job_retried WHERE account_id = ? AND at_ms >= ? AND rerun <> 'refused'",
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
export function testJobRetried(
	init: Partial<JobRetriedFields> = {},
): JobRetried {
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

/**
 * A retry ledger keeps its rules: one row per attempt, scoped reads, the
 * re-run's state moving only forward from `pending` (and from `failed` back to
 * `pending` once), counted by account and time with refused rows left out.
 */
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
	rule(rows[0]?.rerun === "pending", "a claimed row starts pending");
	rule(Object.isFrozen(rows[0]), "rows come back frozen");
	rule(
		(await ledger.countSince("acct-1", 0)) === 3,
		"the count is the account's rows",
	);
	rule(
		(await ledger.countSince("acct-1", 2_000)) === 2,
		"the count starts at sinceMs",
	);
	rule(
		!(await ledger.reclaim("octo/app", 9001, 1)),
		"a pending row cannot be reclaimed",
	);
	const failed = await ledger.settle("Octo/App", 9001, 1, 503);
	rule(
		failed?.rerun === "failed" && failed.rerunStatus === 503,
		"a server error leaves the row failed",
	);
	rule(
		await ledger.reclaim("octo/app", 9001, 1),
		"a failed row is reclaimed once",
	);
	rule(
		!(await ledger.reclaim("octo/app", 9001, 1)),
		"a reclaimed row is not reclaimed again",
	);
	const started = await ledger.settle("octo/app", 9001, 1, 201);
	rule(started?.rerun === "started", "a 201 starts the row");
	rule(
		(await ledger.settle("octo/app", 9001, 1, 403))?.rerun === "started",
		"a settled row keeps its state",
	);
	rule(
		(await ledger.settle("octo/app", 9001, 7, 201)) === undefined,
		"settling a missing row finds nothing",
	);
	await ledger.settle("octo/app", 9002, 1, 403);
	rule(
		(await ledger.forRun("octo/app", 9002))[0]?.rerun === "refused",
		"a 4xx refuses the row",
	);
	rule(
		(await ledger.countSince("acct-1", 0)) === 2,
		"refused rows are left out of the count",
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
/** Journal entries read first to find one run's decisions. */
// public-contract: the first page of route journal entries one retry reads.
export const DECISION_READ_LIMIT = 500;
/**
 * The most entries one retry reads: the read grows from `DECISION_READ_LIMIT`
 * until it holds every entry since the run began, or reaches this.
 */
// public-contract: the most route journal entries one retry reads.
export const DECISION_READ_MAX = 32_000;

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
			/**
			 * After the row was written, GitHub refused the re-run (final; the row
			 * counts against no limit), or gave no answer or a server error (the
			 * row is `failed`, and a redelivered webhook asks again once).
			 */
			reason: "rerun_refused" | "rerun_failed";
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
	// The journal reads newest first and has no cursor, so in a busy repository
	// the run's decision can sit below the first page: read a larger page until
	// it holds every entry since the run began.
	let limit = DECISION_READ_LIMIT;
	let events: readonly RunnerRouteEvent[];
	for (;;) {
		events = await deps.journal.decisions({
			accountId: deps.accountId,
			repository: run.repository,
			sinceMs: run.createdAtMs - DECISION_LOOKBACK_MS,
			limit,
		});
		if (events.length < limit || limit >= DECISION_READ_MAX) break;
		limit = Math.min(limit * 4, DECISION_READ_MAX);
	}
	const byJob = new Map<string, RunnerRouteEvent>();
	for (const event of events) {
		if (
			event.type !== "runner.route.Decided" ||
			event.request?.runId !== run.id ||
			event.request.runAttempt !== run.attempt
		)
			continue;
		const key = event.jobId === "" ? `#${byJob.size}` : event.jobId;
		// Newest first: the first entry for a relay job is its latest decision.
		if (!byJob.has(key)) byJob.set(key, event);
	}
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
	const kept = rows.find((row) => row.attempt === run.attempt);
	if (kept) {
		// GitHub never answered, or failed: the policy already allowed this
		// retry, so the one delivery that takes the row back asks again.
		if (
			kept.rerun === "failed" &&
			(await deps.ledger.reclaim(run.repository, run.id, run.attempt))
		)
			return rerunRelay(kept, deps);
		return { retried: false, reason: "already_retried" };
	}
	const verdict = retryVerdict(orderRetryPolicy(lookup.order), {
		job: chosen.failed,
		relaysInRun: Math.max(relays.length, decisions.length),
		retriesThisRun: rows.filter((row) => row.rerun !== "refused").length,
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
	return rerunRelay(row, deps);
}

/** Ask GitHub to re-run a claimed row's relay job and record its answer on the row. */
async function rerunRelay(
	row: JobRetried,
	deps: AutoRetryDeps,
): Promise<AutoRetryOutcome> {
	const reply = await deps.rerun(row.repository, row.relayJobId);
	const status = reply.ok ? 201 : reply.status === 201 ? 0 : reply.status;
	const kept =
		(await deps.ledger.settle(
			row.repository,
			row.runId,
			row.attempt,
			status,
		)) ?? row;
	if (kept.rerun === "started")
		return { retried: true, row: kept, status: reply.status };
	return {
		retried: false,
		reason: kept.rerun === "refused" ? "rerun_refused" : "rerun_failed",
		row: kept,
		status: reply.status,
	};
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
			kept.attempt === request.runAttempt - 1 &&
			kept.relayJob === request.job &&
			// A refused re-run started nothing; a later attempt is someone's own.
			kept.rerun !== "refused",
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
