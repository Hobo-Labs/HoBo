import {
	copySnapshot,
	type FleetLayout,
	type SqlExecutor,
	type SqlSession,
} from "@hobo/data-postgres";

import { StoragePostgresError } from "./errors.js";
import {
	parseSchemaName,
	quoteSchema,
	type SchemaName,
} from "./identifiers.js";
import type { PgPoolLike } from "./pg.js";
import { createPostgresEventStore } from "./store.js";

export type FleetBackup = Readonly<{
	name: string;
	takenAtMs: number;
	source: string;
	rows: number;
}>;

export type FleetBackupOutcome =
	| Readonly<{ kind: "taken"; backup: FleetBackup; pruned: readonly string[] }>
	| Readonly<{ kind: "not-due"; nextAtMs: number }>
	| Readonly<{ kind: "failed"; message: string }>;

export interface FleetBackups {
	run(input: {
		readonly source: string;
		readonly executor: SqlExecutor;
		readonly nowMs: number;
	}): Promise<FleetBackupOutcome>;
	list(): Promise<readonly FleetBackup[]>;
	restore(input: {
		readonly target: SqlExecutor;
		readonly name?: string;
		readonly admit: (target: SqlSession) => Promise<void>;
	}): Promise<FleetBackup>;
}

export type FleetBackupsOptions = Readonly<{
	schema: SchemaName;
	everyMs: number;
	kept: number;
	layout: FleetLayout;
	pool: (schema: string) => PgPoolLike;
	executor: (pool: PgPoolLike) => SqlExecutor;
}>;

function backupFromRow(
	row: Readonly<Record<string, string | null>>,
): FleetBackup {
	return {
		name: String(row.name),
		takenAtMs: Number(row.taken_at_ms),
		source: String(row.source),
		rows: Number(row.rows),
	};
}

export function createFleetBackups(options: FleetBackupsOptions): FleetBackups {
	const catalogSchema = parseSchemaName(`${options.schema}_backups`);
	const catalog = `${quoteSchema(catalogSchema)}.catalog`;
	const home = options.pool(catalogSchema);
	const homeSql = options.executor(home);
	let prepared: Promise<void> | undefined;

	const prepare = () => {
		prepared ??= (async () => {
			await homeSql.query(
				`CREATE SCHEMA IF NOT EXISTS ${quoteSchema(catalogSchema)}`,
			);
			await homeSql.query(
				`CREATE TABLE IF NOT EXISTS ${catalog} (
					name text PRIMARY KEY,
					taken_at_ms bigint NOT NULL,
					source text NOT NULL,
					rows bigint NOT NULL
				)`,
			);
		})();
		prepared.catch(() => {
			prepared = undefined;
		});
		return prepared;
	};

	const list = async (): Promise<readonly FleetBackup[]> => {
		await prepare();
		const result = await homeSql.query(
			`SELECT name, taken_at_ms::text AS taken_at_ms, source, rows::text AS rows
			FROM ${catalog} ORDER BY taken_at_ms DESC, name DESC`,
		);
		return result.rows.map(backupFromRow);
	};

	const migrated = async (schema: SchemaName) => {
		const pool = options.pool(schema);
		const store = createPostgresEventStore({
			config: { schema, applicationName: "hobo-fleet-backup" },
			pool,
		});
		try {
			await store.ready();
		} finally {
			await store.end();
		}
		return pool;
	};

	return {
		list,
		async run({ source, executor, nowMs }) {
			try {
				const held = await list();
				const newest = held[0];
				if (newest !== undefined && newest.takenAtMs + options.everyMs > nowMs)
					return {
						kind: "not-due",
						nextAtMs: newest.takenAtMs + options.everyMs,
					};
				const name = parseSchemaName(`${options.schema}_b${nowMs}`);
				const pool = await migrated(name);
				let backup: FleetBackup;
				try {
					backup = await copySnapshot({
						source: executor,
						target: options.executor(pool),
						layout: options.layout,
						admit: async () => {},
						record: async (to: SqlSession, copy) => {
							const taken = {
								name,
								takenAtMs: nowMs,
								source,
								rows: copy.rowCount,
							};
							await to.query(
								`INSERT INTO ${catalog} (name, taken_at_ms, source, rows)
								VALUES ($1, $2::bigint, $3, $4::bigint)`,
								[taken.name, taken.takenAtMs, taken.source, taken.rows],
							);
							return taken;
						},
					});
				} catch (error) {
					await homeSql
						.query(`DROP SCHEMA IF EXISTS ${quoteSchema(name)} CASCADE`)
						.catch(() => {});
					throw error;
				} finally {
					await pool.end();
				}
				const pruned: string[] = [];
				for (const old of (await list()).slice(options.kept)) {
					await homeSql.query(
						`DROP SCHEMA IF EXISTS ${quoteSchema(parseSchemaName(old.name))} CASCADE`,
					);
					await homeSql.query(`DELETE FROM ${catalog} WHERE name = $1`, [
						old.name,
					]);
					pruned.push(old.name);
				}
				return { kind: "taken", backup, pruned };
			} catch (error) {
				return {
					kind: "failed",
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
		async restore({ target, name, admit }) {
			const held = await list();
			const chosen =
				name === undefined
					? held[0]
					: held.find((entry) => entry.name === name);
			if (chosen === undefined)
				throw new StoragePostgresError(
					"invalid-config",
					name === undefined
						? "the fleet holds no backup"
						: `no backup ${name}`,
				);
			const pool = options.pool(parseSchemaName(chosen.name));
			try {
				await copySnapshot({
					source: options.executor(pool),
					target,
					layout: options.layout,
					admit,
					record: async () => undefined,
				});
			} finally {
				await pool.end();
			}
			return chosen;
		},
	};
}
