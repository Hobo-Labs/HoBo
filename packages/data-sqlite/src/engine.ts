import { type KeyObject, randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync } from "node:fs";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import {
	type DatasetSchema,
	type EngineBinding,
	type EngineDeclaration,
	type JsonObject,
	parseEngineDeclaration,
	type RecordMutation,
	type SchemaPhase,
	type SchemaPhaseResult,
	type SchemaSnapshotRef,
	type SnapshotCursor,
	type SnapshotRequest,
	schemaToJson,
} from "@hobo/data-core";
import { SqliteDataError } from "./errors.js";
import { SqliteDatasetStore } from "./store.js";

export const SQLITE_ENGINE_PROFILE = "data.sqlite/v1";
export const SQLITE_ENGINE_ID = "sqlite";

export const SQLITE_IMPEDANCE_CODES = [
	"SQLITE_CAPTURE_OUTBOX_ONLY",
	"SQLITE_FENCE_ENTRY_POINT",
	"SQLITE_TEXT_AFFINITY_TYPES",
	"SQLITE_SCHEMA_SNAPSHOT_NEEDS_FILE",
	"SQLITE_TEXT_REFUSES_NUL",
] as const;

const TEXT_NOTE =
	"stored as TEXT in canonical form; exact through this binding, but SQLite itself accepts any text";

export const SQLITE_TYPE_MAPPING: JsonObject = Object.freeze({
	engine: SQLITE_ENGINE_ID,
	edges: [
		{
			canonical: "bool",
			native: "INTEGER",
			write: "exact",
			read: "widening",
			note: "any non-zero integer reads as true",
		},
		{
			canonical: "int64",
			native: "INTEGER",
			write: "exact",
			read: "exact",
			note: "",
		},
		{
			canonical: "float64",
			native: "REAL",
			write: "exact",
			read: "exact",
			note: "",
		},
		{
			canonical: "decimal",
			native: "TEXT",
			write: "exact",
			read: "widening",
			note: TEXT_NOTE,
		},
		{
			canonical: "string",
			native: "TEXT",
			write: "constrained",
			read: "exact",
			note: "U+0000 is refused: SQLite's text API would store the value truncated at the first NUL",
		},
		{
			canonical: "bytes",
			native: "BLOB",
			write: "exact",
			read: "exact",
			note: "",
		},
		{
			canonical: "timestamp",
			native: "TEXT",
			write: "exact",
			read: "widening",
			note: TEXT_NOTE,
		},
		{
			canonical: "date",
			native: "TEXT",
			write: "exact",
			read: "widening",
			note: TEXT_NOTE,
		},
		{
			canonical: "uuid",
			native: "TEXT",
			write: "exact",
			read: "widening",
			note: TEXT_NOTE,
		},
		{
			canonical: "json",
			native: "TEXT",
			write: "exact",
			read: "widening",
			note: TEXT_NOTE,
		},
		{
			canonical: "encrypted",
			native: "TEXT",
			write: "exact",
			read: "widening",
			note: TEXT_NOTE,
		},
	],
});

// domain-view: construction options (adds an injected clock); wire form is SqliteEngineOptions in data-models/data_sqlite.proto.
export interface SqliteEngineOptions {
	readonly path: string;
	readonly clock?: () => string;
	readonly operationReceivers?: ReadonlyMap<
		string,
		string | Buffer | KeyObject
	>;
}

export interface SqliteEngine extends EngineBinding {
	readonly store: SqliteDatasetStore;
}

function declarationFor(
	schemaAllowed: boolean,
	operationFenceEnabled: boolean,
): EngineDeclaration {
	return parseEngineDeclaration({
		engine: SQLITE_ENGINE_ID,
		profile: SQLITE_ENGINE_PROFILE,
		paradigm: "relational",
		ports: [
			"datasets",
			"records",
			"snapshot",
			"capture",
			"apply",
			"verify",
			"fence",
			"retire",
			...(schemaAllowed ? ["schema"] : []),
		],
		captureOrdering: "global",
		fenceEnforcement: "entry-point",
		snapshotConsistency: "fuzzy",
		ddlTransactional: true,
		nativeProfiles: [],
		typeMapping: SQLITE_TYPE_MAPPING,
		impedance: [
			...SQLITE_IMPEDANCE_CODES,
			...(operationFenceEnabled
				? ["SQLITE_SCHEMA_DISABLED_FOR_FENCE_OPERATIONS"]
				: []),
		],
	});
}

export interface SqliteSchemaHost {
	readonly path: string;
	connection(): DatabaseSync;
	transaction<T>(body: () => T): T;
	reopen(replaceFile: () => void): void;
	operationFenceEnabled?(): boolean;
}

export interface SyncSchemaApplyPort {
	snapshot(): SchemaSnapshotRef;
	applyPhase(
		phase: SchemaPhase,
		statements: readonly string[],
	): SchemaPhaseResult;
	verify(violationsQuery: string): readonly JsonObject[];
	restore(ref: SchemaSnapshotRef): void;
}

const SQL_TRIVIA = /--[^\n]*|\/\*[\s\S]*?\*\/|[\s;]+/gu;

function prepareSole(db: DatabaseSync, sql: string): StatementSync {
	const statement = db.prepare(sql);
	const compiled = statement.sourceSQL;
	const tail = sql.startsWith(compiled) ? sql.slice(compiled.length) : sql;
	if (tail.replace(SQL_TRIVIA, "") !== "") {
		throw new SqliteDataError(
			"SCHEMA_QUERY_NOT_SINGLE",
			"a verify query must be a single statement; the SQL after the first would not have run",
			{ detail: { field: "violationsQuery" } },
		);
	}
	return statement;
}

function totalChanges(db: DatabaseSync): number {
	const row = db.prepare("SELECT total_changes() AS total").get();
	return Number(row?.total ?? 0);
}

export function createSchemaPort(
	host: SqliteSchemaHost,
	clock: () => string,
): SyncSchemaApplyPort {
	return {
		snapshot(): SchemaSnapshotRef {
			const ref = `${host.path}.snapshot-${randomUUID()}`;
			host.connection().exec("PRAGMA wal_checkpoint(TRUNCATE)");
			copyFileSync(host.path, ref, constants.COPYFILE_EXCL);
			return Object.freeze({ ref, takenAt: clock() });
		},
		applyPhase(
			phase: SchemaPhase,
			statements: readonly string[],
		): SchemaPhaseResult {
			if (statements.length === 0) {
				return Object.freeze({ phase, statements: 0, changes: 0 });
			}
			const changes = host.transaction(() => {
				if (host.operationFenceEnabled?.())
					throw new Error(
						"schema mutation is unavailable while native fence operations are enabled",
					);
				const db = host.connection();
				const before = totalChanges(db);
				for (const statement of statements) {
					db.exec(statement);
				}
				return totalChanges(db) - before;
			});
			return Object.freeze({ phase, statements: statements.length, changes });
		},
		verify(violationsQuery: string): readonly JsonObject[] {
			return Object.freeze(
				prepareSole(host.connection(), violationsQuery).all() as JsonObject[],
			);
		},
		restore(ref: SchemaSnapshotRef): void {
			if (host.operationFenceEnabled?.())
				throw new Error(
					"schema restore is unavailable while native fence operations are enabled",
				);
			if (!existsSync(ref.ref)) {
				throw new Error(`snapshot ${ref.ref} is missing; cannot restore`);
			}
			host.reopen(() => copyFileSync(ref.ref, host.path));
		},
	};
}

export function createSqliteEngine(options: SqliteEngineOptions): SqliteEngine {
	const clock = options.clock ?? (() => new Date().toISOString());
	const receivers = new Map(options.operationReceivers ?? []);
	const store = new SqliteDatasetStore({
		path: options.path,
		clock,
		operationReceivers: receivers,
	});
	const fileBacked = options.path !== ":memory:";
	const operationFenceEnabled = store.operationFenceEnabled();
	const schemaAllowed = fileBacked && !operationFenceEnabled;
	const binding: SqliteEngine = {
		store,
		declaration: declarationFor(schemaAllowed, operationFenceEnabled),
		datasets: {
			ensureDataset(schema: DatasetSchema) {
				return {
					dataset: schema.name,
					created: store.ensure(schema, schemaToJson(schema)),
				};
			},
			describeDataset(name: string) {
				return store.describe(name);
			},
		},
		records: {
			write(request) {
				const position = store.commit(
					request.dataset,
					request.mutations,
					request.fenceToken,
				);
				return { position, applied: request.mutations.length };
			},
			read(request) {
				return store.read(request.dataset, request.tenant, request.key);
			},
		},
		snapshot: {
			openSnapshot(request: SnapshotRequest): SnapshotCursor {
				let after: readonly SQLInputValue[] | undefined;
				let done = false;
				return {
					next(): readonly RecordMutation[] | undefined {
						if (done) return undefined;
						const page = store.page(request.scope, after, request.chunkSize);
						if (page.rows.length < request.chunkSize) done = true;
						after = page.last;
						return page.rows.length === 0 ? undefined : page.rows;
					},
					close() {},
				};
			},
		},
		capture: {
			start(request) {
				return store.startSubscription(request.subscription, request.scope);
			},
			read(request) {
				return store.readChanges(request.scope, request.after, request.limit);
			},
			acknowledge(request) {
				store.acknowledge(request.subscription, request.position);
			},
			stop(subscription: string) {
				store.stopSubscription(subscription);
			},
		},
		apply: {
			apply(request) {
				store.commit(request.dataset, request.changes, request.fenceToken, {
					source: request.source,
					position: request.position,
					...(request.expectedWatermark === undefined
						? undefined
						: { expected: request.expectedWatermark }),
				});
				return { applied: request.changes.length };
			},
			watermark(request) {
				return store.watermark(request.dataset, request.source);
			},
		},
		verify: {
			digest(request) {
				return store.digest(request.scope, request.buckets);
			},
		},
		fence: {
			...(receivers.size
				? {
						operation: {
							claim(input) {
								return store.claimFenceOperation(input);
							},
							complete(receipt) {
								store.completeFenceOperation(receipt);
							},
							inspect(scope, operationId) {
								return store.inspectFenceOperation(scope, operationId);
							},
						},
					}
				: undefined),
			raise(request) {
				return { fenceToken: store.raiseFence(request.scope) };
			},
			release(request) {
				store.releaseFence(request.scope, request.fenceToken);
			},
			status(scope) {
				return { fenced: store.isFenced(scope) };
			},
		},
		retire: {
			retire(request) {
				return {
					removed: store.retire(
						request.scope,
						request.fenceToken,
						request.expected,
					),
				};
			},
		},
		...(schemaAllowed ? { schema: createSchemaPort(store, clock) } : undefined),
		close() {
			store.close();
		},
	};
	return Object.freeze(binding);
}
