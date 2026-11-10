import { randomBytes } from "node:crypto";
import {
	ensureFleetControlTables,
	parseFleetLayout,
	type SqlExecutor,
} from "@hobo/data-postgres";
import pg from "pg";
import { pgExecutor } from "../src/database-fleet-executor.js";

/** Comma-separated connection strings of at least three separate PostgreSQL
 * servers, each naming a database the role may create databases from. */
export const fleetServers = (process.env.HOBO_CI_TEST_FLEET_POSTGRES ?? "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
export const fleetServersAvailable = fleetServers.length >= 3;

export const testLayout = parseFleetLayout({
	dataPrefix: "hobo_ci_",
	controlPrefix: "hobo_ci_fleet_",
	excludedTables: ["hobo_ci_schema_migrations"],
});

export type TestBackend = {
	id: string;
	executor: SqlExecutor;
	pool: pg.Pool;
	url: string;
};

/** A fresh, empty database on each server, with the fleet's control tables. */
export async function createTestFleet(count = fleetServers.length) {
	const name = `hobo_fleet_${randomBytes(6).toString("hex")}`;
	const admins: pg.Pool[] = [];
	const backends: TestBackend[] = [];
	for (const [index, server] of fleetServers.slice(0, count).entries()) {
		const admin = new pg.Pool({ connectionString: server, max: 1 });
		admins.push(admin);
		await admin.query(`CREATE DATABASE ${name}`);
		const url = new URL(server);
		url.pathname = `/${name}`;
		const pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
		const backend = {
			id: `b${index}`,
			executor: pgExecutor(pool),
			pool,
			url: url.toString(),
		};
		await ensureFleetControlTables(backend, testLayout);
		backends.push(backend);
	}
	return {
		backends,
		/** Open fresh sessions, so database and role settings take effect. */
		async reconnect(backend: TestBackend) {
			await backend.pool.end();
			backend.pool = new pg.Pool({ connectionString: backend.url, max: 6 });
			backend.executor = pgExecutor(backend.pool);
		},
		async close() {
			for (const backend of backends) await backend.pool.end();
			for (const admin of admins) {
				// A closed pool's server sessions can take a moment to exit.
				for (let attempt = 0; ; attempt += 1) {
					try {
						await admin.query(`DROP DATABASE IF EXISTS ${name}`);
						break;
					} catch (error) {
						if (attempt === 50) throw error;
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
				}
				await admin.end();
			}
		},
	};
}

export function backendAt(backends: readonly TestBackend[], index: number) {
	const backend = backends[index];
	if (!backend) throw new Error(`fleet has no backend ${index}`);
	return backend;
}
