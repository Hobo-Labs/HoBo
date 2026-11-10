/**
 * The SQLite engine binding: the `@hobo/data-core` SPI over one store.
 *
 * Every method answers synchronously. The SPI allows that (`Awaitable`), and
 * it is what lets the same store back the synchronous ports `@hobo/trails`
 * runs its live lanes on.
 */
import { randomUUID } from "node:crypto";
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

// public-contract: capability profile id the SQLite engine implements.
export const SQLITE_ENGINE_PROFILE = "data.sqlite/v1";
// public-contract: engine id reported in the SQLite engine declaration.
export const SQLITE_ENGINE_ID = "sqlite";

/**
 * Impedance this engine can report (ADR-0144). Each is a real limit of the
 * engine or of this binding, stated so nobody over-claims fidelity.
 */
export const SQLITE_IMPEDANCE_CODES = [
	/** Capture is a transactional outbox: a write that bypasses the binding is not captured. */
	"SQLITE_CAPTURE_OUTBOX_ONLY",
	/** The fence stops writers that go through the binding, not another process on the file. */
	"SQLITE_FENCE_ENTRY_POINT",
	/** Decimal, timestamp, date, uuid and json are stored as TEXT: exact through HoBo, unconstrained natively. */
	"SQLITE_TEXT_AFFINITY_TYPES",
	/** A schema snapshot is a file copy, so an in-memory store has no schema port. */
	"SQLITE_SCHEMA_SNAPSHOT_NEEDS_FILE",
	/** Text containing U+0000 is refused; SQLite would store it truncated. */
	"SQLITE_TEXT_REFUSES_NUL",
] as const;

const TEXT_NOTE =
	"stored as TEXT in canonical form; exact through this binding, but SQLite itself accepts any text";

/** How each canonical type lands in SQLite, and how faithful the trip is. */
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
	/** Store file path, or `:memory:`. A file is required for the schema port. */
	readonly path: string;
	readonly clock?: () => string;
}

export interface SqliteEngine extends EngineBinding {
	/** The store behind the binding, for the synchronous Trails ports. */
	readonly store: SqliteDatasetStore;
}

function declarationFor(fileBacked: boolean): EngineDeclaration {
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
			...(fileBacked ? ["schema"] : []),
		],
		captureOrdering: "global",
		fenceEnforcement: "entry-point",
		snapshotConsistency: "fuzzy",
		ddlTransactional: true,
		nativeProfiles: [],
		typeMapping: SQLITE_TYPE_MAPPING,
		impedance: [...SQLITE_IMPEDANCE_CODES],
	});
}

/** What the schema port needs from whatever owns the connection. */
export interface SqliteSchemaHost {
	readonly path: string;
	connection(): DatabaseSync;
	transaction<T>(body: () => T): T;
	reopen(replaceFile: () => void): void;
}

/** The schema port with synchronous signatures, as SQLite answers them. */
export interface SyncSchemaApplyPort {
	snapshot(): SchemaSnapshotRef;
	applyPhase(
		phase: SchemaPhase,
		statements: readonly string[],
	): SchemaPhaseResult;
	verify(violationsQuery: string): readonly JsonObject[];
	restore(ref: SchemaSnapshotRef): void;
}

/** Whitespace, statement terminators and comments: SQL that does nothing. */
const SQL_TRIVIA = /--[^\n]*|\/\*[\s\S]*?\*\/|[\s;]+/gu;

/**
 * Prepare a query that must be exactly one statement. SQLite compiles the
 * first statement of a string and ignores the rest, so a second violations
 * query would never run and its violations would read as none.
 */
function prepareSole(db: DatabaseSync, sql: string): StatementSync {
	const statement = db.prepare(sql);
	const compiled = statement.sourceSQL;
	// Anything that is not a prefix is treated as wholly uncompiled.
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

/**
 * Schema apply over a SQLite connection (ADR-0032 §3-4): real expand /
 * backfill / contract SQL, a mandatory restorable snapshot, and a restore
 * path. Rollback is forward-only — restore the snapshot and redeploy the
 * last-good Set; there are no `.down` scripts.
 */
export function createSchemaPort(
	host: SqliteSchemaHost,
	clock: () => string,
): SyncSchemaApplyPort {
	return {
		snapshot(): SchemaSnapshotRef {
			// A random ref, never a per-port counter: a counter restarts with the
			// process, so re-running a crashed migration would snapshot the
			// half-migrated store over the pre-migration copy and a later
			// rollback would restore the damage.
			const ref = `${host.path}.snapshot-${randomUUID()}`;
			// Checkpoint any WAL state so the file copy is the full store.
			host.connection().exec("PRAGMA wal_checkpoint(TRUNCATE)");
			// Exclusive: an existing snapshot is never written over.
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
			// One transaction per phase: SQLite DDL is transactional, so a
			// failing statement leaves nothing of the phase behind.
			const changes = host.transaction(() => {
				const db = host.connection();
				const before = totalChanges(db);
				for (const statement of statements) {
					// `exec`, not `prepare().run()`: an entry may hold several
					// statements, and preparing it would run the first and report
					// success for the rest.
					db.exec(statement);
				}
				// Rows the phase inserted, updated or deleted. A statement's own
				// `changes` is the count of the last DML before it, so DDL
				// would repeat a stale number.
				return totalChanges(db) - before;
			});
			return Object.freeze({ phase, statements: statements.length, changes });
		},
		verify(violationsQuery: string): readonly JsonObject[] {
			return Object.freeze(
				// SAFETY: SQL result rows are JSON-shaped evidence records.
				prepareSole(host.connection(), violationsQuery).all() as JsonObject[],
			);
		},
		restore(ref: SchemaSnapshotRef): void {
			if (!existsSync(ref.ref)) {
				throw new Error(`snapshot ${ref.ref} is missing; cannot restore`);
			}
			host.reopen(() => copyFileSync(ref.ref, host.path));
		},
	};
}

export function createSqliteEngine(options: SqliteEngineOptions): SqliteEngine {
	const clock = options.clock ?? (() => new Date().toISOString());
	const store = new SqliteDatasetStore({ path: options.path, clock });
	const fileBacked = options.path !== ":memory:";
	const binding: SqliteEngine = {
		store,
		declaration: declarationFor(fileBacked),
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
				return store.startSubscription(
					request.subscription,
					request.scope.dataset,
				);
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
		...(fileBacked ? { schema: createSchemaPort(store, clock) } : undefined),
		close() {
			store.close();
		},
	};
	return Object.freeze(binding);
}
