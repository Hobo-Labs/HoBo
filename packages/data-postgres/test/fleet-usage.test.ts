import { billingPeriod, parseFleetAssignment } from "@hobo/backend-fleet";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sqlAssignmentReplica } from "../src/fleet/assignment.js";
import { ensureFleetControlTables } from "../src/fleet/control.js";
import { parseFleetLayout } from "../src/fleet/layout.js";
import type {
	FleetBackend,
	SqlExecutor,
	SqlParameter,
	SqlRow,
	SqlSession,
} from "../src/fleet/sql.js";
import { readUsage, recordUsage } from "../src/fleet/usage.js";

const layout = parseFleetLayout({
	dataPrefix: "usage_data_",
	controlPrefix: `usage_test_${process.pid}_`,
});
const november = Date.UTC(2026, 10, 30, 23, 59, 59);
const december = Date.UTC(2026, 11, 1);
const url = process.env.HOBO_TEST_POSTGRES_URL;

function executor(pool: Pool): SqlExecutor {
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

function intercept(
	base: SqlExecutor,
	handler: (
		session: SqlSession,
		sql: string,
		parameters?: readonly SqlParameter[],
	) => ReturnType<SqlSession["query"]>,
): SqlExecutor {
	return {
		query: base.query,
		session: (run) =>
			base.session((session) =>
				run({ query: (sql, parameters) => handler(session, sql, parameters) }),
			),
	};
}

describe("usage observations", () => {
	it("names representable UTC billing months", () => {
		expect(billingPeriod(december).id).toBe("2026-12");
		expect(() => billingPeriod(Date.UTC(10000, 0, 1))).toThrow();
	});

	it("rejects invalid observations before opening a transaction", async () => {
		const unavailable: SqlExecutor = {
			async query() {
				throw new Error("unexpected query");
			},
			async session() {
				throw new Error("unexpected transaction");
			},
		};
		const backend = { id: "a", executor: unavailable };
		for (const observation of [
			{ observationId: "", observedAtMs: november, statements: 1 },
			{ observationId: "bad id", observedAtMs: november, statements: 1 },
			{ observationId: "valid", observedAtMs: november, statements: -1 },
			{
				observationId: "valid",
				observedAtMs: Number.MAX_SAFE_INTEGER,
				statements: 1,
			},
		]) {
			await expect(
				recordUsage(backend, layout, observation),
			).rejects.not.toThrow("unexpected transaction");
		}
	});
});

describe.skipIf(!url)("PostgreSQL fleet control and usage", () => {
	let pool: Pool;
	let backend: FleetBackend;

	beforeAll(async () => {
		pool = new Pool({ connectionString: url, max: 20 });
		backend = { id: "a", executor: executor(pool) };
		await ensureFleetControlTables(backend, layout);
	});
	beforeEach(async () => {
		await pool.query(
			`TRUNCATE ${layout.usageObservationsTable}, ${layout.usageTable}, ${layout.assignmentTable}`,
		);
	});

	it("initializes the current assignment constraints and reuses them", async () => {
		await ensureFleetControlTables(backend, layout);
		await pool.query(
			`INSERT INTO ${layout.assignmentTable} VALUES (1, NULL, false, NULL, 'paused', NULL, now(), 'test')`,
		);
		await expect(
			pool.query(
				`INSERT INTO ${layout.assignmentTable} VALUES (2, 'a', true, 'a', 'invalid', NULL, now(), 'test')`,
			),
		).rejects.toMatchObject({ code: "23514" });
	});

	it("stores and reads assignment records through the shared replica contract", async () => {
		const replica = sqlAssignmentReplica(backend, layout);
		const first = parseFleetAssignment({
			epoch: 1,
			active: "a",
			sealed: false,
			target: undefined,
			reason: "bootstrap",
			lossWindowMs: undefined,
			decidedAtMs: november,
			decidedBy: "test",
		});
		const second = { ...first, epoch: 2, reason: "steady" };
		expect(await replica.accept(first)).toBe("accepted");
		expect(await replica.accept(first)).toBe("duplicate");
		expect(await replica.accept({ ...first, reason: "conflict" })).toBe(
			"conflict",
		);
		expect(await replica.accept({ ...second, epoch: 3 })).toBe("gap");
		expect(await replica.accept(second)).toBe("accepted");
		expect(await replica.read()).toEqual([first, second]);
	});

	it("refuses incompatible assignment constraints without rewriting them", async () => {
		const incompatible = parseFleetLayout({
			dataPrefix: "other_data_",
			controlPrefix: `usage_bad_${process.pid}_`,
		});
		try {
			await pool.query(
				`CREATE TABLE ${incompatible.assignmentTable} (epoch bigint PRIMARY KEY CHECK (epoch >= 1))`,
			);
			const before = await pool.query(
				"SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = to_regclass($1) ORDER BY definition",
				[incompatible.assignmentTable],
			);
			await expect(
				ensureFleetControlTables(backend, incompatible),
			).rejects.toMatchObject({
				code: "FLEET_CONFIGURATION_INVALID",
			});
			const after = await pool.query(
				"SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = to_regclass($1) ORDER BY definition",
				[incompatible.assignmentTable],
			);
			expect(after.rows).toEqual(before.rows);
			const watermark = await pool.query("SELECT to_regclass($1) AS name", [
				incompatible.watermarkTable,
			]);
			expect(watermark.rows[0]?.name).toBeNull();
		} finally {
			await pool.query(`DROP TABLE IF EXISTS ${incompatible.assignmentTable}`);
		}
	});
	afterAll(async () => {
		if (!pool) return;
		await pool.query(
			`DROP TABLE IF EXISTS ${layout.usageObservationsTable}, ${layout.usageTable}, ${layout.watermarkTable}, ${layout.assignmentTable}`,
		);
		await pool.end();
	});

	it("records each observed month and refuses an id reused with different data", async () => {
		const first = {
			observationId: "november.1",
			observedAtMs: november,
			statements: 3,
		};
		expect(await recordUsage(backend, layout, first)).toBe("recorded");
		expect(await recordUsage(backend, layout, first)).toBe("duplicate");
		await expect(
			recordUsage(backend, layout, { ...first, statements: 4 }),
		).rejects.toThrow("reused with different data");
		await expect(
			recordUsage(backend, layout, { ...first, observedAtMs: november - 1 }),
		).rejects.toThrow("reused with different data");
		await recordUsage(backend, layout, {
			observationId: "december.1",
			observedAtMs: december,
			statements: 5,
		});
		expect(await readUsage(backend, layout, "2026-11")).toEqual([
			{ period: "2026-11", unit: "operations", used: 3 },
		]);
		expect(await readUsage(backend, layout, "2026-12")).toEqual([
			{ period: "2026-12", unit: "operations", used: 5 },
		]);
	});

	it("counts concurrent retries of the same observation once", async () => {
		const observation = {
			observationId: "concurrent",
			observedAtMs: november,
			statements: 7,
		};
		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				recordUsage(backend, layout, observation),
			),
		);
		expect(results.filter((result) => result === "recorded")).toHaveLength(1);
		expect(results.filter((result) => result === "duplicate")).toHaveLength(9);
		expect((await readUsage(backend, layout, "2026-11"))[0]?.used).toBe(7);
	});

	it("retains observations across a fresh database connection", async () => {
		const observation = {
			observationId: "restart",
			observedAtMs: november,
			statements: 4,
		};
		await recordUsage(backend, layout, observation);
		const reopened = new Pool({ connectionString: url });
		try {
			const second = { id: "a", executor: executor(reopened) };
			expect((await readUsage(second, layout, "2026-11"))[0]?.used).toBe(4);
			expect(await recordUsage(second, layout, observation)).toBe("duplicate");
		} finally {
			await reopened.end();
		}
	});

	it("deduplicates a retry after the commit succeeded but its acknowledgement was lost", async () => {
		let loseAcknowledgement = true;
		const uncertain = intercept(
			backend.executor,
			async (session, sql, parameters) => {
				const result = await session.query(sql, parameters);
				if (sql === "COMMIT" && loseAcknowledgement) {
					loseAcknowledgement = false;
					throw new Error("commit acknowledgement lost");
				}
				return result;
			},
		);
		const observation = {
			observationId: "uncertain",
			observedAtMs: november,
			statements: 11,
		};
		await expect(
			recordUsage({ ...backend, executor: uncertain }, layout, observation),
		).rejects.toThrow("acknowledgement lost");
		expect(await recordUsage(backend, layout, observation)).toBe("duplicate");
		expect((await readUsage(backend, layout, "2026-11"))[0]?.used).toBe(11);
	});

	it("rolls back the observation when its total cannot be updated", async () => {
		let failUpdate = true;
		const failing = intercept(
			backend.executor,
			async (session, sql, parameters) => {
				if (sql.includes(`INSERT INTO ${layout.usageTable} (`) && failUpdate) {
					failUpdate = false;
					throw new Error("injected aggregate failure");
				}
				return session.query(sql, parameters);
			},
		);
		const observation = {
			observationId: "retry",
			observedAtMs: november,
			statements: 2,
		};
		await expect(
			recordUsage({ ...backend, executor: failing }, layout, observation),
		).rejects.toThrow("aggregate failure");
		expect(await readUsage(backend, layout, "2026-11")).toEqual([]);
		expect(await recordUsage(backend, layout, observation)).toBe("recorded");
	});

	it("rejects aggregate overflow without retaining the failed observation", async () => {
		await recordUsage(backend, layout, {
			observationId: "max",
			observedAtMs: november,
			statements: Number.MAX_SAFE_INTEGER,
		});
		const overflow = {
			observationId: "overflow",
			observedAtMs: november,
			statements: 1,
		};
		await expect(recordUsage(backend, layout, overflow)).rejects.toThrow(
			"safe integer range",
		);
		expect(
			await recordUsage(backend, layout, { ...overflow, statements: 0 }),
		).toBe("recorded");
		expect((await readUsage(backend, layout, "2026-11"))[0]?.used).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	});
});
