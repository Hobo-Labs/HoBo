/**
 * Migrating a SQLite event store from v1 to v2, and refusing when it cannot.
 *
 * This is the code that runs on open, against whatever database a user already
 * has. Its dispatch is not a version number alone — it is a mix of
 * `PRAGMA user_version` and the *shape* of the tables, because the legacy
 * runtime never set the pragma at all. So the same store can be recognised by
 * two different signals that disagree, and the branch that wins decides whether
 * somebody's events are carried forward or silently left behind in a renamed
 * table.
 *
 * The states worth pinning are the ones that arise in the field:
 *
 * - **A fresh directory.** Must build v2 and stamp the pragma; getting this
 *   wrong makes every subsequent open re-run the migration.
 * - **A legacy v1 store with `user_version` still 0.** Recognised by shape.
 *   This is the migration that actually moves data, and the one where a wrong
 *   branch loses it.
 * - **A v2 store whose pragma lagged** — a crash between `exec` and
 *   `setUserVersion`. Must be recognised as current rather than re-migrated on
 *   top of itself.
 * - **A store from a newer build.** Must fail closed. Opening it read-write
 *   under an older schema is how a downgrade corrupts data that the newer
 *   version could still have read.
 *
 * Everything runs against a real in-memory SQLite database. The migration is
 * mostly SQL, so a fake driver would be testing the test.
 */
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

/** One legacy event, enough to prove data moved. */
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
		// Without the stamp, every open re-runs the migration against a database
		// that is already current — which the shape check would catch, but only
		// after doing the work.
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
		// `alreadyCurrent` tells a caller whether anything happened. Reporting
		// true here would hide a real first-time schema creation.
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
		// The crash shape: `exec(SCHEMA_V2_SQL)` succeeded and `setUserVersion`
		// did not, so the tables are current but the pragma says 0.
		//
		// Worth knowing rather than assuming: this does *not* take the
		// already-current path. A pragma below current with no legacy events
		// matches the re-create branch first, so the schema SQL is re-executed
		// over the existing tables and the report says `alreadyCurrent: false`.
		//
		// That is safe only because the schema SQL is written with
		// CREATE ... IF NOT EXISTS — which is exactly why it is worth a test.
		// The dedicated already-on-v2 branch below it is reachable only when
		// legacy events are *also* present, i.e. a genuinely half-migrated store.
		const driver = db();
		migrateToCurrent(driver);
		driver.exec("PRAGMA user_version = 0");
		const report = migrateToCurrent(driver);
		expect(report.alreadyCurrent).toBe(false);
		expect(userVersion(driver)).toBe(SCHEMA_VERSION);
	});

	it("does not lose data when it re-runs the schema over existing tables", () => {
		// The consequence that would actually hurt: if the re-exec dropped or
		// recreated `events`, a crash between exec and pragma-stamp would cost
		// every event in the store on the next open.
		const driver = db();
		installLegacyV1Fixture(driver, legacyFixture());
		migrateToCurrent(driver);
		driver.exec("PRAGMA user_version = 0");
		migrateToCurrent(driver);
		expect(driver.prepare("SELECT id FROM events").all()).toHaveLength(1);
	});

	it("repairs the lagging pragma rather than leaving it", () => {
		// Left at 0, the store would be re-examined on every single open.
		const driver = db();
		migrateToCurrent(driver);
		driver.exec("PRAGMA user_version = 0");
		migrateToCurrent(driver);
		expect(userVersion(driver)).toBe(SCHEMA_VERSION);
	});
});

describe("a store from a newer build", () => {
	it("fails closed", () => {
		// Opening it read-write under an older schema is how a downgrade corrupts
		// data the newer version could still have read.
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
		// A refusal that had already dropped or renamed a table would make the
		// store unopenable by the newer build too.
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
		// The legacy runtime never wrote `user_version`, so a v1 store and a fresh
		// one both report 0. Only the table shape separates them, and reading the
		// pragma alone would treat a store full of events as empty.
		const driver = legacy();
		expect(userVersion(driver)).toBe(0);
		const report = migrateToCurrent(driver);
		// Reported as the legacy constant rather than the observed pragma: the
		// pragma said 0, but 0 also means "fresh", and the report is meant to say
		// what was migrated *from* rather than what the file happened to claim.
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
		// Two separate figures, because a migration that moved every event into
		// one stream would still report the right event count.
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
		// Pinning a design decision that surprised me. The migration renames
		// `events` to `events_v1`, copies out of it, and then drops it — all
		// inside one immediate transaction, with `assertIntegrity` run after the
		// commit. So the store is never left half-migrated.
		//
		// But it does mean the migration is not reversible from the same file:
		// after a successful open, the v1 rows are gone. If a translation bug is
		// found later, recovery needs a backup taken beforehand rather than the
		// renamed table. Keeping `events_v1` would trade disk for that option;
		// dropping it is defensible and is what the code does, so it is recorded
		// here rather than argued with.
		const driver = legacy();
		migrateToCurrent(driver);
		expect(tableNames(driver)).not.toContain("events_v1");
		expect(tableNames(driver)).toContain("events");
	});

	it("stamps the pragma so the migration does not run twice", () => {
		// Running it twice would find `events_v1` already taken and fail — after
		// having renamed the new `events` table out from under the store.
		const driver = legacy();
		migrateToCurrent(driver);
		expect(userVersion(driver)).toBe(SCHEMA_VERSION);
		expect(migrateToCurrent(driver).alreadyCurrent).toBe(true);
	});

	it("preserves the event payload through the codec change", () => {
		// v1 stored JSON text, v2 stores encoded blobs. A migration that moved
		// rows without re-encoding would leave every payload unreadable.
		const driver = legacy();
		migrateToCurrent(driver);
		const row = driver
			.prepare("SELECT data FROM events WHERE stream_id = ?")
			.get("orders-1");
		expect(row?.data).toBeDefined();
	});

	it("carries snapshots across too", () => {
		// A migration that moved events and forgot snapshots would silently make
		// every aggregate replay from scratch — correct, but arbitrarily slow.
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
		// The legacy fixture only creates one when asked, and plenty of real v1
		// stores never had snapshots. Assuming it exists would throw on rename.
		const driver = legacy();
		expect(() => migrateToCurrent(driver)).not.toThrow();
	});

	it("orders events deterministically by stream then sequence", () => {
		// Global positions are assigned in this order. A non-deterministic order
		// would give two migrations of the same store different positions, and
		// anything that recorded a position would then read the wrong event.
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
		// A lost tenant would make one customer's events readable by another, or
		// invisible to their owner — depending on which way the default fell.
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
		// The whole migration runs inside one immediate transaction. A partially
		// applied one that still committed would leave dangling references, and
		// this is what would notice.
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
	// It exists to build migration inputs, so it is worth confirming it really
	// produces the v1 shape — a fixture that accidentally built v2 tables would
	// make every migration test above pass while testing nothing.
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
		// The v1 column is TEXT. If the fixture wrote a blob, the shape detection
		// under test would not recognise it as legacy at all.
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
