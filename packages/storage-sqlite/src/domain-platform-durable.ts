import type { Delivery } from "@alchemy.run/domain/Platform";
import type { JsonValue } from "@hobo/core";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";
import { asNumber, asText, type SqliteDriver, type SqliteRunResult } from "./driver.js";

// public-contract: SQLite DDL for durable domain side tables (outbox, schedules, workflow timers).
export const SQLITE_DOMAIN_DURABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS domain_outbox (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	model_name TEXT NOT NULL,
	delivery_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS domain_outbox_model_id
	ON domain_outbox (model_name, id);

CREATE TABLE IF NOT EXISTS domain_schedules (
	model_name TEXT NOT NULL,
	aggregate_name TEXT NOT NULL,
	instance_id TEXT NOT NULL,
	schedule_name TEXT NOT NULL,
	command_id TEXT NOT NULL,
	due_at INTEGER NOT NULL,
	command_json TEXT NOT NULL,
	meta_json TEXT NOT NULL,
	cancelled INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (model_name, aggregate_name, instance_id, schedule_name)
);

CREATE TABLE IF NOT EXISTS domain_workflow_timers (
	model_name TEXT NOT NULL,
	timer_key TEXT NOT NULL,
	fire_at INTEGER NOT NULL,
	payload_json TEXT NOT NULL,
	PRIMARY KEY (model_name, timer_key)
);

CREATE TABLE IF NOT EXISTS domain_workflow_pending_runs (
	model_name TEXT NOT NULL,
	run_key TEXT NOT NULL,
	PRIMARY KEY (model_name, run_key)
);
`;

export class DomainPersistenceError extends Error {
	readonly _tag = "DomainPersistenceError";
	constructor(
		readonly context: string,
		readonly changes: number,
	) {
		super(`SQLite persist refused (${context}, changes=${changes})`);
		this.name = "DomainPersistenceError";
	}
}

export function assertSqlitePersisted(
	result: SqliteRunResult,
	context: string,
	minChanges = 1,
): void {
	if (result.changes < minChanges) {
		throw new DomainPersistenceError(context, result.changes);
	}
}

export function initSqliteDomainDurableTables(driver: SqliteDriver): void {
	driver.exec(SQLITE_DOMAIN_DURABLE_SCHEMA_SQL);
	try {
		driver.exec(
			"ALTER TABLE domain_projections ADD COLUMN processed_position INTEGER NOT NULL DEFAULT 0",
		);
	} catch {}
}

export function scheduleDueMillis(
	now: () => number,
	due: { readonly at: number } | { readonly afterMillis: number },
): number {
	return "at" in due ? due.at : now() + due.afterMillis;
}

export interface DomainOutbox {
	stageWithinTransaction(
		modelName: string,
		deliveries: ReadonlyArray<Delivery>,
	): ReadonlyArray<number>;
	dropStaged(modelName: string, ids: ReadonlyArray<number>): Effect.Effect<void>;
	drainPending(
		modelName: string,
		deliver: (delivery: Delivery) => Effect.Effect<void>,
	): Effect.Effect<void>;
	count(modelName: string): number;
}

export function makeDomainOutbox(driver: SqliteDriver): DomainOutbox {
	const insertStmt = driver.prepare(
		"INSERT INTO domain_outbox (model_name, delivery_json) VALUES (?, ?)",
	);
	const deleteByIdsStmt = driver.prepare(
		"DELETE FROM domain_outbox WHERE model_name = ? AND id = ?",
	);
	const listStmt = driver.prepare(
		"SELECT id, delivery_json FROM domain_outbox WHERE model_name = ? ORDER BY id ASC LIMIT ?",
	);
	const countStmt = driver.prepare(
		"SELECT COUNT(*) AS n FROM domain_outbox WHERE model_name = ?",
	);

	const decodeDelivery = (json: string): Delivery => {
		const parsed = JSON.parse(json);
		if (parsed === null || !Object.prototype.hasOwnProperty.call(parsed, "target")) {
			throw new DomainPersistenceError("domain_outbox.delivery", 0);
		}
		// SAFETY: Outbox rows are written only by this module with Delivery-shaped JSON from domain commits.
		return parsed as Delivery;
	};

	return {
		stageWithinTransaction(modelName, deliveries) {
			const ids: number[] = [];
			for (const delivery of deliveries) {
				const result = insertStmt.run(modelName, JSON.stringify(delivery));
				assertSqlitePersisted(result, "domain_outbox.insert");
				ids.push(asNumber(result.lastInsertRowid, "lastInsertRowid"));
			}
			return ids;
		},
		dropStaged(modelName, ids) {
			return Effect.sync(() => {
				for (const id of ids) {
					deleteByIdsStmt.run(modelName, id);
				}
			});
		},
		drainPending(modelName, deliver) {
			return Effect.gen(function* () {
				const maxPasses = 32;
				for (let pass = 0; pass < maxPasses; pass += 1) {
					const rows = listStmt.all(modelName, 64);
					if (rows.length === 0) return;
					for (const row of rows) {
						const id = asNumber(row.id, "id");
						const delivery = decodeDelivery(
							asText(row.delivery_json, "delivery_json"),
						);
						yield* deliver(delivery);
						deleteByIdsStmt.run(modelName, id);
					}
				}
				throw new DomainPersistenceError("domain_outbox.drain", -1);
			});
		},
		count(modelName) {
			const row = countStmt.get(modelName);
			if (row === undefined) return 0;
			return asNumber(row.n, "n");
		},
	};
}

export interface PersistedScheduleRecord {
	readonly commandId: string;
	readonly dueAt: number;
	readonly commandJson: string;
	readonly metaJson: string;
	readonly cancelled: boolean;
}

export interface DomainScheduleStore {
	upsert(
		modelName: string,
		aggregateName: string,
		instanceId: string,
		scheduleName: string,
		record: PersistedScheduleRecord,
	): void;
	markCancelled(
		modelName: string,
		aggregateName: string,
		instanceId: string,
		scheduleName: string,
	): void;
	load(
		modelName: string,
		aggregateName: string,
		instanceId: string,
		scheduleName: string,
	): PersistedScheduleRecord | undefined;
}

export function makeDomainScheduleStore(
	driver: SqliteDriver,
): DomainScheduleStore {
	const upsertStmt = driver.prepare(
		`INSERT OR REPLACE INTO domain_schedules
			(model_name, aggregate_name, instance_id, schedule_name, command_id, due_at, command_json, meta_json, cancelled)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const loadStmt = driver.prepare(
		`SELECT command_id, due_at, command_json, meta_json, cancelled
			FROM domain_schedules
			WHERE model_name = ? AND aggregate_name = ? AND instance_id = ? AND schedule_name = ?`,
	);
	const cancelStmt = driver.prepare(
		`UPDATE domain_schedules SET cancelled = 1
			WHERE model_name = ? AND aggregate_name = ? AND instance_id = ? AND schedule_name = ?`,
	);

	const rowToRecord = (row: {
		command_id: unknown;
		due_at: unknown;
		command_json: unknown;
		meta_json: unknown;
		cancelled: unknown;
	}): PersistedScheduleRecord => ({
		commandId: asText(row.command_id, "command_id"),
		dueAt: asNumber(row.due_at, "due_at"),
		commandJson: asText(row.command_json, "command_json"),
		metaJson: asText(row.meta_json, "meta_json"),
		cancelled: asNumber(row.cancelled, "cancelled") !== 0,
	});

	return {
		upsert(
			modelName,
			aggregateName,
			instanceId,
			scheduleName,
			record,
		) {
			const result = upsertStmt.run(
				modelName,
				aggregateName,
				instanceId,
				scheduleName,
				record.commandId,
				record.dueAt,
				record.commandJson,
				record.metaJson,
				record.cancelled ? 1 : 0,
			);
			assertSqlitePersisted(result, "domain_schedules.upsert");
		},
		markCancelled(modelName, aggregateName, instanceId, scheduleName) {
			const result = cancelStmt.run(
				modelName,
				aggregateName,
				instanceId,
				scheduleName,
			);
			assertSqlitePersisted(result, "domain_schedules.cancel", 0);
		},
		load(modelName, aggregateName, instanceId, scheduleName) {
			const row = loadStmt.get(
				modelName,
				aggregateName,
				instanceId,
				scheduleName,
			);
			return row === undefined
				? undefined
				: rowToRecord({
						command_id: row.command_id,
						due_at: row.due_at,
						command_json: row.command_json,
						meta_json: row.meta_json,
						cancelled: row.cancelled,
					});
		},
	};
}

export interface SqliteWorkflowHost {
	readonly now: () => number;
	readonly enqueue: (
		run: Effect.Effect<void>,
		key: string,
	) => Effect.Effect<void>;
	readonly turn?: (key: string, activity: string) => Effect.Effect<void>;
	readonly acquire: (lock: Semaphore.Semaphore) => Effect.Effect<void>;
	readonly timer: (
		key: string,
		at: number,
		fire: Effect.Effect<void>,
	) => Effect.Effect<void>;
	readonly failed: (cause: unknown) => void;
	readonly died: (
		workflow: string,
		executionId: string,
		defect: JsonValue,
	) => void;
}

export function makeSqliteBackedWorkflowEngine(
	modelName: string,
	driver: SqliteDriver,
	host: SqliteWorkflowHost,
	makeEngine: (
		wrapped: SqliteWorkflowHost,
	) => import("effect/workflow").WorkflowEngine.WorkflowEngine["Service"],
): import("effect/workflow").WorkflowEngine.WorkflowEngine["Service"] {
	const insertPendingStmt = driver.prepare(
		"INSERT OR IGNORE INTO domain_workflow_pending_runs (model_name, run_key) VALUES (?, ?)",
	);
	const deletePendingStmt = driver.prepare(
		"DELETE FROM domain_workflow_pending_runs WHERE model_name = ? AND run_key = ?",
	);
	const upsertTimerStmt = driver.prepare(
		`INSERT OR REPLACE INTO domain_workflow_timers (model_name, timer_key, fire_at, payload_json)
			VALUES (?, ?, ?, ?)`,
	);
	const deleteTimerStmt = driver.prepare(
		"DELETE FROM domain_workflow_timers WHERE model_name = ? AND timer_key = ?",
	);

	const wrapped: SqliteWorkflowHost = {
		...host,
		enqueue: (run, key) =>
			Effect.gen(function* () {
				insertPendingStmt.run(modelName, key);
				const wrappedRun = run.pipe(
					Effect.ensuring(
						Effect.sync(() => {
							deletePendingStmt.run(modelName, key);
						}),
					),
				);
				yield* host.enqueue(wrappedRun, key);
			}),
		timer: (key, at, fire) =>
			Effect.gen(function* () {
				const result = upsertTimerStmt.run(
					modelName,
					key,
					at,
					JSON.stringify({ at }),
				);
				assertSqlitePersisted(result, "domain_workflow_timers.upsert");
				const wrappedFire = fire.pipe(
					Effect.ensuring(
						Effect.sync(() => {
							deleteTimerStmt.run(modelName, key);
						}),
					),
				);
				yield* host.timer(key, at, wrappedFire);
			}),
	};

	return makeEngine(wrapped);
}
