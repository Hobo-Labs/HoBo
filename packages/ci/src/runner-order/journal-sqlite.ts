/**
 * The route journal on SQLite (ADR-0135, ADR-0183): every relay job a node
 * was asked and every answer it gave, kept for 90 days so "where did this job
 * run, and why" can be read later.
 *
 * It is append-only: an entry is never changed, and the only delete is the
 * retention sweep. A redelivered event (the same relay job's same event type)
 * keeps the first entry, through a unique key, so two deliveries racing
 * through one handle still write one row.
 *
 * It takes the store's existing database handle instead of opening a file, so
 * the journal lives in the store's one partition with its one writer. It
 * never begins a transaction of its own: each write is one statement, and a
 * caller already inside a transaction keeps or discards the entry with it.
 *
 * The clock is passed in; retention is measured against it.
 */
import type { DatabaseSync } from "node:sqlite";
import { clone, toJsonString } from "@bufbuild/protobuf";
import { z } from "zod";
import {
	type RunnerRouteEvent,
	RunnerRouteEventSchema,
} from "../_generated/relay_job_pb.js";
import type { RouteDecisionQuery, RouteJournal } from "./ports.js";
import {
	defineRunnerRouteEvent,
	type ParsedRelayRecord,
	parseRunnerRouteEvent,
} from "./relay-job.js";

// public-contract: how long the route journal keeps an entry (90 days).
export const ROUTE_JOURNAL_RETENTION_MS = 90 * 24 * 60 * 60_000;

export type SqliteRouteJournalOptions = Readonly<{
	/** Epoch milliseconds now; retention is measured against it. Defaults to the system clock. */
	nowMs?: (() => number) | undefined;
	/** How long an entry is kept. Defaults to `ROUTE_JOURNAL_RETENTION_MS`. */
	retentionMs?: number | undefined;
}>;

const BodyRow = z.object({ body: z.string() });
const ChangeCount = z.union([z.number(), z.bigint()]).transform(Number);

const SCHEMA = `CREATE TABLE IF NOT EXISTS route_journal (
  seq INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  job_key TEXT UNIQUE,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS route_journal_account_at ON route_journal(account_id, at_ms);
CREATE INDEX IF NOT EXISTS route_journal_at ON route_journal(at_ms);`;

/** One entry per relay job and event type; an entry with no job id is never a redelivery. */
function jobKey(event: RunnerRouteEvent): string | null {
	return event.jobId === "" ? null : `${event.jobId}\u0000${event.type}`;
}

export class SqliteRouteJournal implements RouteJournal {
	private readonly nowMs: () => number;
	private readonly retentionMs: number;

	constructor(
		private readonly db: DatabaseSync,
		options: SqliteRouteJournalOptions = {},
	) {
		const retentionMs = options.retentionMs ?? ROUTE_JOURNAL_RETENTION_MS;
		if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0)
			throw new RangeError(
				"route journal retention is a positive whole number of milliseconds",
			);
		this.retentionMs = retentionMs;
		this.nowMs = options.nowMs ?? Date.now;
		this.db.exec(SCHEMA);
	}

	/** Entries before this epoch millisecond are past retention. */
	private cutoffMs(): number {
		return this.nowMs() - this.retentionMs;
	}

	/** Delete every entry past retention. Returns how many went. */
	prune(): number {
		const result = this.db
			.prepare("DELETE FROM route_journal WHERE at_ms < ?")
			.run(this.cutoffMs());
		return ChangeCount.parse(result.changes);
	}

	async record(event: RunnerRouteEvent): Promise<void> {
		const parsed = defineRunnerRouteEvent(clone(RunnerRouteEventSchema, event));
		this.prune();
		if (parsed.atMs < this.cutoffMs()) return;
		this.db
			.prepare(
				`INSERT INTO route_journal (account_id, repository, at_ms, job_key, body)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_key) DO NOTHING`,
			)
			.run(
				parsed.accountId,
				(parsed.request?.repository ?? "").toLowerCase(),
				parsed.atMs,
				jobKey(parsed),
				toJsonString(RunnerRouteEventSchema, parsed),
			);
	}

	async decisions(
		query: RouteDecisionQuery,
	): Promise<readonly ParsedRelayRecord<RunnerRouteEvent>[]> {
		if (query.limit <= 0) return [];
		const sinceMs = Math.max(query.sinceMs, this.cutoffMs());
		const repository = query.repository?.toLowerCase() ?? null;
		const rows = this.db
			.prepare(
				`SELECT body FROM route_journal
         WHERE account_id = ? AND at_ms >= ? AND (? IS NULL OR repository = ?)
         ORDER BY at_ms DESC, seq DESC LIMIT ?`,
			)
			.all(
				query.accountId,
				sinceMs,
				repository,
				repository,
				Math.floor(query.limit),
			);
		return rows.map((row) => parseRunnerRouteEvent(BodyRow.parse(row).body));
	}
}
