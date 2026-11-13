/**
 * An `SqlExecutor` double for one Postgres backend of a fleet.
 *
 * It answers the statements the fleet's control path sends (the assignment
 * log's read, its one-statement `accept` and the held-entry read, the probe,
 * the watermark and usage reads, the storage size) from in-memory rows kept
 * exactly as Postgres would return them: every column as text, a `text[]` as
 * `{a,b}`, a null as null. Statements it does not model (DDL, transaction
 * control, locks, copies) are recorded and answer no rows. With `up` false
 * every statement fails the way a refused connection does.
 */
import type {
	SqlExecutor,
	SqlParameter,
	SqlResult,
	SqlRow,
	SqlSession,
} from "../src/index.js";

type Stored = {
	epoch: number;
	active: string | null;
	sealed: boolean;
	target: string | null;
	reason: string;
	lossWindowMs: number | null;
	decidedAtMs: number;
	decidedBy: string;
	members: string | null;
};

/** A refused connection, as the `pg` driver reports one. */
class ConnectionRefused extends Error {
	readonly code = "ECONNREFUSED";
	constructor() {
		super("connect ECONNREFUSED");
	}
}

function text(value: SqlParameter | undefined): string | null {
	return value === null || value === undefined ? null : String(value);
}

function number(value: SqlParameter | undefined): number {
	return Number(value);
}

export class FleetSqlDouble implements SqlExecutor {
	readonly log: Stored[] = [];
	readonly statements: string[] = [];
	up = true;
	/** When true, `accept` finds the fleet's lock held by a copy. */
	locked = false;
	/** The standby's snapshot time, when it holds a watermark. */
	snapshotAtMs: number | undefined;

	private row(entry: Stored): SqlRow {
		return {
			epoch: String(entry.epoch),
			active: entry.active,
			sealed: String(entry.sealed),
			target: entry.target,
			reason: entry.reason,
			loss_window_ms:
				entry.lossWindowMs === null ? null : String(entry.lossWindowMs),
			decided_at_ms: String(entry.decidedAtMs),
			decided_by: entry.decidedBy,
			members: entry.members,
		};
	}

	async query(
		sql: string,
		parameters: readonly SqlParameter[] = [],
	): Promise<SqlResult> {
		if (!this.up) throw new ConnectionRefused();
		this.statements.push(sql);
		const statement = sql.replace(/\s+/gu, " ").trim();
		if (statement.startsWith("SELECT 1::text")) return { rows: [{ ok: "1" }] };
		if (statement.startsWith("WITH gate AS")) return this.accept(parameters);
		if (/ORDER BY epoch DESC LIMIT/u.test(statement)) {
			const limit = number(parameters[0]);
			return {
				rows: [...this.log]
					.reverse()
					.slice(0, limit)
					.map((entry) => this.row(entry)),
			};
		}
		if (statement.endsWith("WHERE epoch = $1::bigint")) {
			const held = this.log.find(
				(entry) => entry.epoch === number(parameters[0]),
			);
			return { rows: held === undefined ? [] : [this.row(held)] };
		}
		if (statement.includes("snapshot_at_ms"))
			return {
				rows:
					this.snapshotAtMs === undefined
						? []
						: [
								{
									source: "a",
									source_epoch: "1",
									snapshot_at_ms: String(this.snapshotAtMs),
									row_count: "0",
									byte_count: "0",
									digest: "sha256:0",
									table_name: null,
									table_rows: null,
									table_digest: null,
								},
							],
			};
		if (statement.includes("pg_database_size"))
			return { rows: [{ bytes: "1000" }] };
		return { rows: [] };
	}

	async session<T>(run: (session: SqlSession) => Promise<T>): Promise<T> {
		return run(this);
	}

	private accept(parameters: readonly SqlParameter[]): SqlResult {
		if (this.locked) return { rows: [{ free: "false", inserted: "0" }] };
		const epoch = number(parameters[0]);
		const top = this.log.at(-1)?.epoch ?? 0;
		if (top !== epoch - 1 || this.log.some((entry) => entry.epoch === epoch))
			return { rows: [{ free: "true", inserted: "0" }] };
		const loss = parameters[5];
		this.log.push({
			epoch,
			active: text(parameters[1]),
			sealed: parameters[2] === true,
			target: text(parameters[3]),
			reason: String(parameters[4]),
			lossWindowMs: loss === null || loss === undefined ? null : number(loss),
			decidedAtMs: number(parameters[6]),
			decidedBy: String(parameters[7]),
			members: text(parameters[10]),
		});
		return { rows: [{ free: "true", inserted: "1" }] };
	}
}
