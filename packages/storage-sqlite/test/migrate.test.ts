import { UnsupportedSchemaVersionError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	assertIntegrity,
	installLegacyV1Fixture,
	migrateToCurrent,
} from "../src/migrate.js";
import { createMemoryNodeSqliteDriver } from "../src/node-driver.js";
import { LEGACY_SCHEMA_VERSION, SCHEMA_VERSION } from "../src/schema.js";

function db() {
	return createMemoryNodeSqliteDriver();
}

function userVersion(driver: ReturnType<typeof db>): number {
	const row = driver.prepare("PRAGMA user_version").get();
	return Number(Object.values(row ?? {})[0] ?? 0);
}

function tableNames(driver: ReturnType<typeof db>): readonly string[] {
	return driver
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
		.all()
		.map((row) => String(row.name));
}

function legacyFixture(
	overrides: {
		readonly events?: Parameters<typeof installLegacyV1Fixture>[1]["events"];
		readonly snapshots?: Parameters<
			typeof installLegacyV1Fixture
		>[1]["snapshots"];
	} = {},
) {
	return {
		events: overrides.events ?? [
			{
				stream_id: "orders-1",
				seq: 1,
				id: "evt-1",
				type: "OrderPlaced",
				ts: "2026-08-20T00:00:00.000Z",
				actor: { kind: "user", id: "u1" },
				tenant: "acme",
				data: { total: 42 },
			},
		],
		...(overrides.snapshots ? { snapshots: overrides.snapshots } : {}),
	};
}

describe("a fresh store", () => {
	it("builds the current schema", () => {
		const driver = db();
		const report = migrateToCurrent(driver);
		expect(report.fromVersion).toBe(0);
		expect(report.toVersion).toBe(SCHEMA_VERSION);
		expect(tableNames(driver)).toContain("streams");
	});

	it("stamps the pragma so the next open is a no-op", () => {
		const driver = db();
		migrateToCurrent(driver);
		expect(userVersion(driver)).toBe(SCHEMA_VERSION);
	});

	it("reports migrating nothing, because there was nothing", () => {
		const report = migrateToCurrent(db());
		expect(report.eventsMigrated).toBe(0);
		expect(report.streamsMigrated).toBe(0);
		expect(report.alreadyCurrent).toBe(false);
	});

	it("does not claim to be already current", () => {
		expect(migrateToCurrent(db()).alreadyCurrent).toBe(false);
	});
});

describe("an already-current store", () => {
	it("does nothing on a second open", () => {
		const driver = db();
		migrateToCurrent(driver);
		const second = migrateToCurrent(driver);
		expect(second.alreadyCurrent).toBe(true);
		expect(second.eventsMigrated).toBe(0);
	});

	it("repairs a v2 store whose pragma lagged, reporting it as a migration", () => {
		const driver = db();
		migrateToCurrent(driver);
		driver.exec("PRAGMA user_version = 0");
		const report = migrateToCurrent(driver);
		expect(report.alreadyCurrent).toBe(false);
		expect(userVersion(driver)).toBe(SCHEMA_VERSION);
	});

	it("does not lose data when it re-runs the schema over existing tables", () => {
		const driver = db();
		installLegacyV1Fixture(driver, legacyFixture());
		migrateToCurrent(driver);
		driver.exec("PRAGMA user_version = 0");
		migrateToCurrent(driver);
		expect(driver.prepare("SELECT id FROM events").all()).toHaveLength(1);
	});

	it("repairs the lagging pragma rather than leaving it", () => {
		const driver = db();
		migrateToCurrent(driver);
		driver.exec("PRAGMA user_version = 0");
		migrateToCurrent(driver);
		expect(userVersion(driver)).toBe(SCHEMA_VERSION);
	});
});

describe("a store from a newer build", () => {
	it("fails closed", () => {
		const driver = db();
		migrateToCurrent(driver);
		driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		expect(() => migrateToCurrent(driver)).toThrow(
			UnsupportedSchemaVersionError,
		);
	});

	it("names both versions so the operator knows what to install", () => {
		const driver = db();
		migrateToCurrent(driver);
		driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
		try {
			migrateToCurrent(driver);
			expect.unreachable("should have refused");
		} catch (error) {
			expect(String(error)).toContain(String(SCHEMA_VERSION + 5));
		}
	});

	it("leaves the store untouched when it refuses", () => {
		const driver = db();
		migrateToCurrent(driver);
		const before = [...tableNames(driver)].sort();
		driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		expect(() => migrateToCurrent(driver)).toThrow();
		expect([...tableNames(driver)].sort()).toEqual(before);
	});
});

describe("migrating a legacy v1 store", () => {
	function legacy(fixture = legacyFixture()) {
		const driver = db();
		installLegacyV1Fixture(driver, fixture);
		return driver;
	}

	it("recognises it by shape, since the pragma was never set", () => {
		const driver = legacy();
		expect(userVersion(driver)).toBe(0);
		const report = migrateToCurrent(driver);
		expect(report.fromVersion).toBe(LEGACY_SCHEMA_VERSION);
		expect(report.eventsMigrated).toBe(1);
	});

	it("carries the events across", () => {
		const driver = legacy();
		migrateToCurrent(driver);
		const rows = driver.prepare("SELECT stream_id, seq FROM events").all();
		expect(rows).toHaveLength(1);
		expect(String(rows[0]?.stream_id)).toBe("orders-1");
	});

	it("counts the streams as well as the events", () => {
		const driver = legacy(
			legacyFixture({
				events: [
					{
						stream_id: "a",
						seq: 1,
						id: "e1",
						type: "T",
						ts: "2026-08-20T00:00:00.000Z",
						actor: {},
						tenant: "t",
						data: {},
					},
					{
						stream_id: "b",
						seq: 1,
						id: "e2",
						type: "T",
						ts: "2026-08-20T00:00:01.000Z",
						actor: {},
						tenant: "t",
						data: {},
					},
				],
			}),
		);
		const report = migrateToCurrent(driver);
		expect(report.eventsMigrated).toBe(2);
		expect(report.streamsMigrated).toBe(2);
	});

	it("drops the legacy table once the data is across", () => {
		const driver = legacy();
		migrateToCurrent(driver);
		expect(tableNames(driver)).not.toContain("events_v1");
		expect(tableNames(driver)).toContain("events");
	});

	it("stamps the pragma so the migration does not run twice", () => {
		const driver = legacy();
		migrateToCurrent(driver);
		expect(userVersion(driver)).toBe(SCHEMA_VERSION);
		expect(migrateToCurrent(driver).alreadyCurrent).toBe(true);
	});

	it("preserves the event payload through the codec change", () => {
		const driver = legacy();
		migrateToCurrent(driver);
		const row = driver
			.prepare("SELECT data FROM events WHERE stream_id = ?")
			.get("orders-1");
		expect(row?.data).toBeDefined();
	});

	it("carries snapshots across too", () => {
		const driver = legacy(
			legacyFixture({
				snapshots: [
					{
						stream_id: "orders-1",
						seq: 1,
						state: { total: 42 },
						saved_at: "2026-08-20T00:00:00.000Z",
					},
				],
			}),
		);
		const report = migrateToCurrent(driver);
		expect(report.snapshotsMigrated).toBe(1);
	});

	it("drops the legacy snapshot table as well", () => {
		const driver = legacy(
			legacyFixture({
				snapshots: [
					{
						stream_id: "orders-1",
						seq: 1,
						state: {},
						saved_at: "2026-08-20T00:00:00.000Z",
					},
				],
			}),
		);
		migrateToCurrent(driver);
		expect(tableNames(driver)).not.toContain("snapshots_v1");
	});

	it("migrates a store with no snapshot table at all", () => {
		const driver = legacy();
		expect(() => migrateToCurrent(driver)).not.toThrow();
	});

	it("orders events deterministically by stream then sequence", () => {
		const driver = legacy(
			legacyFixture({
				events: [
					{
						stream_id: "b",
						seq: 1,
						id: "e-b1",
						type: "T",
						ts: "2026-08-20T00:00:00.000Z",
						actor: {},
						tenant: "t",
						data: {},
					},
					{
						stream_id: "a",
						seq: 2,
						id: "e-a2",
						type: "T",
						ts: "2026-08-20T00:00:00.000Z",
						actor: {},
						tenant: "t",
						data: {},
					},
					{
						stream_id: "a",
						seq: 1,
						id: "e-a1",
						type: "T",
						ts: "2026-08-20T00:00:00.000Z",
						actor: {},
						tenant: "t",
						data: {},
					},
				],
			}),
		);
		migrateToCurrent(driver);
		const ids = driver
			.prepare("SELECT id FROM events ORDER BY global_position ASC")
			.all()
			.map((row) => String(row.id));
		expect(ids).toEqual(["e-a1", "e-a2", "e-b1"]);
	});

	it("keeps a stream's events contiguous from one", () => {
		const driver = legacy(
			legacyFixture({
				events: [
					{
						stream_id: "a",
						seq: 1,
						id: "e1",
						type: "T",
						ts: "2026-08-20T00:00:00.000Z",
						actor: {},
						tenant: "t",
						data: {},
					},
					{
						stream_id: "a",
						seq: 2,
						id: "e2",
						type: "T",
						ts: "2026-08-20T00:00:00.000Z",
						actor: {},
						tenant: "t",
						data: {},
					},
				],
			}),
		);
		migrateToCurrent(driver);
		const seqs = driver
			.prepare("SELECT seq FROM events WHERE stream_id = ? ORDER BY seq")
			.all("a")
			.map((row) => Number(row.seq));
		expect(seqs).toEqual([1, 2]);
	});

	it("preserves the tenant, which scopes every later read", () => {
		const driver = legacy();
		migrateToCurrent(driver);
		const row = driver
			.prepare("SELECT tenant FROM events WHERE id = ?")
			.get("evt-1");
		expect(String(row?.tenant)).toBe("acme");
	});

	it("preserves the event type", () => {
		const driver = legacy();
		migrateToCurrent(driver);
		const row = driver
			.prepare("SELECT type FROM events WHERE id = ?")
			.get("evt-1");
		expect(String(row?.type)).toBe("OrderPlaced");
	});

	it("leaves the migrated store passing an integrity check", () => {
		const driver = legacy();
		migrateToCurrent(driver);
		expect(() => assertIntegrity(driver)).not.toThrow();
	});
});

describe("checking integrity", () => {
	it("passes a healthy store", () => {
		const driver = db();
		migrateToCurrent(driver);
		expect(() => assertIntegrity(driver)).not.toThrow();
	});

	it("passes a store with real data in it", () => {
		const driver = db();
		installLegacyV1Fixture(driver, legacyFixture());
		migrateToCurrent(driver);
		expect(() => assertIntegrity(driver)).not.toThrow();
	});
});

describe("the legacy fixture helper", () => {
	it("leaves user_version at zero, the way the legacy runtime did", () => {
		const driver = db();
		installLegacyV1Fixture(driver, legacyFixture());
		expect(userVersion(driver)).toBe(0);
	});

	it("builds v1 tables rather than v2 ones", () => {
		const driver = db();
		installLegacyV1Fixture(driver, legacyFixture());
		expect(tableNames(driver)).toContain("events");
		expect(tableNames(driver)).not.toContain("streams");
	});

	it("stores the payload as legacy JSON text", () => {
		const driver = db();
		installLegacyV1Fixture(driver, legacyFixture());
		const row = driver
			.prepare("SELECT data FROM events WHERE id = ?")
			.get("evt-1");
		expect(typeof row?.data).toBe("string");
		expect(JSON.parse(String(row?.data))).toEqual({ total: 42 });
	});

	it("defaults the event version and metadata", () => {
		const driver = db();
		installLegacyV1Fixture(driver, legacyFixture());
		const row = driver
			.prepare("SELECT v, meta FROM events WHERE id = ?")
			.get("evt-1");
		expect(Number(row?.v)).toBe(1);
		expect(JSON.parse(String(row?.meta))).toEqual({});
	});
});
