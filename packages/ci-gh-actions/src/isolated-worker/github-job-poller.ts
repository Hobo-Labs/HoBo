import { createHash } from "node:crypto";
import { z } from "zod";
import type { GithubTransport } from "../github.js";

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
	/** Durable intake (the store's inbox); returns accepted/duplicate/ignored. */
	ingest: (delivery: {
		deliveryId: string;
		event: "workflow_job";
		rawBody: Uint8Array;
		receivedAt: string;
	}) => Promise<string>;
	/** Called when the inbox refuses one polled job; the poll carries on. */
	onIngestError?: (jobId: number, message: string) => void;
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
	readonly pausedUntil?: string;
	readonly rateLimitRemaining?: number;
}

const COMPLETED_LOOKBACK_MS = 2 * 60 * 60 * 1000;
/** `created>=` is rounded down to this, so the completed-runs URL (and its ETag) holds still between polls. */
const LOOKBACK_STEP_MS = 10 * 60 * 1000;
const RUN_STATUSES = ["queued", "in_progress"] as const;
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
		}),
	),
});
const Jobs = z.object({
	jobs: z.array(
		z.object({
			id: z.number().int().positive(),
			run_id: z.number().int().positive(),
			run_attempt: z.number().int().positive(),
			status: z.string(),
			labels: z.array(z.string()),
			runner_name: z.string().nullable().optional(),
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
		summary: { notModified: number },
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
		if (!response.ok) return undefined;
		const body = await response.text();
		const etag = response.headers.get("etag");
		if (etag) readThisPoll.set(key, { etag, body });
		return schema.parse(JSON.parse(body));
	}

	async function poll(): Promise<GithubJobPollSummary> {
		const summary = {
			repositories: 0,
			runs: 0,
			hoboJobs: 0,
			accepted: 0,
			failed: 0,
			settled: 0,
			notModified: 0,
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
			for (const connection of await options.connections()) {
				if (seen.has(connection.repositoryId)) continue;
				seen.add(connection.repositoryId);
				summary.repositories++;
				const runIds = new Set<number>();
				for (const status of RUN_STATUSES) {
					const runs = await getJson(
						connection.installationId,
						`/repos/${connection.repository}/actions/runs?status=${status}&per_page=50`,
						Runs,
						summary,
					);
					for (const run of runs?.workflow_runs ?? []) runIds.add(run.id);
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
				const settling = new Map<
					number,
					Readonly<{ key: string; attempt: number }>
				>();
				for (const run of completed?.workflow_runs ?? []) {
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
				summary.runs += runIds.size;
				for (const runId of runIds) {
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
						if (
							!status.success ||
							job.labels.length !== 1 ||
							job.labels[0]?.toLowerCase() !== "hobo"
						)
							continue;
						// Assignment is only useful once GitHub names the runner.
						if (status.data !== "queued" && !job.runner_name) continue;
						summary.hoboJobs++;
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
									// GitHub reports an unassigned job as "" or null; one body for both.
									runner_name: job.runner_name || null,
								},
							}),
						);
						// The runner name is part of the body, so it is part of the id: a job
						// GitHub reassigns to another runner is a new observation, not a
						// conflicting replay of the old one.
						const runnerKey = job.runner_name
							? `-${createHash("sha256").update(job.runner_name).digest("hex").slice(0, 12)}`
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
							continue;
						}
						if (result === "accepted") summary.accepted++;
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
				pausedUntil: new Date(pausedUntilMs).toISOString(),
			};
			return rateLimitRemaining === undefined
				? paused
				: { ...paused, rateLimitRemaining };
		}
		return rateLimitRemaining === undefined
			? summary
			: { ...summary, rateLimitRemaining };
	}

	return { poll };
}
