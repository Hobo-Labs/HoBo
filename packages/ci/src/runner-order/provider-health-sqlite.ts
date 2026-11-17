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
 *
 * While a type is tripped, only the trial job's miss doubles the back-off:
 * a job queued before the trial was let through was routed before the trip
 * (a fan-out still draining), so its miss is not a failed trial. A start or
 * a miss older than the record's newest outcome or its trip is a late report
 * (a backfill, a job list read newest first): it neither clears the record
 * nor counts towards a trip.
 *
 * The `provider_health_outcomes` table is a de-duplication index (key, job
 * id, outcome), not a record of its own: nothing reads it back but the claim,
 * so it has no protobuf/CUE definition. The record itself is
 * `ProviderHealthRecord`.
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
	 * In one step: mark one job's outcome for one runner type as counted and,
	 * the first time only, read the record, pass it to `next` and keep what
	 * `next` returns (`undefined` leaves the record as it is). Answers the
	 * record written, or `undefined` when nothing was written. A failure
	 * leaves neither the mark nor the record.
	 */
	recordJobOutcome(
		key: string,
		jobId: number,
		outcome: ProviderOutcome,
		next: (current: ProviderHealth) => ProviderHealth | undefined,
	): Promise<ProviderHealth | undefined>;
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

	private health(key: string): ProviderHealth {
		const found = this.record(key);
		return found ? providerHealthOf(found) : newProviderHealth();
	}

	async get(key: string): Promise<ProviderHealth> {
		return this.health(key);
	}

	async put(key: string, health: ProviderHealth): Promise<void> {
		this.write(key, health);
	}

	private write(key: string, health: ProviderHealth): void {
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

	async recordJobOutcome(
		key: string,
		jobId: number,
		outcome: ProviderOutcome,
		next: (current: ProviderHealth) => ProviderHealth | undefined,
	): Promise<ProviderHealth | undefined> {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare("DELETE FROM provider_health_outcomes WHERE at_ms < ?")
				.run(outcome.atMs - PROVIDER_OUTCOME_MEMORY_MS);
			const claimed = this.db
				.prepare(
					"INSERT OR IGNORE INTO provider_health_outcomes (key, job_id, started, at_ms) VALUES (?, ?, ?, ?)",
				)
				.run(key, jobId, outcome.started ? 1 : 0, Math.round(outcome.atMs));
			let written: ProviderHealth | undefined;
			if (Number(claimed.changes) > 0) {
				written = next(this.health(key));
				if (written) this.write(key, written);
			}
			this.db.exec("COMMIT");
			return written;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}
}

/**
 * Every record kept in the provider-health file at `path`, in key order, read
 * without writing: the file is opened read-only and nothing is created, so a
 * reader such as `hobo ci provider-health` never competes with the relay, the
 * file's one writer. A file without the table yet has no records.
 */
export function readProviderHealthRecords(
	path: string,
): readonly ProviderHealthRecord[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const table = db
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_health'",
			)
			.get();
		if (!table) return [];
		return db
			.prepare("SELECT body FROM provider_health ORDER BY key")
			.all()
			.map((row) => parseProviderHealthRecord(String(row.body)));
	} finally {
		db.close();
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
 * Whether `outcome` of `job` changes a runner type's record. An outcome, start
 * or miss, older than the newest outcome kept or the trip is a late report (a
 * poller backfill, a job list read newest first): a late start does not clear
 * the record and a late miss does not count towards a trip. While the type is
 * tripped, a miss counts only for a job queued no earlier than the trial let
 * through (`trialStartedAtMs`, else `nextTrialAtMs`); the rest were routed
 * before the trip.
 */
export function countsForProviderHealth(
	health: ProviderHealth,
	job: JobFact,
	outcome: ProviderOutcome,
): boolean {
	const newest = Math.max(
		health.trippedAtMs ?? Number.NEGATIVE_INFINITY,
		...health.outcomes.map((kept) => kept.atMs),
	);
	if (outcome.atMs < newest) return false;
	if (outcome.started) return true;
	if (health.trippedAtMs === undefined) return true;
	const trialFrom = health.trialStartedAtMs ?? health.nextTrialAtMs;
	return trialFrom === undefined || job.queuedAtMs >= trialFrom;
}

/**
 * Record a start or a miss for each hosted label `job` asked for. Labels of
 * GitHub's own runners, machines and the fleet are not provider health. A job
 * still queued inside `missedAfterMs` records nothing yet, and an outcome
 * `countsForProviderHealth` passes over is marked seen but changes nothing.
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
		const health = await store.recordJobOutcome(
			key,
			job.id,
			outcome,
			(current) =>
				countsForProviderHealth(current, job, outcome)
					? recordProviderOutcome(current, outcome, options)
					: undefined,
		);
		if (health) fed.push({ key, outcome, health });
	}
	return fed;
}
