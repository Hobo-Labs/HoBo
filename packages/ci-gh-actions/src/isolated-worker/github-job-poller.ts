import { createHash } from "node:crypto";
import { z } from "zod";
import type { AdmissionOrder } from "../admission-order.js";
import type { GithubTransport } from "../github.js";
import type { JobDurations } from "../job-durations.js";
import { runnerCustody } from "../job-runner-custody.js";
import { servedRunnerLabel, TRUNK_RUNNER_LABEL } from "../runner-labels.js";
import type {
	HeldJobPollWitness,
	HeldJobPruneReason,
} from "./held-job-prune.js";
import type { PollIngestCoalesce } from "./poll-ingest-coalesce.js";

/** Pull-mode admission: GitHub REST stands in for webhook ingress, so a box
 * needs no public URL, relay, or shared database to see `runs-on: hobo` work. */
export interface GithubJobPollerOptions {
	github: GithubTransport;
	/** Repositories to watch; read every poll so connection changes apply live. */
	connections: () => Promise<
		readonly Readonly<{
			installationId: number;
			repositoryId: number;
			repository: string;
		}>[]
	>;
	/** Durable intake (the store's inbox); returns accepted/requeued/duplicate/ignored. */
	ingest: (delivery: {
		deliveryId: string;
		event: "workflow_job";
		rawBody: Uint8Array;
		receivedAt: string;
	}) => Promise<string>;
	/** Called when the inbox refuses one polled job; the poll carries on. */
	onIngestError?: (jobId: number, message: string) => void;
	/** Called for every GitHub read that answers neither 2xx nor a usable 304; the poll carries on without it. */
	onGithubError?: (failure: GithubReadFailure) => void;
	/** Fed every `hobo` job the poll reads, so admission can put a run's longest job first. */
	durations?: Pick<JobDurations, "observe">;
	/** Primed from the run lists already read here, at no extra GitHub request. */
	admissionOrder?: Pick<AdmissionOrder, "prime">;
	/** Runs before each poll (merge queue positions, etc.). */
	beforePoll?: () => Promise<void>;
	/**
	 * Once per poll when a queued trunk job belongs to the newest main Fabric push.
	 * Used to pre-warm a spare container without cancelling other work.
	 */
	onMainFabricTrunkQueued?: (repository: string) => void;
	ingestCoalesce?: PollIngestCoalesce;
	/**
	 * Asked once per poll for each queued job before it is taken in. False
	 * leaves the job in GitHub's queue for another node, or for this node on
	 * a later poll. With a relay mesh this is where a node waits its turn.
	 * A rejection counts as true: a broken gate must not strand the queue.
	 */
	claim?: (job: {
		jobId: number;
		runId: number;
		repository: string;
		label: string;
		/** The job's name, when the list carried it: what its size is known by. */
		name: string | undefined;
		/** GitHub's `created_at`, when the list carried it. */
		createdAt: string | undefined;
	}) => Promise<boolean>;
	now?: () => number;
}

export interface GithubJobPollSummary {
	readonly repositories: number;
	readonly runs: number;
	readonly hoboJobs: number;
	readonly accepted: number;
	/** Jobs the inbox refused this poll (see `onIngestError`). */
	readonly failed: number;
	/** Completed run attempts whose jobs were all seen completed on an earlier poll. */
	readonly settled: number;
	/** Reads GitHub answered 304 to, which do not count against the rate limit. */
	readonly notModified: number;
	/** Reads GitHub refused (see `onGithubError`). */
	readonly githubErrors: number;
	/** Queued `hobo` jobs this poll saw but did not newly accept: already in the inbox, ignored, or refused. */
	readonly waiting: readonly WaitingJob[];
	/** Terminal runs/jobs already on this poll's GitHub reads; feeds held-job prune. */
	readonly heldPruneWitness?: HeldJobPollWitness;
	readonly pausedUntil?: string;
	readonly rateLimitRemaining?: number;
	/**
	 * Present only when the poll completed: the jobs runners hold on fleet
	 * labels, for the fleet verdict reporter. What is ingested is unchanged.
	 */
	readonly fleetJobs?: FleetJobsSeen;
}

/** A job a runner holds on a fleet label, as the poll read it. */
export interface FleetJobInProgress {
	readonly label: string;
	readonly runnerName: string;
	/** GitHub's `started_at`; absent when the list did not carry it. */
	readonly startedAt?: string;
}

export interface FleetJobsSeen {
	/** When the poll that read them completed. */
	readonly completedAt: string;
	readonly inProgress: readonly FleetJobInProgress[];
}

export interface GithubReadFailure {
	readonly installationId: number;
	readonly path: string;
	readonly status: number;
}

export interface WaitingJob {
	readonly jobId: number;
	readonly runId: number;
	readonly result: string;
}

const COMPLETED_LOOKBACK_MS = 2 * 60 * 60 * 1000;
/** `created>=` is rounded down to this, so the completed-runs URL (and its ETag) holds still between polls. */
const LOOKBACK_STEP_MS = 10 * 60 * 1000;
const RUN_STATUSES = ["queued", "in_progress"] as const;
/** GitHub's status-filtered list has gone on answering `total_count: 0` for a run the
 * unfiltered list showed queued (41622562414, for over 16 minutes), so the newest runs
 * are read without a filter too and the two are unioned. */
const NEWEST_RUNS = 50;
const PolledStatus = z.enum(["queued", "in_progress", "completed"]);
const STATUS_CODE = { queued: "q", in_progress: "p", completed: "c" } as const;
/** Leave headroom for the worker's own job/run lookups and runner registration. */
const RATE_LIMIT_FLOOR = 300;
const DEFAULT_PAUSE_MS = 60_000;

const Runs = z.object({
	workflow_runs: z.array(
		z.object({
			id: z.number().int().positive(),
			run_attempt: z.number().int().positive().optional(),
			status: z.string().nullable().optional(),
			conclusion: z.string().nullable().optional(),
			event: z.string().optional(),
			head_branch: z.string().nullable().optional(),
			head_sha: z.string().optional(),
			path: z.string().optional(),
			run_started_at: z.string().nullable().optional(),
		}),
	),
});
type Run = z.infer<typeof Runs>["workflow_runs"][number];

/** Workflow file path for {@link HOBO_CI_FABRIC_WORKFLOW_BASENAME}. */
// public-contract: shared workflow basename for superseded main-push poll filtering.
export const HOBO_CI_FABRIC_WORKFLOW_BASENAME = "hobo-ci.yml";

function runStartedAtMs(run: Run): number {
	const parsed = Date.parse(run.run_started_at ?? "");
	return Number.isFinite(parsed) ? parsed : 0;
}

function completedRunPruneReason(
	conclusion: string | null | undefined,
): HeldJobPruneReason {
	return conclusion === "cancelled" ? "run-cancelled" : "run-completed";
}

function completedJobPruneReason(
	conclusion: string | null | undefined,
): "job-cancelled" | "job-completed" {
	return conclusion === "cancelled" ? "job-cancelled" : "job-completed";
}

/** Newest in-flight HoBo CI Fabric push to `main`, if any. */
export function newestMainFabricPushRunId(
	runs: readonly Run[],
	workflowBasename = HOBO_CI_FABRIC_WORKFLOW_BASENAME,
): number | undefined {
	const mainPush = runs.filter((run) => {
		if (run.event !== "push") return false;
		if (run.head_branch !== "main") return false;
		const path = run.path ?? "";
		if (!path.endsWith(`/${workflowBasename}`)) return false;
		const status = run.status ?? "";
		return status === "queued" || status === "in_progress";
	});
	if (mainPush.length === 0) return undefined;
	// A newer push waiting on the concurrency group has no jobs yet; prefer a
	// started run so the prewarm hint goes to the run that holds trunk jobs.
	const started = mainPush.filter((run) => run.status === "in_progress");
	const sorted = [...(started.length > 0 ? started : mainPush)].sort(
		(a, b) => runStartedAtMs(b) - runStartedAtMs(a),
	);
	return sorted[0]?.id;
}

/**
 * Older in-flight main pushes that a newer, started main push has replaced (a
 * re-run, or a run still winding down after a manual cancel). Only a run GitHub
 * reports `in_progress` replaces another: main pushes queue on one concurrency
 * group, so a newer run still waiting for the running one must never starve it.
 * GitHub can report a run that already has jobs running as `queued`, so this
 * misses some replacements rather than inventing one; admission order (newest
 * push first) covers what it misses.
 */
export function supersededMainFabricPushRunIds(
	runs: readonly Run[],
	workflowBasename = HOBO_CI_FABRIC_WORKFLOW_BASENAME,
): ReadonlySet<number> {
	const mainPush = runs.filter((run) => {
		if (run.event !== "push") return false;
		if (run.head_branch !== "main") return false;
		const path = run.path ?? "";
		if (!path.endsWith(`/${workflowBasename}`)) return false;
		const status = run.status ?? "";
		return status === "queued" || status === "in_progress";
	});
	if (mainPush.length <= 1) return new Set();
	const started = mainPush.filter((run) => run.status === "in_progress");
	const newestStarted = [...started].sort(
		(a, b) => runStartedAtMs(b) - runStartedAtMs(a),
	)[0];
	if (newestStarted === undefined) return new Set();
	const since = runStartedAtMs(newestStarted);
	return new Set(
		mainPush
			.filter(
				(run) => run.id !== newestStarted.id && runStartedAtMs(run) < since,
			)
			.map((run) => run.id),
	);
}
const Jobs = z.object({
	jobs: z.array(
		z.object({
			id: z.number().int().positive(),
			run_id: z.number().int().positive(),
			run_attempt: z.number().int().positive(),
			status: z.string(),
			labels: z.array(z.string()),
			runner_name: z.string().nullable().optional(),
			name: z.string().optional(),
			conclusion: z.string().nullable().optional(),
			created_at: z.string().optional(),
			started_at: z.string().nullable().optional(),
			completed_at: z.string().nullable().optional(),
		}),
	),
});

class RateLimited extends Error {
	constructor(readonly untilMs: number) {
		super("github rate limited");
	}
}

export function createGithubJobPoller(options: GithubJobPollerOptions) {
	const now = options.now ?? Date.now;
	let pausedUntilMs = 0;
	let rateLimitRemaining: number | undefined;

	function observeRateLimit(response: Response): void {
		const remaining = Number(response.headers.get("x-ratelimit-remaining"));
		const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
		const retryAfter = Number(response.headers.get("retry-after"));
		if (
			Number.isFinite(remaining) &&
			response.headers.has("x-ratelimit-remaining")
		)
			rateLimitRemaining = remaining;
		const limited =
			response.status === 429 ||
			(response.status === 403 && (remaining === 0 || retryAfter > 0)) ||
			(rateLimitRemaining !== undefined &&
				rateLimitRemaining < RATE_LIMIT_FLOOR);
		if (!limited) return;
		const until =
			retryAfter > 0
				? now() + retryAfter * 1000
				: resetSeconds > 0
					? resetSeconds * 1000
					: now() + DEFAULT_PAUSE_MS;
		throw new RateLimited(Math.max(until, now() + 1000));
	}

	// Last body and ETag per read, so an unchanged list costs a free 304. Only
	// reads made by the last complete poll are kept.
	let etags = new Map<string, Readonly<{ etag: string; body: string }>>();
	let readThisPoll = new Map<
		string,
		Readonly<{ etag: string; body: string }>
	>();
	// Completed run attempts whose jobs were all completed when last read: they
	// cannot change again (a re-run is a new attempt), so they are not re-read.
	let settled = new Set<string>();

	async function getJson<T>(
		installationId: number,
		path: string,
		schema: z.ZodType<T>,
		summary: { notModified: number; githubErrors: number },
	): Promise<T | undefined> {
		const key = `${installationId} ${path}`;
		const cached = etags.get(key);
		const response = await options.github.request(
			installationId,
			path,
			"GET",
			undefined,
			cached?.etag,
		);
		observeRateLimit(response);
		if (response.status === 304 && cached) {
			summary.notModified++;
			readThisPoll.set(key, cached);
			return schema.parse(JSON.parse(cached.body));
		}
		if (!response.ok) {
			summary.githubErrors++;
			options.onGithubError?.({
				installationId,
				path,
				status: response.status,
			});
			return undefined;
		}
		const body = await response.text();
		const etag = response.headers.get("etag");
		if (etag) readThisPoll.set(key, { etag, body });
		return schema.parse(JSON.parse(body));
	}

	function primeRuns(runs: readonly Run[] | undefined): void {
		for (const run of runs ?? []) {
			if (run.event !== undefined)
				options.admissionOrder?.prime({
					runId: run.id,
					event: run.event,
					runStartedAt: run.run_started_at,
					headSha: run.head_sha,
				});
		}
	}

	async function poll(): Promise<GithubJobPollSummary> {
		const waiting: WaitingJob[] = [];
		const inProgress: FleetJobInProgress[] = [];
		const witnessTerminalRuns: HeldJobPollWitness["terminalRuns"][number][] =
			[];
		const witnessTerminalJobs: HeldJobPollWitness["terminalJobs"][number][] =
			[];
		const summary = {
			repositories: 0,
			runs: 0,
			hoboJobs: 0,
			accepted: 0,
			failed: 0,
			settled: 0,
			notModified: 0,
			githubErrors: 0,
			waiting,
		};
		if (now() < pausedUntilMs)
			return {
				...summary,
				pausedUntil: new Date(pausedUntilMs).toISOString(),
			};
		const seen = new Set<number>();
		readThisPoll = new Map();
		const stillSettled = new Set<string>();
		try {
			await options.beforePoll?.();
			for (const connection of await options.connections()) {
				if (seen.has(connection.repositoryId)) continue;
				seen.add(connection.repositoryId);
				summary.repositories++;
				const runIds = new Set<number>();
				const activeRuns: Run[] = [];
				for (const status of RUN_STATUSES) {
					const runs = await getJson(
						connection.installationId,
						`/repos/${connection.repository}/actions/runs?status=${status}&per_page=50`,
						Runs,
						summary,
					);
					primeRuns(runs?.workflow_runs);
					for (const run of runs?.workflow_runs ?? []) {
						runIds.add(run.id);
						activeRuns.push(run);
					}
				}
				const newest = await getJson(
					connection.installationId,
					`/repos/${connection.repository}/actions/runs?per_page=${NEWEST_RUNS}`,
					Runs,
					summary,
				);
				primeRuns(newest?.workflow_runs);
				const newestCompleted: Run[] = [];
				for (const run of newest?.workflow_runs ?? []) {
					if (run.status === "completed") newestCompleted.push(run);
					else {
						runIds.add(run.id);
						activeRuns.push(run);
					}
				}
				// A run that finished drops out of queued/in_progress before its last
				// job's completion is seen; without it the runner's container is only
				// reaped at max runtime and holds a slot. Recent completed runs close that.
				const sinceMs =
					Math.floor((now() - COMPLETED_LOOKBACK_MS) / LOOKBACK_STEP_MS) *
					LOOKBACK_STEP_MS;
				const since = new Date(sinceMs).toISOString();
				const completed = await getJson(
					connection.installationId,
					`/repos/${connection.repository}/actions/runs?status=completed&created=%3E%3D${since}&per_page=50`,
					Runs,
					summary,
				);
				primeRuns(completed?.workflow_runs);
				const settling = new Map<
					number,
					Readonly<{ key: string; attempt: number }>
				>();
				const completedRuns = new Map(
					[...(completed?.workflow_runs ?? []), ...newestCompleted].map(
						(run) => [run.id, run],
					),
				);
				for (const run of completedRuns.values()) {
					if (runIds.has(run.id)) continue;
					const key =
						run.run_attempt === undefined
							? undefined
							: `${connection.repositoryId}:${run.id}:${run.run_attempt}`;
					if (key !== undefined && settled.has(key)) {
						stillSettled.add(key);
						summary.settled++;
						continue;
					}
					runIds.add(run.id);
					if (key !== undefined && run.run_attempt !== undefined)
						settling.set(run.id, { key, attempt: run.run_attempt });
				}
				const supersededRuns = supersededMainFabricPushRunIds(activeRuns);
				const witnessRunsSeen = new Set<string>();
				for (const run of completedRuns.values()) {
					const dedupe = `${connection.repositoryId}:${run.id}`;
					if (witnessRunsSeen.has(dedupe)) continue;
					witnessRunsSeen.add(dedupe);
					witnessTerminalRuns.push({
						repositoryId: connection.repositoryId,
						runId: run.id,
						reason: completedRunPruneReason(run.conclusion),
					});
				}
				for (const runId of supersededRuns) {
					const dedupe = `${connection.repositoryId}:${runId}`;
					if (witnessRunsSeen.has(dedupe)) continue;
					witnessRunsSeen.add(dedupe);
					witnessTerminalRuns.push({
						repositoryId: connection.repositoryId,
						runId,
						reason: "run-superseded",
					});
				}
				const newestMainPush = newestMainFabricPushRunId(activeRuns);
				let mainFabricPrewarmHinted = false;
				summary.runs += runIds.size;
				for (const runId of runIds) {
					if (supersededRuns.has(runId)) continue;
					const jobs = await getJson(
						connection.installationId,
						`/repos/${connection.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
						Jobs,
						summary,
					);
					const attempt = settling.get(runId);
					const failedBefore = summary.failed;
					for (const job of jobs?.jobs ?? []) {
						const status = PolledStatus.safeParse(job.status);
						const label = servedRunnerLabel(job.labels);
						if (!status.success || !label) continue;
						if (status.data === "in_progress" && job.runner_name)
							inProgress.push(
								job.started_at
									? {
											label,
											runnerName: job.runner_name,
											startedAt: job.started_at,
										}
									: { label, runnerName: job.runner_name },
							);
						if (status.data === "completed") {
							witnessTerminalJobs.push({
								repositoryId: connection.repositoryId,
								jobId: job.id,
								runAttempt: job.run_attempt,
								reason: completedJobPruneReason(job.conclusion),
							});
						}
						if (job.name !== undefined)
							options.durations?.observe({
								repository: connection.repository,
								id: job.id,
								name: job.name,
								conclusion: job.conclusion,
								startedAt: job.started_at,
								completedAt: job.completed_at,
							});
						// Assignment is only useful once GitHub names the runner.
						if (status.data !== "queued" && !job.runner_name) continue;
						summary.hoboJobs++;
						if (
							!mainFabricPrewarmHinted &&
							(status.data === "queued" || status.data === "completed") &&
							servedRunnerLabel(job.labels) === TRUNK_RUNNER_LABEL &&
							newestMainPush !== undefined &&
							job.run_id === newestMainPush
						) {
							mainFabricPrewarmHinted = true;
							options.onMainFabricTrunkQueued?.(connection.repository);
						}
						const queuedSinceMs =
							job.created_at !== undefined
								? Date.parse(job.created_at)
								: undefined;
						if (supersededRuns.has(job.run_id)) {
							summary.waiting.push({
								jobId: job.id,
								runId: job.run_id,
								result: "superseded-main-push",
							});
							continue;
						}
						if (
							status.data === "queued" &&
							options.ingestCoalesce?.shouldSkip(
								connection.repositoryId,
								job.id,
								job.run_attempt,
								queuedSinceMs,
							)
						) {
							summary.waiting.push({
								jobId: job.id,
								runId: job.run_id,
								result: "coalesced",
							});
							continue;
						}
						if (status.data === "queued" && options.claim) {
							const mine = await options
								.claim({
									jobId: job.id,
									runId: job.run_id,
									repository: connection.repository,
									label: servedRunnerLabel(job.labels) ?? "",
									name: job.name,
									createdAt: job.created_at,
								})
								.catch(() => true);
							if (!mine) {
								summary.waiting.push({
									jobId: job.id,
									runId: job.run_id,
									result: "mesh-deferred",
								});
								continue;
							}
						}
						const rawBody = Buffer.from(
							JSON.stringify({
								action: status.data,
								installation: { id: connection.installationId },
								repository: {
									id: connection.repositoryId,
									full_name: connection.repository,
								},
								workflow_job: {
									id: job.id,
									run_id: job.run_id,
									run_attempt: job.run_attempt,
									labels: job.labels,
									name: job.name,
									created_at: job.created_at,
									// GitHub reports an unassigned job as "" or null; one body for both.
									runner_name: job.runner_name || null,
								},
							}),
						);
						// The runner name is part of the body, so it is part of the id: a job
						// GitHub reassigns to another runner is a new observation, not a
						// conflicting replay of the old one.
						const runnerKey =
							runnerCustody(job.runner_name) === "foreign"
								? `-${createHash("sha256")
										.update(job.runner_name ?? "")
										.digest("hex")
										.slice(0, 12)}`
								: "";
						let result: Awaited<ReturnType<typeof options.ingest>>;
						try {
							result = await options.ingest({
								deliveryId: `poll-${job.id}-${job.run_attempt}-${STATUS_CODE[status.data]}${runnerKey}`,
								event: "workflow_job",
								rawBody,
								receivedAt: new Date(now()).toISOString(),
							});
						} catch (error) {
							// One job the inbox refuses must not starve every later job.
							summary.failed++;
							options.onIngestError?.(
								job.id,
								error instanceof Error ? error.message : "unknown",
							);
							result = "failed";
						}
						options.ingestCoalesce?.observe(
							connection.repositoryId,
							job.id,
							job.run_attempt,
							result,
						);
						if (result === "accepted" || result === "requeued")
							summary.accepted++;
						else if (status.data === "queued")
							summary.waiting.push({
								jobId: job.id,
								runId: job.run_id,
								result,
							});
					}
					if (
						attempt !== undefined &&
						jobs !== undefined &&
						summary.failed === failedBefore &&
						jobs.jobs.every(
							(job) =>
								job.status === "completed" &&
								job.run_attempt === attempt.attempt,
						)
					)
						stillSettled.add(attempt.key);
				}
			}
			etags = readThisPoll;
			settled = stillSettled;
		} catch (error) {
			if (!(error instanceof RateLimited)) throw error;
			// A poll cut short keeps what it learned without forgetting the rest.
			for (const [key, value] of readThisPoll) etags.set(key, value);
			for (const attempt of stillSettled) settled.add(attempt);
			pausedUntilMs = error.untilMs;
			const paused: GithubJobPollSummary = {
				...summary,
				heldPruneWitness: {
					terminalRuns: witnessTerminalRuns,
					terminalJobs: witnessTerminalJobs,
				},
				pausedUntil: new Date(pausedUntilMs).toISOString(),
			};
			return rateLimitRemaining === undefined
				? paused
				: { ...paused, rateLimitRemaining };
		}
		const heldPruneWitness: HeldJobPollWitness = {
			terminalRuns: witnessTerminalRuns,
			terminalJobs: witnessTerminalJobs,
		};
		const fleetJobs: FleetJobsSeen = {
			completedAt: new Date(now()).toISOString(),
			inProgress,
		};
		return rateLimitRemaining === undefined
			? { ...summary, heldPruneWitness, fleetJobs }
			: { ...summary, heldPruneWitness, fleetJobs, rateLimitRemaining };
	}

	return { poll };
}

/** `run/job:result` per waiting job, the form a poll log line carries. */
export function describeWaitingJobs(waiting: readonly WaitingJob[]): string {
	return waiting
		.map((job) => `${job.runId}/${job.jobId}:${job.result}`)
		.join(",");
}

/** Which poll summaries are worth a log line: any that accepted, refused, paused or
 * failed a GitHub read, and any whose waiting jobs changed or are still waiting
 * `repeatMs` after they were last logged. An idle poll stays quiet; a stuck one does not. */
export function createPollLogFilter(repeatMs = 60_000) {
	let lastWaiting = "";
	let lastLoggedMs = Number.NEGATIVE_INFINITY;
	return (summary: GithubJobPollSummary, nowMs: number): boolean => {
		const waiting = describeWaitingJobs(summary.waiting);
		const worth =
			summary.accepted > 0 ||
			summary.failed > 0 ||
			summary.githubErrors > 0 ||
			summary.pausedUntil !== undefined ||
			waiting !== lastWaiting ||
			(waiting !== "" && nowMs - lastLoggedMs >= repeatMs);
		lastWaiting = waiting;
		if (worth) lastLoggedMs = nowMs;
		return worth;
	};
}
