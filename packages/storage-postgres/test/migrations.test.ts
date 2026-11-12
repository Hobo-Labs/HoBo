import pg from "pg";
import { expect, it } from "vitest";
import {
	MIGRATIONS,
	type Migration,
	migrateSchema,
	migrationChecksum,
	parseSchemaName,
	SCHEMA_VERSION,
} from "../src/index.js";
import {
	adminQuery,
	describeLive,
	freshSchema,
	liveStore,
	OPTS,
	POSTGRES_URL,
} from "./support/live.js";

async function withClient<T>(
	fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
	const client = new pg.Client({ connectionString: POSTGRES_URL });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}

describeLive("migrations", () => {
	it("migrates a fresh schema exactly once when many replicas start together", async () => {
		const schema = freshSchema();
		const stores = Array.from({ length: 6 }, () =>
			liveStore({ schema, config: { poolSize: 1 } }),
		);
		const reports = await Promise.all(stores.map((store) => store.ready()));
		expect(reports.filter((report) => report.applied.length > 0)).toHaveLength(
			1,
		);
		expect(reports.every((report) => report.toVersion === SCHEMA_VERSION)).toBe(
			true,
		);
		const rows = await adminQuery<{ version: number; checksum: string }>(
			`SELECT version, checksum FROM "${schema}".schema_migrations`,
		);
		expect(rows).toEqual(
			MIGRATIONS.map((m) => ({
				version: m.version,
				checksum: migrationChecksum(m),
			})),
		);
	});

	it("is a no-op on an up-to-date schema and keeps existing data", async () => {
		const schema = freshSchema();
		const first = liveStore({ schema });
		await first.append("keep", [{ type: "keep.Me", data: {} }], {
			...OPTS,
			expectedSeq: 0,
		});
		await first.end();
		const second = liveStore({ schema });
		expect((await second.ready()).applied).toEqual([]);
		expect((await second.loadStreamHead("keep"))?.revision).toBe(1);
	});

	it("refuses to start on a schema whose applied migration was edited (migration-drift)", async () => {
		const schema = freshSchema();
		await liveStore({ schema }).ready();
		await adminQuery(
			`UPDATE "${schema}".schema_migrations SET checksum = repeat('0', 64)`,
		);
		const store = liveStore({ schema });
		await expect(store.ready()).rejects.toMatchObject({
			code: "MIGRATION_FAILURE",
			failure: "migration-drift",
		});
		// Drift is permanent for the life of the store: every operation keeps refusing.
		await expect(
			store.append("x", [{ type: "x.Y" }], { ...OPTS, expectedSeq: 0 }),
		).rejects.toMatchObject({
			failure: "migration-drift",
		});
		const health = await store.health();
		expect(health.ok).toBe(false);
		expect(health.checks[0]?.detail).toContain("migration-drift");
	});

	it("refuses a schema migrated by a newer build (schema-ahead)", async () => {
		const schema = freshSchema();
		await liveStore({ schema }).ready();
		await adminQuery(
			`INSERT INTO "${schema}".schema_migrations (version, name, checksum, applied_at) VALUES ($1, 'future', repeat('f', 64), 'x')`,
			[SCHEMA_VERSION + 1],
		);
		await expect(liveStore({ schema }).ready()).rejects.toMatchObject({
			code: "UNSUPPORTED_SCHEMA_VERSION",
			failure: "schema-ahead",
		});
	});

	it("refuses a server older than the configured minimum (server-too-old)", async () => {
		await expect(
			liveStore({ config: { minServerMajorVersion: 999 } }).ready(),
		).rejects.toMatchObject({
			code: "MIGRATION_FAILURE",
			failure: "server-too-old",
		});
	});

	it("rolls a failing migration back completely", async () => {
		const schema = parseSchemaName(freshSchema());
		const broken: Migration[] = [
			...MIGRATIONS,
			{
				version: MIGRATIONS.length + 1,
				name: "broken",
				sql: (s) => `CREATE TABLE ${s}.half (id int); SELECT 1/0;`,
			},
		];
		await expect(
			withClient((client) =>
				migrateSchema(client, {
					schema,
					minServerMajorVersion: 16,
					now: "2026-11-12T00:00:00.000Z",
					migrations: broken,
				}),
			),
		).rejects.toMatchObject({ code: "22012" });
		const tables = await adminQuery(
			"SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
			[schema],
		);
		expect(tables).toHaveLength(0);
	});
});
