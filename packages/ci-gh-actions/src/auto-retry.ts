import type { DatabaseSync } from "node:sqlite";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	type FailedJob,
	type JobRetried as JobRetriedRecord,
	JobRetriedSchema,
	MACHINE_DISCONNECT_SLACK_MS,
	type MachineEvent,
	orderRetryPolicy,
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

export const JOB_RETRIED_EVENT = "job.retried";

export const RETRY_RERUN_STATES = [
	"pending",
	"started",
	"failed",
	"refused",
] as const;
export type RetryRerun = (typeof RETRY_RERUN_STATES)[number];

declare const parsedJobRetried: unique symbol;

export type JobRetried = Readonly<
	Omit<JobRetriedRecord, "kind" | "target" | "rerun">
> &
	Readonly<{
		kind: RunnerRetryKind;
		target: RunnerRetryTarget;
		rerun: RetryRerun;
	}> & { readonly [parsedJobRetried]: true };

export type JobRetriedFields = Readonly<{
	type: typeof JOB_RETRIED_EVENT;
	accountId: string;
	repository: string;
	runId: number;
	attempt: number;
	relayJobId: number;
	relayJob: string;
	jobId: number;
	jobName: string;
	kind: RunnerRetryKind;
	target: RunnerRetryTarget;
	failedStep: string;
	failedMachineId: string;
	atMs: number;
	rerun?: RetryRerun;
	rerunStatus?: number;
}>;

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

function assertRetried(record: JobRetriedRecord): asserts record is JobRetried {
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
}

function checked(record: JobRetriedRecord): JobRetried {
	assertRetried(record);
	return record;
}

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

export function parseJobRetried(json: string): JobRetried {
	return checked(fromJsonString(JobRetriedSchema, json));
}

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

export interface RetryLedger {
	claim(row: JobRetried): Promise<boolean>;
	settle(
		repository: string,
		runId: number,
		attempt: number,
		status: number,
	): Promise<JobRetried | undefined>;
	reclaim(
		repository: string,
		runId: number,
		attempt: number,
		nowMs: number,
	): Promise<boolean>;
	forRun(repository: string, runId: number): Promise<readonly JobRetried[]>;
	countSince(accountId: string, sinceMs: number): Promise<number>;
}

export const RETRY_PENDING_LEASE_MS = 5 * 60_000;

function reclaimable(row: JobRetried | undefined, nowMs: number): boolean {
	if (row === undefined) return false;
	if (row.rerun === "failed") return true;
	return row.rerun === "pending" && row.atMs + RETRY_PENDING_LEASE_MS <= nowMs;
}

function reclaimed(row: JobRetried, nowMs: number): JobRetried {
	return defineJobRetried({
		...row,
		rerun: "pending",
		rerunStatus: 0,
		atMs: nowMs,
	});
}

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
		if (kept?.rerun !== "pending") return kept;
		const next = settled(kept, status);
		this.rows[at] = next;
		return next;
	}

	async reclaim(
		repository: string,
		runId: number,
		attempt: number,
		nowMs: number,
	): Promise<boolean> {
		const at = this.index(repository, runId, attempt);
		const kept = this.rows[at];
		if (kept === undefined || !reclaimable(kept, nowMs)) return false;
		this.rows[at] = reclaimed(kept, nowMs);
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

	private replace(row: JobRetried, expected: JobRetried): boolean {
		const result = this.db
			.prepare(
				`UPDATE job_retried SET rerun = ?, at_ms = ?, body = ?
         WHERE repository = ? AND run_id = ? AND attempt = ? AND rerun = ? AND at_ms = ?`,
			)
			.run(
				row.rerun,
				row.atMs,
				jobRetriedJson(row),
				row.repository.toLowerCase(),
				row.runId,
				row.attempt,
				expected.rerun,
				expected.atMs,
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
		if (kept?.rerun !== "pending") return kept;
		const next = settled(kept, status);
		return this.replace(next, kept)
			? next
			: this.row(repository, runId, attempt);
	}

	async reclaim(
		repository: string,
		runId: number,
		attempt: number,
		nowMs: number,
	): Promise<boolean> {
		const kept = this.row(repository, runId, attempt);
		if (kept === undefined || !reclaimable(kept, nowMs)) return false;
		return this.replace(reclaimed(kept, nowMs), kept);
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

export class RetryLedgerConformanceError extends Error {
	override readonly name = "RetryLedgerConformanceError";
}

function rule(ok: boolean, text: string): void {
	if (!ok) throw new RetryLedgerConformanceError(text);
}

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
		!(await ledger.reclaim(
			"octo/app",
			9001,
			1,
			1_000 + RETRY_PENDING_LEASE_MS - 1,
		)),
		"a pending row cannot be reclaimed inside its lease",
	);
	const failed = await ledger.settle("Octo/App", 9001, 1, 503);
	rule(
		failed?.rerun === "failed" && failed.rerunStatus === 503,
		"a server error leaves the row failed",
	);
	rule(
		await ledger.reclaim("octo/app", 9001, 1, 4_000),
		"a failed row is reclaimed once",
	);
	rule(
		!(await ledger.reclaim("octo/app", 9001, 1, 4_000)),
		"a reclaimed row is not reclaimed again",
	);
	rule(
		(await ledger.forRun("octo/app", 9001))[0]?.atMs === 4_000,
		"a reclaimed row is stamped with the time it was taken",
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
	const lapsed = 3_000 + RETRY_PENDING_LEASE_MS;
	rule(
		await ledger.reclaim("octo/app", 9002, 1, lapsed),
		"a pending row whose lease ran out is reclaimed",
	);
	rule(
		!(await ledger.reclaim("octo/app", 9002, 1, lapsed)),
		"and its new lease starts then",
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

export type MachineDisconnects = (
	query: Readonly<{
		accountId: string;
		machineId: string;
		fromMs: number;
		untilMs: number;
	}>,
) => Promise<readonly number[]>;

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

export type CheckRunAnnotations = (
	repository: string,
	jobId: number,
) => Promise<readonly string[]>;

const AnnotationList = z.array(z.looseObject({ message: z.string() }));

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

export type RerunReply = Readonly<{ ok: boolean; status: number }>;

export type RerunJob = (
	repository: string,
	jobId: number,
) => Promise<RerunReply>;

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

const FAILED = new Set(["failure", "timed_out"]);

export const DECISION_LOOKBACK_MS = 10 * 60_000;
export const DECISION_READ_LIMIT = 500;
export const DECISION_READ_MAX = 32_000;

export type AutoRetryDeps = Readonly<{
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

async function runDecisions(
	run: InsightRun,
	deps: AutoRetryDeps,
): Promise<readonly RunnerRouteEvent[]> {
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
			event.request?.runId !== BigInt(run.id) ||
			event.request.runAttempt !== run.attempt
		)
			continue;
		const key = event.jobId === "" ? `#${byJob.size}` : event.jobId;
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
		annotations: started ? await deps.annotations(run.repository, job.id) : [],
		machineDisconnects,
	};
}

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
	const chosen =
		facts.find(({ failed }) => retryKind(failed) === undefined) ?? facts[0];
	if (!chosen) return { retried: false, reason: "no_routed_failure" };
	const rows = await deps.ledger.forRun(run.repository, run.id);
	const kept = rows.find((row) => row.attempt === run.attempt);
	if (kept) {
		if (
			await deps.ledger.reclaim(run.repository, run.id, run.attempt, deps.nowMs)
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

export async function routeRetryFor(
	ledger: RetryLedger,
	request: RunnerRouteRequest,
): Promise<RouteRetry | undefined> {
	if (request.runAttempt <= 1) return undefined;
	const row = (
		await ledger.forRun(request.repository, Number(request.runId))
	).find(
		(kept) =>
			kept.attempt === request.runAttempt - 1 &&
			kept.relayJob === request.job &&
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
