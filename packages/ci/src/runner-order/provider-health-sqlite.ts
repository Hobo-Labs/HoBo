/**
 * Provider health kept on disk, and the feed that fills it from finished
 * and queued jobs (ADR-0183).
 *
 * `SqliteProviderHealthStore` is the relay's `ProviderHealthStore`: one row
 * per runner type, the `ProviderHealthRecord` as protobuf JSON, so a tripped
 * type stays tripped across a restart. One file, one writer (ADR-0135).
 *
 * `feedProviderHealth` turns one job's facts into an outcome for each hosted
 * label it asked for: a start when a runner took the job, a miss when it sat
 * queued past `missedAfterMs`. Each job counts once per label and outcome, so
 * a redelivered webhook or a poller seeing the same queued job again does not
 * trip a provider on its own.
 */
import { DatabaseSync } from "node:sqlite";
import { toJsonString } from "@bufbuild/protobuf";
import {
	type JobFact,
	type ProviderHealthRecord,
	ProviderHealthRecordSchema,
} from "../_generated/relay_job_pb.js";
import {
	isProviderMiss,
	newProviderHealth,
	PROVIDER_HEALTH_DEFAULTS,
	type ProviderHealth,
	type ProviderHealthOptions,
	type ProviderOutcome,
	providerHealthKey,
	providerHealthState,
	recordProviderOutcome,
} from "./health.js";
import type { ProviderHealthStore } from "./ports.js";
import { runnerProviderOfLabel } from "./providers.js";
import {
	parseProviderHealthRecord,
	providerHealthOf,
	providerHealthRecord,
} from "./relay-job.js";

/** A store that also remembers which job outcomes it has already counted. */
export interface ProviderHealthFeedStore extends ProviderHealthStore {
	/**
	 * Mark one job's outcome for one runner type as counted. True the first
	 * time, false for the same key, job and outcome again.
	 */
	claimOutcome(
		key: string,
		jobId: number,
		started: boolean,
		atMs: number,
	): Promise<boolean>;
}

/** How long a counted job outcome is remembered: well past any redelivery. */
// public-contract: how long a counted provider outcome is remembered against a redelivery.
export const PROVIDER_OUTCOME_MEMORY_MS = 7 * 24 * 60 * 60_000;

/** The relay's provider health, in a SQLite file. */
export class SqliteProviderHealthStore implements ProviderHealthFeedStore {
	private readonly db: DatabaseSync;

	constructor(
		path: string,
		private readonly options: ProviderHealthOptions = PROVIDER_HEALTH_DEFAULTS,
	) {
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA busy_timeout = 5000");
		if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS provider_health (key TEXT PRIMARY KEY, body TEXT NOT NULL)",
		);
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS provider_health_outcomes (key TEXT NOT NULL, job_id INTEGER NOT NULL, started INTEGER NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (key, job_id, started))",
		);
	}

	private record(key: string): ProviderHealthRecord | undefined {
		const row = this.db
			.prepare("SELECT body FROM provider_health WHERE key = ?")
			.get(key);
		const body = row?.body;
		return body === undefined || body === null
			? undefined
			: parseProviderHealthRecord(String(body));
	}

	async get(key: string): Promise<ProviderHealth> {
		const found = this.record(key);
		return found ? providerHealthOf(found) : newProviderHealth();
	}

	async put(key: string, health: ProviderHealth): Promise<void> {
		const body = toJsonString(
			ProviderHealthRecordSchema,
			providerHealthRecord(key, health),
		);
		this.db
			.prepare(
				"INSERT INTO provider_health (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body",
			)
			.run(key, body);
	}

	async unhealthy(nowMs: number): Promise<ReadonlySet<string>> {
		const keys = new Set<string>();
		for (const record of await this.list())
			if (
				providerHealthState(providerHealthOf(record), nowMs, this.options) ===
				"unhealthy"
			)
				keys.add(record.key);
		return keys;
	}

	/** Every kept record, in key order. */
	async list(): Promise<readonly ProviderHealthRecord[]> {
		return this.db
			.prepare("SELECT body FROM provider_health ORDER BY key")
			.all()
			.map((row) => parseProviderHealthRecord(String(row.body)));
	}

	/** Forget a runner type's record, so it is healthy again. True when one was kept. */
	async clear(key: string): Promise<boolean> {
		const result = this.db
			.prepare("DELETE FROM provider_health WHERE key = ?")
			.run(key);
		return Number(result.changes) > 0;
	}

	async claimOutcome(
		key: string,
		jobId: number,
		started: boolean,
		atMs: number,
	): Promise<boolean> {
		this.db
			.prepare("DELETE FROM provider_health_outcomes WHERE at_ms < ?")
			.run(atMs - PROVIDER_OUTCOME_MEMORY_MS);
		const result = this.db
			.prepare(
				"INSERT OR IGNORE INTO provider_health_outcomes (key, job_id, started, at_ms) VALUES (?, ?, ?, ?)",
			)
			.run(key, jobId, started ? 1 : 0, Math.round(atMs));
		return Number(result.changes) > 0;
	}

	close(): void {
		this.db.close();
	}
}

/** One outcome `feedProviderHealth` counted, and the record it left. */
export type ProviderHealthFeed = Readonly<{
	key: string;
	outcome: ProviderOutcome;
	health: ProviderHealth;
}>;

/** The outcome a job's facts show for a hosted label at `nowMs`, if any yet. */
export function providerOutcomeOfJob(
	job: JobFact,
	nowMs: number,
	options: ProviderHealthOptions = PROVIDER_HEALTH_DEFAULTS,
): ProviderOutcome | undefined {
	if (job.startedAtMs !== undefined)
		return { atMs: job.startedAtMs, started: true };
	const waitedUntil = job.completedAtMs ?? nowMs;
	if (!isProviderMiss(job.queuedAtMs, waitedUntil, options)) return undefined;
	return { atMs: job.queuedAtMs + options.missedAfterMs, started: false };
}

/**
 * Record a start or a miss for each hosted label `job` asked for. Labels of
 * GitHub's own runners, machines and the fleet are not provider health. A job
 * still queued inside `missedAfterMs` records nothing yet.
 */
export async function feedProviderHealth(
	store: ProviderHealthFeedStore,
	job: JobFact,
	nowMs: number,
	options: ProviderHealthOptions = PROVIDER_HEALTH_DEFAULTS,
): Promise<readonly ProviderHealthFeed[]> {
	const outcome = providerOutcomeOfJob(job, nowMs, options);
	if (!outcome) return [];
	const keys = new Set<string>();
	for (const label of job.labels) {
		const provider = runnerProviderOfLabel(label);
		if (provider === undefined || provider === "github") continue;
		keys.add(providerHealthKey(provider, label));
	}
	const fed: ProviderHealthFeed[] = [];
	for (const key of keys) {
		if (!(await store.claimOutcome(key, job.id, outcome.started, outcome.atMs)))
			continue;
		const health = recordProviderOutcome(
			await store.get(key),
			outcome,
			options,
		);
		await store.put(key, health);
		fed.push({ key, outcome, health });
	}
	return fed;
}
