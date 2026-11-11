import {
	type PostgresConformanceExecutor,
	type PostgresConformanceReport,
	type PostgresStructuredCapabilities,
	runPostgresConformance,
} from "@hobo/data-postgres";
import type { PgPool } from "./database-fleet-executor.js";

/** What the relay needs of a backend, stated in HoBo's own vocabulary. TLS and
 * the binding checks are advertised by the caller when the connection has
 * them; a local test server has neither. */
export const RELAY_BACKEND_REQUIREMENTS: PostgresStructuredCapabilities = {
	postgresWireProtocol: true,
	ddl: true,
	constraints: true,
	transactions: true,
	transactionRollback: true,
	isolationLevels: ["repeatable-read", "serializable"],
	preparedStatements: true,
	jsonDocuments: true,
	jsonb: true,
};

/** The `sql` executor of `conformance.data.postgres/v1` over a `pg` pool: the
 * case's statements, verbatim, on one session. Tables a case leaves behind
 * are dropped. */
export function conformanceSqlExecutor(
	pool: PgPool,
): PostgresConformanceExecutor {
	return async ({ check, capabilityKey, advertised }) => {
		if (check.kind !== "sql")
			return { passed: false, detail: "not an SQL check" };
		const client = await pool.connect();
		let failedAt: number | undefined;
		let version: string | undefined;
		try {
			for (const [index, statement] of check.statements.entries()) {
				try {
					const result = await client.query(statement);
					version = result.rows[0]?.server_version_num ?? version;
				} catch {
					failedAt = index;
					break;
				}
			}
		} finally {
			try {
				await client.query("ROLLBACK");
				await client.query(
					"DROP TABLE IF EXISTS hobo_conformance_ddl, hobo_conformance_constraint, hobo_conformance_tx, hobo_conformance_rollback",
				);
			} finally {
				// The session may hold a prepared statement or a failed transaction.
				client.release(true);
			}
		}
		const last = check.statements.length - 1;
		if (check.expect === "last-fails")
			return failedAt === last
				? { passed: true, detail: "the last statement was refused" }
				: { passed: false, detail: `statement ${failedAt ?? last} outcome` };
		if (failedAt !== undefined)
			return { passed: false, detail: `statement ${failedAt} failed` };
		if (capabilityKey === "serverVersionMajor") {
			const major = Math.floor(Number(version) / 10_000);
			return major === advertised.serverVersionMajor
				? { passed: true, detail: `server major version ${major}` }
				: { passed: false, detail: `server major version ${major}` };
		}
		return { passed: true, detail: "every statement succeeded" };
	};
}

/** Run HoBo's PostgreSQL conformance suite against one backend. */
export function qualifyBackend(
	pool: PgPool,
	advertised: PostgresStructuredCapabilities,
	nowMs: number,
): Promise<PostgresConformanceReport> {
	return runPostgresConformance({
		advertised,
		executors: { sql: conformanceSqlExecutor(pool) },
		nowMs,
	});
}
