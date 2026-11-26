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

export const ROUTE_JOURNAL_RETENTION_MS = 90 * 24 * 60 * 60_000;

export type SqliteRouteJournalOptions = Readonly<{
	nowMs?: (() => number) | undefined;
	retentionMs?: number | undefined;
}>;

const BodyRow = z.object({ body: z.string() });
const ChangeCount = z.union([z.number(), z.bigint()]).transform(Number);

const SCHEMA = `CREATE TABLE IF NOT EXISTS route_journal (
  seq INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  job_id TEXT,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE (account_id, job_id, type)
);
CREATE INDEX IF NOT EXISTS route_journal_account_at ON route_journal(account_id, at_ms);
CREATE INDEX IF NOT EXISTS route_journal_at ON route_journal(at_ms);`;

function jobId(event: RunnerRouteEvent): string | null {
	return event.jobId === "" ? null : event.jobId;
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

	private cutoffMs(): number {
		return this.nowMs() - this.retentionMs;
	}

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
				`INSERT INTO route_journal (account_id, repository, at_ms, job_id, type, body)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, job_id, type) DO NOTHING`,
			)
			.run(
				parsed.accountId,
				(parsed.request?.repository ?? "").toLowerCase(),
				parsed.atMs,
				jobId(parsed),
				parsed.type,
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
