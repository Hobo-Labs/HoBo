import { describe, expect, it } from "vitest";
import type { SqliteDriver, SqliteRow, SqliteStatement } from "../src/driver.js";
import {
	assertIntegrity,
	createMemoryNodeSqliteDriver,
	initializeJournalSchema,
} from "../src/index.js";

function stubDriver(
	responses: {
		get?: (sql: string) => SqliteRow | undefined;
		all?: (sql: string) => SqliteRow[];
		onExec?: (sql: string) => void;
	} = {},
): SqliteDriver {
	const statement = (sql: string): SqliteStatement => ({
		run: () => ({ changes: 0, lastInsertRowid: 0 }),
		get: () => responses.get?.(sql),
		all: () => responses.all?.(sql) ?? [],
	});
	return {
		kind: "test",
		exec: (sql) => responses.onExec?.(sql),
		prepare: statement,
		beginImmediate: () => undefined,
		commit: () => undefined,
		rollback: () => undefined,
		pragma: () => null,
		close: () => undefined,
	};
}

describe("assertIntegrity", () => {
	it("passes a healthy database", () => {
		const db = createMemoryNodeSqliteDriver();
		try {
			initializeJournalSchema(db);
			expect(() => assertIntegrity(db)).not.toThrow();
		} finally {
			db.close();
		}
	});

	it("refuses when integrity_check reports anything but ok", () => {
		const db = stubDriver({
			get: (sql) =>
				sql.includes("integrity_check")
					? { integrity_check: "*** in database main *** page 3 is never used" }
					: undefined,
		});
		try {
			assertIntegrity(db);
			expect.unreachable("a corrupt database must be refused");
		} catch (error) {
			expect((error as { code?: string }).code).toBe("INTEGRITY_FAILURE");
			expect((error as Error).message).toContain("page 3 is never used");
		}
	});

	it("refuses when integrity_check returns no row at all", () => {
		const db = stubDriver({ get: () => undefined });
		expect(() => assertIntegrity(db)).toThrowError(/integrity_check failed/u);
	});

	it("refuses when foreign_key_check finds violations, and counts them", () => {
		const db = stubDriver({
			get: (sql) =>
				sql.includes("integrity_check") ? { integrity_check: "ok" } : undefined,
			all: (sql) =>
				sql.includes("foreign_key_check")
					? [{ table: "events" }, { table: "snapshots" }]
					: [],
		});
		try {
			assertIntegrity(db);
			expect.unreachable("dangling foreign keys must be refused");
		} catch (error) {
			expect((error as Error).message).toMatch(/found 2 violation\(s\)/u);
		}
	});

	it("runs the foreign key check even when integrity passes", () => {
		const seen: string[] = [];
		const db = stubDriver({
			get: (sql) => {
				seen.push(sql);
				return sql.includes("integrity_check")
					? { integrity_check: "ok" }
					: undefined;
			},
			all: (sql) => {
				seen.push(sql);
				return [];
			},
		});
		assertIntegrity(db);
		expect(seen.some((sql) => sql.includes("foreign_key_check"))).toBe(true);
	});
});
