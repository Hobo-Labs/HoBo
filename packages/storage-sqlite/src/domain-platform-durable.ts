import type { Host as InMemoryWorkflowHost } from "@alchemy.run/domain/InMemoryWorkflows";
import type { Delivery } from "@alchemy.run/domain/Platform";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Semaphore from "effect/Semaphore";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import { Workflow, WorkflowEngine } from "effect/workflow";
import {
	asNumber,
	asText,
	type SqliteDriver,
	type SqliteRunResult,
} from "./driver.js";

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

CREATE TABLE IF NOT EXISTS domain_workflow_executions (
	model_name TEXT NOT NULL,
	workflow_name TEXT NOT NULL,
	execution_id TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	parent_json TEXT,
	PRIMARY KEY (model_name, workflow_name, execution_id)
);

CREATE TABLE IF NOT EXISTS domain_workflow_activity_journal (
	model_name TEXT NOT NULL,
	journal_key TEXT NOT NULL,
	exit_json TEXT NOT NULL,
	PRIMARY KEY (model_name, journal_key)
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

export type WorkflowDiedDefect = {
	readonly message: string;
	readonly raw: unknown;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: workflow engine defects arrive as untrusted catch values; this parser is the I/O boundary.
export function parseWorkflowDiedDefect(defect: unknown): WorkflowDiedDefect {
	if (defect instanceof Error) {
		return { message: defect.message, raw: defect };
	}
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: string defects are valid at this boundary before any domain logic runs.
	if (typeof defect === "string") {
		return { message: defect, raw: defect };
	}
	return { message: String(defect), raw: defect };
}

export function asInMemoryWorkflowHost(
	host: SqliteWorkflowHost,
): InMemoryWorkflowHost {
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: InMemoryWorkflows Host passes untrusted defects; parseWorkflowDiedDefect runs at this adapter boundary.
	const died = (workflow: string, executionId: string, defect: unknown) =>
		host.died(workflow, executionId, parseWorkflowDiedDefect(defect));
	if (host.turn !== undefined) {
		return {
			now: host.now,
			enqueue: host.enqueue,
			turn: host.turn,
			acquire: host.acquire,
			timer: host.timer,
			failed: host.failed,
			died,
		};
	}
	return {
		now: host.now,
		enqueue: host.enqueue,
		acquire: host.acquire,
		timer: host.timer,
		failed: host.failed,
		died,
	};
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
	dropStaged(
		modelName: string,
		ids: ReadonlyArray<number>,
	): Effect.Effect<void>;
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
		if (parsed === null || !Object.hasOwn(parsed, "target")) {
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
	listActive(
		modelName: string,
		aggregateName?: string,
	): ReadonlyArray<{
		readonly aggregateName: string;
		readonly instanceId: string;
		readonly scheduleName: string;
		readonly record: PersistedScheduleRecord;
	}>;
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
	const listActiveStmt = driver.prepare(
		`SELECT aggregate_name, instance_id, schedule_name, command_id, due_at, command_json, meta_json, cancelled
			FROM domain_schedules
			WHERE model_name = ? AND cancelled = 0 AND (? IS NULL OR aggregate_name = ?)`,
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
		upsert(modelName, aggregateName, instanceId, scheduleName, record) {
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
		listActive(modelName, aggregateName) {
			const filter = aggregateName ?? null;
			const rows = listActiveStmt.all(modelName, filter, filter);
			return rows.map((row) => ({
				aggregateName: asText(row.aggregate_name, "aggregate_name"),
				instanceId: asText(row.instance_id, "instance_id"),
				scheduleName: asText(row.schedule_name, "schedule_name"),
				record: rowToRecord({
					command_id: row.command_id,
					due_at: row.due_at,
					command_json: row.command_json,
					meta_json: row.meta_json,
					cancelled: row.cancelled,
				}),
			}));
		},
	};
}

export interface SqliteBackedWorkflowEngine {
	readonly engine: WorkflowEngine.WorkflowEngine["Service"];
	readonly resumeDurableSideEffects: Effect.Effect<void>;
}

type WorkflowClockTimerPayload = {
	readonly kind: "clock";
	readonly workflowName: string;
	readonly executionId: string;
	readonly deferredName: string;
	readonly durationMillis: number;
};

const parseWorkflowClockTimerPayload = (
	json: string,
): WorkflowClockTimerPayload => {
	const parsed = JSON.parse(json);
	if (
		parsed === null ||
		!Object.hasOwn(parsed, "kind") ||
		parsed.kind !== "clock" ||
		!Object.hasOwn(parsed, "workflowName") ||
		!Object.hasOwn(parsed, "executionId") ||
		!Object.hasOwn(parsed, "deferredName") ||
		!Object.hasOwn(parsed, "durationMillis")
	) {
		throw new DomainPersistenceError("domain_workflow_timers.payload", 0);
	}
	return {
		kind: "clock",
		workflowName: asText(parsed.workflowName, "workflowName"),
		executionId: asText(parsed.executionId, "executionId"),
		deferredName: asText(parsed.deferredName, "deferredName"),
		durationMillis: asNumber(parsed.durationMillis, "durationMillis"),
	};
};

/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: SqliteWorkflowHost mirrors Effect InMemoryWorkflows Host callbacks; failures and defects arrive untyped from the workflow engine. */
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
		defect: WorkflowDiedDefect,
	) => void;
}
/* oxlint-enable anti-slop/no-unknown-parameters */

export function makeSqliteBackedWorkflowEngine(
	modelName: string,
	driver: SqliteDriver,
	host: SqliteWorkflowHost,
	makeEngine: (
		wrapped: SqliteWorkflowHost,
	) => WorkflowEngine.WorkflowEngine["Service"],
): SqliteBackedWorkflowEngine {
	const insertPendingStmt = driver.prepare(
		"INSERT OR IGNORE INTO domain_workflow_pending_runs (model_name, run_key) VALUES (?, ?)",
	);
	const deletePendingStmt = driver.prepare(
		"DELETE FROM domain_workflow_pending_runs WHERE model_name = ? AND run_key = ?",
	);
	const listPendingStmt = driver.prepare(
		"SELECT run_key FROM domain_workflow_pending_runs WHERE model_name = ?",
	);
	const upsertTimerStmt = driver.prepare(
		`INSERT OR REPLACE INTO domain_workflow_timers (model_name, timer_key, fire_at, payload_json)
			VALUES (?, ?, ?, ?)`,
	);
	const deleteTimerStmt = driver.prepare(
		"DELETE FROM domain_workflow_timers WHERE model_name = ? AND timer_key = ?",
	);
	const listTimersStmt = driver.prepare(
		"SELECT timer_key, fire_at, payload_json FROM domain_workflow_timers WHERE model_name = ?",
	);
	const loadTimerStmt = driver.prepare(
		"SELECT fire_at, payload_json FROM domain_workflow_timers WHERE model_name = ? AND timer_key = ?",
	);
	const upsertExecutionStmt = driver.prepare(
		`INSERT OR REPLACE INTO domain_workflow_executions
			(model_name, workflow_name, execution_id, payload_json, parent_json)
			VALUES (?, ?, ?, ?, ?)`,
	);
	const loadJournalStmt = driver.prepare(
		"SELECT exit_json FROM domain_workflow_activity_journal WHERE model_name = ? AND journal_key = ?",
	);
	const upsertJournalStmt = driver.prepare(
		`INSERT OR REPLACE INTO domain_workflow_activity_journal (model_name, journal_key, exit_json)
			VALUES (?, ?, ?)`,
	);

	const workflowsByTag = new Map<string, Workflow.Any>();

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
				const existing = loadTimerStmt.get(modelName, key);
				const payload =
					existing === undefined
						? JSON.stringify({ kind: "wake", at })
						: asText(existing.payload_json, "payload_json");
				const result = upsertTimerStmt.run(modelName, key, at, payload);
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

	const inner = makeEngine(wrapped);

	const engine: WorkflowEngine.WorkflowEngine["Service"] = {
		...inner,
		register: (workflow, execute) =>
			Effect.gen(function* () {
				workflowsByTag.set(workflow._tag, workflow);
				yield* inner.register(workflow, execute);
			}),
		execute: (workflow, options) =>
			Effect.gen(function* () {
				const result = upsertExecutionStmt.run(
					modelName,
					workflow._tag,
					options.executionId,
					JSON.stringify(options.payload),
					null,
				);
				assertSqlitePersisted(result, "domain_workflow_executions.upsert");
				return yield* inner.execute(workflow, options);
			}),
		activityExecute: (activity, attempt) =>
			Effect.gen(function* () {
				const instance = yield* WorkflowEngine.WorkflowInstance;
				const journalKey = `${instance.workflow._tag}/${instance.executionId}/${activity.name}/${attempt}`;
				const row = loadJournalStmt.get(modelName, journalKey);
				if (row !== undefined) {
					const encoded = JSON.parse(asText(row.exit_json, "exit_json"));
					// SAFETY: exit_json is written only by this module from Complete activity exits.
					const exit = encoded as Exit.Exit<unknown, unknown>;
					return new Workflow.Complete({ exit });
				}
				const result = yield* inner.activityExecute(activity, attempt);
				if (result._tag === "Complete") {
					upsertJournalStmt.run(
						modelName,
						journalKey,
						JSON.stringify(result.exit),
					);
				}
				return result;
			}),
		scheduleClock: (workflow, options) =>
			Effect.gen(function* () {
				const timerKey = `${workflow._tag}/${options.executionId}/${options.clock.name}`;
				const existing = loadTimerStmt.get(modelName, timerKey);
				if (existing !== undefined) return;
				const durationMillis = Duration.toMillis(options.clock.duration);
				const fireAt = host.now() + durationMillis;
				const payload: WorkflowClockTimerPayload = {
					kind: "clock",
					workflowName: workflow._tag,
					executionId: options.executionId,
					deferredName: options.clock.deferred.name,
					durationMillis,
				};
				const written = upsertTimerStmt.run(
					modelName,
					timerKey,
					fireAt,
					JSON.stringify(payload),
				);
				assertSqlitePersisted(written, "domain_workflow_timers.clock");
				const wake = engine.deferredDone(options.clock.deferred, {
					workflowName: workflow._tag,
					executionId: options.executionId,
					deferredName: options.clock.deferred.name,
					exit: Exit.void,
				});
				yield* host.timer(
					timerKey,
					fireAt,
					Effect.forkDetach(wake).pipe(Effect.asVoid),
				);
			}),
	};

	const resumeDurableSideEffects = Effect.gen(function* () {
		for (const row of listPendingStmt.all(modelName)) {
			const runKey = asText(row.run_key, "run_key");
			const slash = runKey.indexOf("/");
			if (slash <= 0) continue;
			const workflowName = runKey.slice(0, slash);
			const executionId = runKey.slice(slash + 1);
			const workflow = workflowsByTag.get(workflowName);
			if (workflow === undefined) continue;
			yield* engine.resume(workflow, executionId);
		}
		for (const row of listTimersStmt.all(modelName)) {
			const timerKey = asText(row.timer_key, "timer_key");
			const fireAt = asNumber(row.fire_at, "fire_at");
			let payload: WorkflowClockTimerPayload;
			try {
				payload = parseWorkflowClockTimerPayload(
					asText(row.payload_json, "payload_json"),
				);
			} catch {
				continue;
			}
			const deferred = DurableDeferred.make(payload.deferredName);
			const wake = engine.deferredDone(deferred, {
				workflowName: payload.workflowName,
				executionId: payload.executionId,
				deferredName: payload.deferredName,
				exit: Exit.void,
			});
			yield* host.timer(
				timerKey,
				fireAt,
				Effect.forkDetach(wake).pipe(Effect.asVoid),
			);
		}
	});

	return { engine, resumeDurableSideEffects };
}
