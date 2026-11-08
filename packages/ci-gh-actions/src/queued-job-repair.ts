import type { ConfigurationState } from "@hobo/ci";
import type { Pool } from "pg";
import { z } from "zod";
import type { GithubTransport } from "./github.js";
import type { HostedRelay } from "./hosted-relay.js";
import { unlockAndRelease } from "./postgres-session-lock.js";
import { servedRunnerLabel } from "./runner-labels.js";

const Status = z.enum([
	"queued",
	"in_progress",
	"waiting",
	"pending",
	"requested",
]);
const statuses = Status.options;
const Cursor = z
	.object({
		page: z.number().int().min(1).max(1000),
		runs: z
			.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
			.max(100),
		loaded: z.boolean(),
		hasNext: z.boolean(),
		runIndex: z.number().int().min(0).max(100),
		jobPage: z.number().int().min(1).max(1000),
		jobIndex: z.number().int().min(0).max(100),
	})
	.strict();
type Cursor = z.infer<typeof Cursor>;
const initial = (): Cursor => ({
	page: 1,
	runs: [],
	loaded: false,
	hasNext: false,
	runIndex: 0,
	jobPage: 1,
	jobIndex: 0,
});
const RunPage = z.object({
	workflow_runs: z
		.array(
			z.object({
				id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			}),
		)
		.max(100),
});
const JobPage = z.object({
	jobs: z
		.array(
			z.object({
				id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
				run_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
				run_attempt: z.number().int().positive().optional(),
				status: z.string(),
				labels: z.array(z.string()),
				runner_name: z.string().nullable().optional(),
			}),
		)
		.max(100),
});

export interface QueuedRepairClaims {
	start(keys: readonly string[]): Promise<
		| undefined
		| "busy"
		| "deferred"
		| {
				key: string;
				cursor: Cursor;
				take(count: number): Promise<boolean>;
				checkpoint(cursor: Cursor, dueMs: number): Promise<void>;
				more(): Promise<boolean>;
				close(): Promise<void>;
		  }
	>;
}

/** One app-wide scanner and a shared ten-request-per-minute REST budget. */
export class PostgresQueuedJobRepairClaims implements QueuedRepairClaims {
	constructor(
		private readonly pool: Pool,
		private readonly appId: string,
		private readonly scanPool: Pool = pool,
	) {
		if (!/^[1-9]\d*$/.test(appId)) throw new Error("invalid App identity");
	}
	async initialize() {
		await this.pool.query(`CREATE TABLE IF NOT EXISTS hobo_ci_queued_scans (
			app_id text NOT NULL, scan_key text NOT NULL, cursor jsonb NOT NULL,
			due_ms bigint NOT NULL DEFAULT 0, touched_ms bigint NOT NULL DEFAULT 0,
			PRIMARY KEY(app_id,scan_key))`);
		await this.pool.query(`CREATE TABLE IF NOT EXISTS hobo_ci_queued_api_budget (
			app_id text NOT NULL, used_ms bigint NOT NULL)`);
		await this.pool.query(
			`CREATE INDEX IF NOT EXISTS hobo_ci_queued_api_budget_time ON hobo_ci_queued_api_budget(app_id,used_ms)`,
		);
	}
	async start(keys: readonly string[]) {
		if (keys.length === 0) return undefined;
		await this.initialize();
		const client = await this.scanPool.connect();
		let locked = false;
		let released = false;
		const close = async () => {
			if (released) return;
			released = true;
			await unlockAndRelease(client, `hobo-ci-queued-scan:${this.appId}`);
		};
		try {
			const acquisition = await client.query<{ locked: boolean }>(
				"SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
				[`hobo-ci-queued-scan:${this.appId}`],
			);
			locked = z.boolean().parse(acquisition.rows[0]?.locked);
			if (!locked) {
				released = true;
				client.release();
				return "busy" as const;
			}
			for (const key of keys)
				await client.query(
					"INSERT INTO hobo_ci_queued_scans(app_id,scan_key,cursor) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING",
					[this.appId, key, JSON.stringify(initial())],
				);
			const result = await client.query<{ scan_key: string; cursor: unknown }>(
				"SELECT scan_key,cursor FROM hobo_ci_queued_scans WHERE app_id=$1 AND scan_key=ANY($2::text[]) AND due_ms <= EXTRACT(EPOCH FROM clock_timestamp())*1000 ORDER BY touched_ms,scan_key LIMIT 1",
				[this.appId, keys],
			);
			const row = result.rows[0];
			if (!row) {
				// A partial scan may have been delayed by the shared API budget.
				// It is not complete while a key will resume within a minute.
				const deferred = await client.query(
					"SELECT 1 FROM hobo_ci_queued_scans WHERE app_id=$1 AND scan_key=ANY($2::text[]) AND due_ms <= EXTRACT(EPOCH FROM clock_timestamp())*1000+60000 LIMIT 1",
					[this.appId, keys],
				);
				await close();
				return deferred.rowCount ? ("deferred" as const) : undefined;
			}
			const cursor = Cursor.parse(row.cursor);
			const take = async (count: number) => {
				if (!Number.isInteger(count) || count < 1 || count > 10)
					throw new Error("invalid API budget");
				await client.query(
					"DELETE FROM hobo_ci_queued_api_budget WHERE app_id=$1 AND used_ms <= EXTRACT(EPOCH FROM clock_timestamp())*1000-60000",
					[this.appId],
				);
				const used = await client.query<{ count: string }>(
					"SELECT count(*) FROM hobo_ci_queued_api_budget WHERE app_id=$1",
					[this.appId],
				);
				if (Number(used.rows[0]?.count) + count > 10) return false;
				await client.query(
					"INSERT INTO hobo_ci_queued_api_budget(app_id,used_ms) SELECT $1,EXTRACT(EPOCH FROM clock_timestamp())*1000 FROM generate_series(1,$2)",
					[this.appId, count],
				);
				return true;
			};
			const checkpoint = async (next: Cursor, dueMs: number) => {
				Cursor.parse(next);
				if (!Number.isInteger(dueMs) || dueMs < 0 || dueMs > 900000)
					throw new Error("invalid scan delay");
				await client.query(
					"UPDATE hobo_ci_queued_scans SET cursor=$3::jsonb, touched_ms=EXTRACT(EPOCH FROM clock_timestamp())*1000, due_ms=EXTRACT(EPOCH FROM clock_timestamp())*1000+$4 WHERE app_id=$1 AND scan_key=$2",
					[this.appId, row.scan_key, JSON.stringify(next), dueMs],
				);
			};
			const more = async () =>
				(
					await client.query(
						"SELECT 1 FROM hobo_ci_queued_scans WHERE app_id=$1 AND scan_key=ANY($2::text[]) AND due_ms <= EXTRACT(EPOCH FROM clock_timestamp())*1000+60000 LIMIT 1",
						[this.appId, keys],
					)
				).rowCount !== 0;
			return { key: row.scan_key, cursor, take, checkpoint, more, close };
		} catch (error) {
			if (!released) {
				if (locked) await close().catch(() => {});
				else {
					released = true;
					// A lost acquire response may hide a held session lock.
					client.release(true);
				}
			}
			throw error;
		}
	}
}

/** Revisit still-queued jobs even after GitHub's delivery history has expired.
 * Pagination is not a point-in-time snapshot: repeated cycles provide eventual
 * recovery, not a guarantee for jobs that stop being queued during a scan. */
export function createQueuedJobRepair(options: {
	store: { configuration(): Promise<ConfigurationState | undefined> };
	github: GithubTransport;
	claims: QueuedRepairClaims;
	relay: () => Promise<Pick<HostedRelay, "processWebhook">>;
	/** Whether this deployment has recent completed scanner evidence. */
	idleComplete?: () => Promise<boolean>;
}) {
	return async function repair(): Promise<{
		more: boolean;
		truncated: false;
		failed: boolean;
		skipped?: boolean;
	}> {
		const config = (await options.store.configuration())?.configuration;
		if (!config) throw new Error("configuration unavailable");
		const entries = config.connections.flatMap((connection) =>
			statuses.map((status) => ({
				key: `${connection.accountId}:${connection.installationId}:${connection.repositoryId}:${status}`,
				connection,
				status,
			})),
		);
		const scan = await options.claims.start(entries.map((entry) => entry.key));
		if (scan === "busy" || scan === "deferred")
			return { more: true, truncated: false, failed: false, skipped: true };
		if (!scan)
			return entries.length === 0
				? { more: false, truncated: false, failed: false }
				: {
						more: !(await options.idleComplete?.()),
						truncated: false,
						failed: false,
						skipped: true,
					};
		const cursor = Cursor.parse(scan.cursor);
		try {
			const entry = entries.find((candidate) => candidate.key === scan.key);
			if (!entry) throw new Error("scan connection revoked");
			const connection = entry.connection;
			const prefix = `/repos/${connection.repository}/actions/runs`;
			if (!cursor.loaded) {
				if (!(await scan.take(1))) {
					await scan.checkpoint(cursor, 60000);
					return { more: true, truncated: false, failed: false };
				}
				const response = await options.github.request(
					connection.installationId,
					`${prefix}?status=${entry.status}&per_page=100&page=${cursor.page}`,
				);
				if (!response.ok) throw new Error("GitHub run scan unavailable");
				const runs = RunPage.parse(await response.json()).workflow_runs;
				if (runs.length === 0) {
					await scan.checkpoint(initial(), 600000);
					return { more: await scan.more(), truncated: false, failed: false };
				}
				cursor.runs = runs.map((run) => run.id);
				cursor.loaded = true;
				cursor.hasNext = runs.length === 100;
				await scan.checkpoint(cursor, 0);
			}
			const runId = cursor.runs[cursor.runIndex];
			if (runId === undefined) throw new Error("invalid scan cursor");
			if (!(await scan.take(1))) {
				await scan.checkpoint(cursor, 60000);
				return { more: true, truncated: false, failed: false };
			}
			const response = await options.github.request(
				connection.installationId,
				`${prefix}/${runId}/jobs?filter=latest&per_page=100&page=${cursor.jobPage}`,
			);
			if (!response.ok) throw new Error("GitHub job scan unavailable");
			const jobs = JobPage.parse(await response.json()).jobs;
			for (let i = cursor.jobIndex; i < jobs.length; i++) {
				const job = jobs[i];
				if (!job || job.run_id !== runId)
					throw new Error("GitHub job identity mismatch");
				if (job.status === "queued" && servedRunnerLabel(job.labels)) {
					if (!(await scan.take(2))) {
						cursor.jobIndex = i;
						await scan.checkpoint(cursor, 60000);
						return { more: true, truncated: false, failed: false };
					}
					const relay = await options.relay();
					await relay.processWebhook(
						Buffer.from(
							JSON.stringify({
								action: "queued",
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
									runner_name: job.runner_name ?? null,
								},
							}),
						),
						"workflow_job",
					);
				}
				cursor.jobIndex = i + 1;
				await scan.checkpoint(cursor, 0);
			}
			cursor.jobIndex = 0;
			if (jobs.length === 100) {
				if (cursor.jobPage === 1000)
					throw new Error("job scan exceeds pagination limit");
				cursor.jobPage++;
			} else {
				cursor.jobPage = 1;
				cursor.runIndex++;
			}
			if (cursor.runIndex >= cursor.runs.length) {
				if (!cursor.hasNext) {
					await scan.checkpoint(initial(), 600000);
					return { more: await scan.more(), truncated: false, failed: false };
				}
				if (cursor.page === 1000)
					throw new Error("run scan exceeds pagination limit");
				cursor.page++;
				cursor.runs = [];
				cursor.loaded = false;
				cursor.hasNext = false;
				cursor.runIndex = 0;
			}
			await scan.checkpoint(cursor, 60000);
			return { more: true, truncated: false, failed: false };
		} catch {
			// A broken installation backs off while other repository/status cursors advance.
			await scan.checkpoint(cursor, 60000);
			return { more: await scan.more(), truncated: false, failed: true };
		} finally {
			await scan.close();
		}
	};
}
