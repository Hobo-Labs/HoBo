import pg from "pg";
import { describe, expect, it } from "vitest";
import { initializeHostedRelaySchema } from "../src/hosted-schema.js";

describe("hosted relay schema", () => {
	it("creates every GitHub store's tables and stores nothing", async () => {
		const statements: string[] = [];
		const query = async (sql: string) => {
			statements.push(sql);
			return { rows: [], rowCount: 0 };
		};
		// A real pool object that never connects: both ways a store reaches the
		// database are replaced by a recorder.
		const pool = Object.assign(new pg.Pool({ max: 1 }), {
			query,
			connect: async () => ({ query, release() {} }),
		});
		await initializeHostedRelaySchema(pool);
		const created = statements
			.map((sql) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql)?.[1])
			.filter(Boolean);
		expect(created).toEqual([
			"hobo_ci_app_states",
			"hobo_ci_app_credentials",
			"hobo_ci_app_installations",
			"hobo_ci_oauth_states",
			"hobo_ci_oauth_sessions",
			"hobo_ci_platform_app",
			"hobo_ci_platform_app_attempts",
			"hobo_ci_platform_app_invitations",
			"hobo_ci_webhook_repairs",
			"hobo_ci_webhook_scan_cursors",
			"hobo_ci_webhook_successes",
			"hobo_ci_queued_scans",
			"hobo_ci_queued_api_budget",
		]);
		expect(
			statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),
		).toEqual([]);
	});
});
