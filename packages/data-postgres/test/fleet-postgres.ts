import type { Pool } from "pg";
import type { SqlExecutor, SqlRow, SqlSession } from "../src/fleet/sql.js";

export function fleetTestExecutor(pool: Pool): SqlExecutor {
	return {
		async query(sql, parameters) {
			const result = await pool.query<SqlRow>(
				sql,
				parameters ? [...parameters] : [],
			);
			return { rows: result.rows };
		},
		async session<T>(run: (session: SqlSession) => Promise<T>): Promise<T> {
			const client = await pool.connect();
			let discard = false;
			try {
				return await run({
					async query(sql, parameters) {
						const result = await client.query<SqlRow>(
							sql,
							parameters ? [...parameters] : [],
						);
						return { rows: result.rows };
					},
				});
			} catch (error) {
				discard = true;
				throw error;
			} finally {
				client.release(discard);
			}
		},
	};
}
