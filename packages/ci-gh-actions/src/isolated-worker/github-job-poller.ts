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
	onIngestError?: (jobId: number, error: unknown) => void;
	now?: () => number;
}

export interface GithubJobPollSummary {
	readonly repositories: number;
	readonly runs: number;
	readonly hoboJobs: number;
	readonly accepted: number;
	/** Jobs the inbox refused this poll (see `onIngestError`). */
	readonly failed: number;
	readonly pausedUntil?: string;
	readonly rateLimitRemaining?: number;
}

const COMPLETED_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const RUN_STATUSES = ["queued", "in_progress"] as const;
const PolledStatus = z.enum(["queued", "in_progress", "completed"]);
const STATUS_CODE = { queued: "q", in_progress: "p", completed: "c" } as const;
/** Leave headroom for the worker's own job/run lookups and runner registration. */
const RATE_LIMIT_FLOOR = 300;
const DEFAULT_PAUSE_MS = 60_000;

const Runs = z.object({
	workflow_runs: z.array(z.object({ id: z.number().int().positive() })),
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

	async function getJson<T>(
		installationId: number,
		path: string,
		schema: z.ZodType<T>,
	): Promise<T | undefined> {
		const response = await options.github.request(installationId, path);
		observeRateLimit(response);
		if (!response.ok) return undefined;
		return schema.parse(await response.json());
	}

	async function poll(): Promise<GithubJobPollSummary> {
		const summary = {
			repositories: 0,
			runs: 0,
			hoboJobs: 0,
			accepted: 0,
			failed: 0,
		};
		if (now() < pausedUntilMs)
			return {
				...summary,
				pausedUntil: new Date(pausedUntilMs).toISOString(),
			};
		const seen = new Set<number>();
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
					);
					for (const run of runs?.workflow_runs ?? []) runIds.add(run.id);
				}
				// A run that finished drops out of queued/in_progress before its last
				// job's completion is seen; without it the runner's container is only
				// reaped at max runtime and holds a slot. Recent completed runs close that.
				const since = new Date(now() - COMPLETED_LOOKBACK_MS).toISOString();
				const completed = await getJson(
					connection.installationId,
					`/repos/${connection.repository}/actions/runs?status=completed&created=%3E%3D${since}&per_page=50`,
					Runs,
				);
				for (const run of completed?.workflow_runs ?? []) runIds.add(run.id);
				summary.runs += runIds.size;
				for (const runId of runIds) {
					const jobs = await getJson(
						connection.installationId,
						`/repos/${connection.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
						Jobs,
					);
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
							options.onIngestError?.(job.id, error);
							continue;
						}
						if (result === "accepted") summary.accepted++;
					}
				}
			}
		} catch (error) {
			if (!(error instanceof RateLimited)) throw error;
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
