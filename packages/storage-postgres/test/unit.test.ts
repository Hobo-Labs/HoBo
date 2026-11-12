import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OptimisticSequenceConflictError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createPostgresEventStore,
	eventIdFor,
	isRetryableTransactionError,
	MIGRATIONS,
	migrateSchema,
	migrationChecksum,
	notifyChannel,
	type PgClientLike,
	type PgParam,
	POSTGRES_STORE_DEFAULTS,
	parsePostgresStoreConfig,
	parseSchemaName,
	postgresStoreConfigFromEnv,
	remediationFor,
	SCHEMA_VERSION,
	StoragePostgresError,
	StoragePostgresErrorCode,
	serverMajorVersion,
	storagePostgresErrorCode,
	translatePgError,
} from "../src/index.js";
import { planLane } from "./support/postgres-lane.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("configuration (parse, don't validate)", () => {
	it("fills every default and mirrors the CD_DEFAULTS Postgres values", () => {
		const config = parsePostgresStoreConfig({
			connectionString: "postgresql://h/db",
		});
		expect(config).toEqual({
			connectionString: "postgresql://h/db",
			schema: "hobo_eventstore",
			partitionId: "default",
			poolSize: 10,
			statementTimeoutMs: 5_000,
			connectionTimeoutMs: 5_000,
			minServerMajorVersion: 16,
			leaseTtlMs: 30_000,
			applicationName: "hobo-storage-postgres",
		});
		expect(Object.isFrozen(config)).toBe(true);
		// Parity with packages/cd/src/events.ts CD_DEFAULTS (frozen, plan 0024 A.6).
		const events = readFileSync(join(here, "../../cd/src/events.ts"), "utf8");
		expect(events).toContain(
			`postgresMinMajorVersion: ${POSTGRES_STORE_DEFAULTS.minServerMajorVersion},`,
		);
		expect(events).toContain("postgresStatementTimeoutMs: 5_000,");
		expect(events).toContain(
			`postgresPoolSize: ${POSTGRES_STORE_DEFAULTS.poolSize},`,
		);
		expect(events).toContain("leaseTtlMs: 30_000,");
	});

	it("accepts snake_case proto JSON and is idempotent on an already-parsed config", () => {
		const config = parsePostgresStoreConfig({
			connection_string: "u",
			pool_size: 3,
			schema: "cd_store",
		});
		expect(config).toMatchObject({ poolSize: 3, schema: "cd_store" });
		expect(parsePostgresStoreConfig(config)).toEqual(config);
	});

	it.each([
		[{ poolSize: 0.5 }, "invalid"],
		[{ poolSize: 101 }, "poolSize"],
		[{ statementTimeoutMs: 50 }, "statementTimeoutMs"],
		[{ minServerMajorVersion: 15 }, "minServerMajorVersion"],
		[{ leaseTtlMs: 999 }, "leaseTtlMs"],
		[{ schema: "Bad-Name" }, "schema"],
		[{ schema: "public" }, "reserved"],
		[{ schema: "pg_catalog" }, "reserved"],
		[{ applicationName: "has space" }, "applicationName"],
		[{ surprise: true }, "invalid"],
	])("refuses %j with invalid-config", (input, fragment) => {
		let caught: unknown;
		try {
			parsePostgresStoreConfig(input);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(StoragePostgresError);
		expect(caught).toMatchObject({
			failure: "invalid-config",
			code: "INVALID_INPUT",
		});
		expect(caught instanceof Error ? caught.message : "").toContain(fragment);
	});

	it("reads HOBO_STORE_POSTGRES_* and requires the URL", () => {
		expect(
			postgresStoreConfigFromEnv({
				HOBO_STORE_POSTGRES_URL: "postgresql://h/db",
				HOBO_STORE_POSTGRES_POOL_SIZE: "4",
				HOBO_STORE_POSTGRES_SCHEMA: "cd",
			}),
		).toMatchObject({
			connectionString: "postgresql://h/db",
			poolSize: 4,
			schema: "cd",
		});
		expect(() => postgresStoreConfigFromEnv({})).toThrow(
			/HOBO_STORE_POSTGRES_URL is required/u,
		);
		expect(() =>
			postgresStoreConfigFromEnv({
				HOBO_STORE_POSTGRES_URL: "u",
				HOBO_STORE_POSTGRES_POOL_SIZE: "ten",
			}),
		).toThrow(/non-negative integer/u);
	});

	it("requires a connection string unless a pool is injected", () => {
		expect(() => createPostgresEventStore({ config: {} })).toThrow(
			/connectionString is required/u,
		);
	});
});

describe("typed failures with remediation", () => {
	it("maps every failure class to a core code, a wire enum and a remediation", () => {
		const failures = [
			[
				"invalid-config",
				"INVALID_INPUT",
				StoragePostgresErrorCode.INVALID_CONFIG,
			],
			[
				"invalid-input",
				"INVALID_INPUT",
				StoragePostgresErrorCode.INVALID_INPUT,
			],
			[
				"server-too-old",
				"MIGRATION_FAILURE",
				StoragePostgresErrorCode.SERVER_TOO_OLD,
			],
			[
				"migration-drift",
				"MIGRATION_FAILURE",
				StoragePostgresErrorCode.MIGRATION_DRIFT,
			],
			[
				"schema-ahead",
				"UNSUPPORTED_SCHEMA_VERSION",
				StoragePostgresErrorCode.SCHEMA_AHEAD,
			],
			[
				"unavailable",
				"PERSISTENCE_UNAVAILABLE",
				StoragePostgresErrorCode.UNAVAILABLE,
			],
			[
				"statement-timeout",
				"PERSISTENCE_UNAVAILABLE",
				StoragePostgresErrorCode.STATEMENT_TIMEOUT,
			],
			[
				"lease-held",
				"SUBSCRIPTION_LEASE_CONFLICT",
				StoragePostgresErrorCode.LEASE_HELD,
			],
			[
				"lease-not-held",
				"SUBSCRIPTION_LEASE_CONFLICT",
				StoragePostgresErrorCode.LEASE_NOT_HELD,
			],
			["closed", "PERSISTENCE_UNAVAILABLE", StoragePostgresErrorCode.CLOSED],
		] as const;
		for (const [failure, code, wire] of failures) {
			const error = new StoragePostgresError(failure, "m");
			expect(error.code).toBe(code);
			expect(storagePostgresErrorCode(failure)).toBe(wire);
			expect(remediationFor(error)?.length ?? 0).toBeGreaterThan(20);
		}
	});

	it("gives remediation for the core conflicts and none for foreign errors", () => {
		expect(
			remediationFor(new OptimisticSequenceConflictError("s", 0, 1)),
		).toContain("expectedSeq");
		expect(remediationFor(new Error("x"))).toBeUndefined();
	});

	it("translates driver errors by SQLSTATE and errno, and leaves programming errors alone", () => {
		const pgError = (code: string) =>
			Object.assign(new Error(`e${code}`), { code });
		expect(translatePgError(pgError("57014"))).toMatchObject({
			failure: "statement-timeout",
			sqlState: "57014",
		});
		expect(translatePgError(pgError("55P03"))).toMatchObject({
			failure: "statement-timeout",
		});
		expect(translatePgError(pgError("08006"))).toMatchObject({
			failure: "unavailable",
		});
		expect(translatePgError(pgError("57P01"))).toMatchObject({
			failure: "unavailable",
		});
		expect(translatePgError(pgError("53300"))).toMatchObject({
			failure: "unavailable",
		});
		expect(translatePgError(pgError("ECONNREFUSED"))).toMatchObject({
			failure: "unavailable",
		});
		expect(
			translatePgError(new Error("Connection terminated unexpectedly")),
		).toMatchObject({ failure: "unavailable" });
		const syntax = pgError("42601");
		expect(translatePgError(syntax)).toBe(syntax);
		expect(isRetryableTransactionError(pgError("40001"))).toBe(true);
		expect(isRetryableTransactionError(pgError("40P01"))).toBe(true);
		expect(isRetryableTransactionError(pgError("23505"))).toBe(false);
	});

	it("reports an unreachable server as unavailable, with remediation, without crashing", async () => {
		const store = createPostgresEventStore({
			config: {
				connectionString: "postgresql://nobody@127.0.0.1:1/none",
				connectionTimeoutMs: 500,
			},
		});
		await expect(store.ready()).rejects.toMatchObject({
			code: "PERSISTENCE_UNAVAILABLE",
			failure: "unavailable",
		});
		const health = await store.health();
		expect(health.ok).toBe(false);
		expect(health.checks[0]?.detail).toContain(
			"Check that the database is reachable",
		);
		await store.end();
	});
});

describe("identifiers and ids", () => {
	it("derives unique, time-ordered ULID-shaped ids from positions", () => {
		const a = eventIdFor(Date.parse("2026-11-12T00:00:00.000Z"), 1n);
		const b = eventIdFor(Date.parse("2026-11-12T00:00:00.000Z"), 2n);
		expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
		expect(a).not.toBe(b);
		expect(a < b).toBe(true);
		expect(eventIdFor(0, (1n << 80n) - 1n).slice(10)).toBe("ZZZZZZZZZZZZZZZZ");
		expect(() => eventIdFor(0, 0n)).toThrow();
		expect(() => eventIdFor(-1, 1n)).toThrow();
	});

	it("bounds notification channels to an identifier", () => {
		const schema = parseSchemaName(`s${"x".repeat(62)}`);
		expect(notifyChannel(schema).length).toBeLessThanOrEqual(63);
	});
});

describe("migrations (offline)", () => {
	it("ships a contiguous, append-only list whose checksums do not depend on the schema name", () => {
		expect(MIGRATIONS.map((m) => m.version)).toEqual(
			Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1),
		);
		const checksums = MIGRATIONS.map((migration) =>
			migrationChecksum(migration),
		);
		expect(
			checksums.every((checksum) => /^[0-9a-f]{64}$/u.test(checksum)),
		).toBe(true);
		// Pin the released checksums: editing an applied migration must be a new migration.
		expect(checksums).toMatchSnapshot();
	});

	it("refuses an old server before touching any schema", async () => {
		const seen: string[] = [];
		const client: PgClientLike = {
			async query(text: string, _values?: readonly PgParam[]) {
				seen.push(text);
				return { rows: [{ num: 150_004 }], rowCount: 1 };
			},
			release() {},
		};
		await expect(
			migrateSchema(client, {
				schema: parseSchemaName("s"),
				minServerMajorVersion: 16,
				now: "2026-11-12T00:00:00.000Z",
			}),
		).rejects.toMatchObject({ failure: "server-too-old" });
		expect(seen).toHaveLength(1);
		expect(serverMajorVersion(160_015)).toBe(16);
	});
});

describe("live-lane selection", () => {
	const probe = (overrides: Partial<Parameters<typeof planLane>[0]> = {}) => ({
		env: () => undefined,
		dockerReady: () => false,
		localBinDir: () => undefined,
		isRoot: () => false,
		hasPostgresUser: () => false,
		...overrides,
	});

	it("prefers an explicit URL, then a container, then local binaries", () => {
		expect(
			planLane(
				probe({
					env: (n) =>
						n === "HOBO_TEST_POSTGRES_URL" ? "postgresql://x" : undefined,
				}),
			),
		).toEqual({
			kind: "url",
			url: "postgresql://x",
		});
		expect(
			planLane(probe({ dockerReady: () => true, localBinDir: () => "/bin" })),
		).toMatchObject({ kind: "container" });
		expect(planLane(probe({ localBinDir: () => "/bin" }))).toEqual({
			kind: "local",
			binDir: "/bin",
			runAsPostgres: false,
		});
		expect(
			planLane(
				probe({
					localBinDir: () => "/bin",
					isRoot: () => true,
					hasPostgresUser: () => true,
				}),
			),
		).toEqual({
			kind: "local",
			binDir: "/bin",
			runAsPostgres: true,
		});
	});

	it("skips with a visible reason when nothing is available or the lane is switched off", () => {
		expect(planLane(probe())).toMatchObject({
			kind: "unavailable",
			reason: expect.stringContaining("HOBO_TEST_POSTGRES_URL"),
		});
		expect(
			planLane(probe({ localBinDir: () => "/bin", isRoot: () => true })),
		).toMatchObject({ kind: "unavailable" });
		expect(
			planLane(
				probe({
					dockerReady: () => true,
					env: (n) => (n === "HOBO_STORAGE_POSTGRES_LANE" ? "off" : undefined),
				}),
			),
		).toEqual({
			kind: "unavailable",
			reason: "disabled by HOBO_STORAGE_POSTGRES_LANE=off",
		});
	});
});
