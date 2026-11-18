import { describe, expect, it } from "vitest";

import type { SqliteDriver, SqliteStatement } from "../src/driver.js";
import {
	assertIntegrity,
	createMemoryNodeSqliteDriver,
	installLegacyV1Fixture,
	LEGACY_SCHEMA_VERSION,
	MigrationFailureError,
	migrateToCurrent,
	SCHEMA_VERSION,
	StreamIntegrityError,
} from "../src/index.js";

const NOW = "2026-08-08T00:00:00.000Z";

function legacyEvent(overrides: Record<string, unknown> = {}) {
	return {
		stream_id: "s1",
		seq: 1,
		id: "e1",
		type: "Thing.Happened",
		ts: NOW,
		actor: { kind: "user", id: "u" },
		tenant: "t1",
		data: { a: 1 },
		...overrides,
	} as never;
}

function stubDriver(
	responses: {
		get?: (sql: string) => Record<string, unknown> | undefined;
		all?: (sql: string) => Record<string, unknown>[];
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
			migrateToCurrent(db, { now: NOW });
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

describe("migrateToCurrent — refusals", () => {
	it("fails closed on a store from a newer build", () => {
		const db = createMemoryNodeSqliteDriver();
		try {
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
			try {
				migrateToCurrent(db, { now: NOW });
				expect.unreachable("a newer schema must not be downgraded");
			} catch (error) {
				expect((error as Error).message).toContain(String(SCHEMA_VERSION + 1));
				expect((error as Error).message).toContain(String(SCHEMA_VERSION));
			}
		} finally {
			db.close();
		}
	});

	it("wraps a schema-creation failure and rolls back", () => {
		let rolledBack = false;
		const db: SqliteDriver = {
			...stubDriver({ get: () => undefined }),
			exec: (sql) => {
				if (sql.includes("CREATE TABLE")) throw new Error("disk is full");
			},
			rollback: () => {
				rolledBack = true;
			},
		};
		try {
			migrateToCurrent(db, { now: NOW });
			expect.unreachable("a failed schema creation must be reported");
		} catch (error) {
			expect(error).toBeInstanceOf(MigrationFailureError);
			expect((error as Error).message).toContain("disk is full");
			expect(rolledBack).toBe(true);
		}
	});

	it("reports a non-Error throw as a migration failure too", () => {
		const db: SqliteDriver = {
			...stubDriver({ get: () => undefined }),
			exec: (sql) => {
				if (sql.includes("CREATE TABLE")) throw "just a string";
			},
		};
		expect(() => migrateToCurrent(db, { now: NOW })).toThrowError(
			/just a string/u,
		);
	});

	it("refuses a store it cannot classify, reporting the underlying SQL failure", () => {
		const db = createMemoryNodeSqliteDriver();
		try {
			db.exec(
				"CREATE TABLE events (id TEXT, payload_codec TEXT, global_position INTEGER)",
			);
			expect(() => migrateToCurrent(db, { now: NOW })).toThrowError(
				MigrationFailureError,
			);
			expect(() => migrateToCurrent(db, { now: NOW })).toThrowError(
				/no such column/u,
			);
		} finally {
			db.close();
		}
	});
});

describe("legacy migration — integrity refusals", () => {
	function legacyStore(fixture: Parameters<typeof installLegacyV1Fixture>[1]) {
		const db = createMemoryNodeSqliteDriver();
		installLegacyV1Fixture(db, fixture);
		return db;
	}

	it("refuses a stream whose sequence numbers have a gap", () => {
		const db = legacyStore({
			events: [
				legacyEvent({ seq: 1, id: "e1" }),
				legacyEvent({ seq: 3, id: "e3" }),
			],
		});
		try {
			migrateToCurrent(db, { now: NOW });
			expect.unreachable("a gap in a stream must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(StreamIntegrityError);
			expect((error as Error).message).toMatch(/noncontiguous stream s1/u);
			expect((error as Error).message).toMatch(/expected seq 2, found 3/u);
		} finally {
			db.close();
		}
	});

	it("refuses a stream that does not start at one", () => {
		const db = legacyStore({
			events: [legacyEvent({ seq: 2, id: "e2" })],
		});
		try {
			expect(() => migrateToCurrent(db, { now: NOW })).toThrowError(
				/expected seq 1, found 2/u,
			);
		} finally {
			db.close();
		}
	});

	it("refuses a snapshot that is ahead of its stream", () => {
		const db = legacyStore({
			events: [legacyEvent({ seq: 1, id: "e1" })],
			snapshots: [{ stream_id: "s1", seq: 5, state: { a: 1 }, saved_at: NOW }],
		});
		try {
			migrateToCurrent(db, { now: NOW });
			expect.unreachable("a snapshot ahead of its stream must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(StreamIntegrityError);
			expect((error as Error).message).toMatch(/snapshot ahead of stream s1/u);
			expect((error as Error).message).toMatch(/snapshot seq 5 > head 1/u);
		} finally {
			db.close();
		}
	});

	it("accepts a snapshot exactly at the head", () => {
		const db = legacyStore({
			events: [legacyEvent({ seq: 1, id: "e1" })],
			snapshots: [{ stream_id: "s1", seq: 1, state: { a: 1 }, saved_at: NOW }],
		});
		try {
			const report = migrateToCurrent(db, { now: NOW });
			expect(report.snapshotsMigrated).toBe(1);
		} finally {
			db.close();
		}
	});

	it("refuses a snapshot for a stream that has no events at all", () => {
		const db = legacyStore({
			events: [legacyEvent({ stream_id: "s1", seq: 1, id: "e1" })],
			snapshots: [
				{ stream_id: "orphan", seq: 1, state: { a: 1 }, saved_at: NOW },
			],
		});
		try {
			expect(() => migrateToCurrent(db, { now: NOW })).toThrowError(
				/snapshot ahead of stream orphan/u,
			);
		} finally {
			db.close();
		}
	});

	it("leaves the legacy data in place when it refuses", () => {
		const db = legacyStore({
			events: [
				legacyEvent({ seq: 1, id: "e1" }),
				legacyEvent({ seq: 3, id: "e3" }),
			],
		});
		try {
			expect(() => migrateToCurrent(db, { now: NOW })).toThrow();
			const remaining = db.prepare("SELECT COUNT(*) AS n FROM events").get();
			expect(Number(remaining?.n)).toBe(2);
		} finally {
			db.close();
		}
	});

	it("re-throws an integrity refusal unwrapped", () => {
		const db = legacyStore({
			events: [legacyEvent({ seq: 2, id: "e2" })],
		});
		try {
			migrateToCurrent(db, { now: NOW });
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(StreamIntegrityError);
			expect(error).not.toBeInstanceOf(MigrationFailureError);
			expect((error as { code?: string }).code).toBe("STREAM_INTEGRITY");
		} finally {
			db.close();
		}
	});
});

describe("legacy detection by shape", () => {
	it("does not treat a v2 events table as legacy", () => {
		const db = createMemoryNodeSqliteDriver();
		try {
			migrateToCurrent(db, { now: NOW });
			const second = migrateToCurrent(db, { now: NOW });
			expect(second.alreadyCurrent).toBe(true);
			expect(second.eventsMigrated).toBe(0);
		} finally {
			db.close();
		}
	});

	it("treats a table with a data column but no v2 columns as legacy", () => {
		const db = createMemoryNodeSqliteDriver();
		installLegacyV1Fixture(db, { events: [legacyEvent()] });
		try {
			const report = migrateToCurrent(db, { now: NOW });
			expect(report.alreadyCurrent).toBe(false);
			expect(report.eventsMigrated).toBe(1);
			expect(report.streamsMigrated).toBe(1);
			expect(report.fromVersion).toBe(LEGACY_SCHEMA_VERSION);
			expect(report.toVersion).toBe(SCHEMA_VERSION);
		} finally {
			db.close();
		}
	});

	it("migrates several streams and counts each once", () => {
		const db = createMemoryNodeSqliteDriver();
		installLegacyV1Fixture(db, {
			events: [
				legacyEvent({ stream_id: "s1", seq: 1, id: "a1" }),
				legacyEvent({ stream_id: "s1", seq: 2, id: "a2" }),
				legacyEvent({ stream_id: "s2", seq: 1, id: "b1" }),
			],
		});
		try {
			const report = migrateToCurrent(db, { now: NOW });
			expect(report.streamsMigrated).toBe(2);
			expect(report.eventsMigrated).toBe(3);
			expect(() => assertIntegrity(db)).not.toThrow();
		} finally {
			db.close();
		}
	});
});
