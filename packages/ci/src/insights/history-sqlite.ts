/**
 * Stored run history: an `InsightStore` over `node:sqlite` (ADR-0135), so
 * the insight reports can read run attempts a relay kept rather than asking
 * GitHub each time (ADR-0183).
 *
 * Each run attempt is kept as one `RunFact` (protobuf JSON, checked by
 * `defineRunFact` on the way in and out), keyed by repository, run id and
 * attempt. Ingesting the same attempt again replaces it, so a run whose jobs
 * arrive one webhook at a time is rewritten as it grows. One writer per
 * database: the relay's partition owns it.
 */
import { DatabaseSync } from "node:sqlite";
import { toJsonString } from "@bufbuild/protobuf";
import { z } from "zod";
import { RunFactSchema } from "../_generated/relay_job_pb.js";
import type { InsightRunQuery, InsightStore } from "../runner-order/ports.js";
import {
	insightRunOf,
	parseRunFact,
	runFactOf,
} from "../runner-order/relay-job.js";
import type { InsightRun } from "./types.js";

const FactRow = z.object({ fact: z.string() });

/** Repositories are matched without regard to case, as GitHub names them. */
function repositoryKey(repository: string): string {
	return repository.toLowerCase();
}

export class SqliteInsightStore implements InsightStore {
	/** A store on a database file, or `:memory:`. */
	static open(path: string): SqliteInsightStore {
		return new SqliteInsightStore(new DatabaseSync(path));
	}

	constructor(private readonly db: DatabaseSync) {
		db.exec(`CREATE TABLE IF NOT EXISTS insight_runs (
			repository TEXT NOT NULL,
			run_id INTEGER NOT NULL,
			attempt INTEGER NOT NULL,
			created_at_ms REAL NOT NULL,
			fact TEXT NOT NULL,
			PRIMARY KEY (repository, run_id, attempt)
		);
		CREATE INDEX IF NOT EXISTS insight_runs_created
			ON insight_runs (repository, created_at_ms);`);
	}

	async ingest(run: InsightRun): Promise<void> {
		const fact = runFactOf(run);
		this.db
			.prepare(
				`INSERT INTO insight_runs (repository, run_id, attempt, created_at_ms, fact)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (repository, run_id, attempt)
				DO UPDATE SET created_at_ms = excluded.created_at_ms, fact = excluded.fact`,
			)
			.run(
				repositoryKey(fact.repository),
				fact.id,
				fact.attempt,
				fact.createdAtMs,
				toJsonString(RunFactSchema, fact),
			);
	}

	async runs(query: InsightRunQuery): Promise<readonly InsightRun[]> {
		if (query.limit <= 0) return [];
		return this.db
			.prepare(
				`SELECT fact FROM insight_runs
				WHERE repository = ? AND created_at_ms >= ?
				ORDER BY created_at_ms DESC, run_id DESC, attempt DESC
				LIMIT ?`,
			)
			.all(repositoryKey(query.repository), query.sinceMs, query.limit)
			.map((row) => insightRunOf(parseRunFact(FactRow.parse(row).fact)));
	}

	/** One stored run attempt, or undefined when none is kept. */
	async attempt(
		repository: string,
		id: number,
		attempt: number,
	): Promise<InsightRun | undefined> {
		const row = this.db
			.prepare(
				"SELECT fact FROM insight_runs WHERE repository = ? AND run_id = ? AND attempt = ?",
			)
			.get(repositoryKey(repository), id, attempt);
		if (row === undefined) return undefined;
		return insightRunOf(parseRunFact(FactRow.parse(row).fact));
	}
}
