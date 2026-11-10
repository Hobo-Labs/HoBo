/**
 * The SQLite dataset store: every operation the SPI needs, synchronously,
 * over one `node:sqlite` connection.
 *
 * SQLite is embedded and single-owner (ADR-0135: one partition, one writer),
 * and that shapes three decisions here, each of which the engine declaration
 * states rather than hides:
 *
 * - **Capture is a transactional outbox.** A change is journaled in the same
 *   transaction as the write that caused it. A write that bypasses this store
 *   is not captured.
 * - **The fence is enforced at the write entry point.** It is a durable row
 *   checked inside the write transaction — but a process with its own
 *   connection to the file is not stopped by it.
 * - **A scan is fuzzy.** It pages by key on the same connection; the
 *   executors take a capture position first and replay from it, which
 *   converges regardless.
 */
import {
	DatabaseSync,
	type SQLInputValue,
	type SQLOutputValue,
	type StatementSync,
} from "node:sqlite";
import {
	type CanonicalRecord,
	type CaptureBatch,
	type ChangeEnvelope,
	canonicalEncode,
	DataCoreError,
	type DatasetDigest,
	DatasetDigestBuilder,
	type DatasetField,
	type DatasetSchema,
	type DatasetScope,
	decodeRecordKey,
	encodeRecordKey,
	envelopeOf,
	FencedWriteError,
	type JsonObject,
	type JsonValue,
	type Position,
	parseCanonicalRecord,
	parseDatasetSchema,
	type RecordMutation,
	schemaDigest,
} from "@hobo/data-core";

const tagOf = Object.prototype.toString;

type Row = Record<string, SQLOutputValue>;

/** Column holding undeclared fields of an open schema, as one JSON object. */
const EXTRA_COLUMN = "hobo_extra";
const TENANT_COLUMN = "tenant_id";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const NATIVE_TYPES: Readonly<Record<DatasetField["type"], string>> =
	Object.freeze({
		bool: "INTEGER",
		int64: "INTEGER",
		float64: "REAL",
		decimal: "TEXT",
		string: "TEXT",
		bytes: "BLOB",
		timestamp: "TEXT",
		date: "TEXT",
		uuid: "TEXT",
		json: "TEXT",
		encrypted: "TEXT",
	});

export function sqliteNativeType(type: DatasetField["type"]): string {
	return NATIVE_TYPES[type];
}

export function quoteIdentifier(name: string): string {
	if (!IDENTIFIER.test(name)) {
		throw new DataCoreError(
			"INVALID_DATASET_SCHEMA",
			`invalid SQL identifier: ${name}`,
			{
				detail: { identifier: name },
			},
		);
	}
	return `"${name}"`;
}

function isText<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

function isBigInt<T>(value: T): value is T & bigint {
	return tagOf.call(value) === "[object BigInt]";
}

function parseJson(text: string): JsonValue {
	// SAFETY: JSON.parse yields a JSON value at this document boundary.
	return JSON.parse(text) as JsonValue;
}

function toNative(field: DatasetField, value: JsonValue): SQLInputValue {
	if (value === null) return null;
	switch (field.type) {
		case "bool":
			return value === true ? 1 : 0;
		case "int64":
			return BigInt(String(value));
		case "float64":
			return Number(value);
		case "bytes":
			return Buffer.from(String(value), "base64");
		case "json":
		case "encrypted":
			// JSON text escapes U+0000, so it survives where raw text would not.
			return canonicalEncode(value);
		case "string": {
			const text = String(value);
			// SQLite's text API stops at the first NUL: the value would be stored
			// truncated. Refusing is the only outcome that is not silent loss.
			if (text.includes("\u0000")) {
				throw new DataCoreError(
					"INVALID_RECORD",
					`${field.name} contains U+0000, which SQLite text cannot hold`,
					{ detail: { field: field.name } },
				);
			}
			return text;
		}
		default:
			return String(value);
	}
}

function fromNative(field: DatasetField, raw: SQLOutputValue): JsonValue {
	if (raw === null) return null;
	switch (field.type) {
		case "bool":
			return Number(raw) !== 0;
		case "int64":
			return isBigInt(raw) ? raw.toString() : String(raw);
		case "float64":
			return Number(raw);
		case "bytes":
			return raw instanceof Uint8Array
				? Buffer.from(raw).toString("base64")
				: String(raw);
		case "json":
		case "encrypted":
			return parseJson(String(raw));
		default:
			return String(raw);
	}
}

export interface SqliteStoreOptions {
	/** Store file path, or `:memory:`. */
	readonly path: string;
	readonly clock?: () => string;
}

/** One page of a keyset scan, and the cursor to continue from. */
export interface KeysetPage {
	readonly rows: RecordMutation[];
	readonly last: readonly SQLInputValue[] | undefined;
}

export interface FenceRow {
	readonly tenant: string;
	readonly fenceToken: string;
}

export class SqliteDatasetStore {
	readonly path: string;
	private db: DatabaseSync;
	private readonly clock: () => string;
	private readonly statements = new Map<string, StatementSync>();
	private readonly schemas = new Map<string, DatasetSchema>();

	constructor(options: SqliteStoreOptions) {
		this.path = options.path;
		this.clock = options.clock ?? (() => new Date().toISOString());
		this.db = new DatabaseSync(options.path);
		this.bootstrap();
	}

	private bootstrap(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS hobo_data_datasets (
				name TEXT PRIMARY KEY,
				schema TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS hobo_data_journal (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				dataset TEXT NOT NULL,
				tenant_id TEXT NOT NULL,
				key TEXT NOT NULL,
				op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
				record TEXT
			);
			CREATE INDEX IF NOT EXISTS hobo_data_journal_scope
				ON hobo_data_journal (dataset, tenant_id, seq);
			CREATE TABLE IF NOT EXISTS hobo_data_watermarks (
				dataset TEXT NOT NULL,
				source TEXT NOT NULL,
				position TEXT NOT NULL,
				PRIMARY KEY (dataset, source)
			);
			CREATE TABLE IF NOT EXISTS hobo_data_fences (
				dataset TEXT NOT NULL,
				tenant_id TEXT NOT NULL,
				fence_token TEXT NOT NULL,
				fenced_at TEXT NOT NULL,
				PRIMARY KEY (dataset, tenant_id)
			);
			CREATE TABLE IF NOT EXISTS hobo_data_subscriptions (
				name TEXT PRIMARY KEY,
				dataset TEXT NOT NULL,
				start_position INTEGER NOT NULL,
				ack_position INTEGER NOT NULL
			);
		`);
	}

	/** The raw connection, for the schema-apply port's arbitrary statements. */
	connection(): DatabaseSync {
		return this.db;
	}

	/** Swap the store file for a snapshot and reopen (schema-apply restore). */
	reopen(replaceFile: () => void): void {
		this.statements.clear();
		this.schemas.clear();
		this.db.close();
		replaceFile();
		this.db = new DatabaseSync(this.path);
		this.bootstrap();
	}

	close(): void {
		this.statements.clear();
		this.db.close();
	}

	private statement(sql: string): StatementSync {
		const cached = this.statements.get(sql);
		if (cached !== undefined) return cached;
		const prepared = this.db.prepare(sql);
		// 64-bit integers must survive the trip; a JS number cannot hold them.
		prepared.setReadBigInts(true);
		this.statements.set(sql, prepared);
		return prepared;
	}

	private all(sql: string, ...params: SQLInputValue[]): Row[] {
		// SAFETY: node:sqlite returns plain column-name → value rows.
		return this.statement(sql).all(...params) as Row[];
	}

	private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
		// SAFETY: node:sqlite returns a plain column-name → value row or undefined.
		return this.statement(sql).get(...params) as Row | undefined;
	}

	private run(sql: string, ...params: SQLInputValue[]): number {
		return Number(this.statement(sql).run(...params).changes);
	}

	transaction<T>(body: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	// ── datasets ──────────────────────────────────────────────────────────────

	describe(name: string): DatasetSchema | undefined {
		const cached = this.schemas.get(name);
		if (cached !== undefined) return cached;
		const row = this.get(
			"SELECT schema FROM hobo_data_datasets WHERE name = ?",
			name,
		);
		if (row === undefined) return undefined;
		const schema = parseDatasetSchema(parseJson(String(row.schema)));
		this.schemas.set(name, schema);
		return schema;
	}

	schema(name: string): DatasetSchema {
		const found = this.describe(name);
		if (found === undefined) {
			throw new DataCoreError(
				"INVALID_RECORD",
				`dataset ${name} does not exist`,
				{
					detail: { dataset: name },
				},
			);
		}
		return found;
	}

	/**
	 * Create the dataset table if absent. An existing table with the same name
	 * is adopted: that is how a brownfield store written before this engine
	 * existed comes under it without a copy.
	 */
	ensure(schema: DatasetSchema, serialized: JsonObject): boolean {
		const existing = this.describe(schema.name);
		if (existing !== undefined) {
			if (schemaDigest(existing) !== schemaDigest(schema)) {
				throw new DataCoreError(
					"INVALID_DATASET_SCHEMA",
					`dataset ${schema.name} exists with a different schema`,
					{ detail: { dataset: schema.name } },
				);
			}
			return false;
		}
		const columns = [
			`${quoteIdentifier(TENANT_COLUMN)} TEXT NOT NULL DEFAULT ''`,
			...schema.fields.map(
				(field) =>
					`${quoteIdentifier(field.name)} ${sqliteNativeType(field.type)}${field.nullable ? "" : " NOT NULL"}`,
			),
			...(schema.open ? [`${quoteIdentifier(EXTRA_COLUMN)} TEXT`] : []),
			`PRIMARY KEY (${[TENANT_COLUMN, ...schema.keyFields].map(quoteIdentifier).join(", ")})`,
		];
		this.transaction(() => {
			this.db.exec(
				`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(schema.name)} (${columns.join(", ")})`,
			);
			this.run(
				"INSERT INTO hobo_data_datasets (name, schema) VALUES (?, ?)",
				schema.name,
				canonicalEncode(serialized),
			);
		});
		this.schemas.set(schema.name, schema);
		return true;
	}

	// ── records ───────────────────────────────────────────────────────────────

	private rowToRecord(schema: DatasetSchema, row: Row): CanonicalRecord {
		const raw: { [key: string]: JsonValue } = {};
		for (const field of schema.fields) {
			raw[field.name] = fromNative(field, row[field.name] ?? null);
		}
		const extra = row[EXTRA_COLUMN];
		if (schema.open && isText(extra)) {
			const parsed = parseJson(extra);
			if (parsed !== null && tagOf.call(parsed) === "[object Object]") {
				// SAFETY: the tag check above proves a JSON object.
				Object.assign(raw, parsed as JsonObject);
			}
		}
		return parseCanonicalRecord(schema, raw);
	}

	private keyParams(
		schema: DatasetSchema,
		tenant: string,
		key: string,
	): SQLInputValue[] {
		const values = decodeRecordKey(schema, key);
		return [
			tenant,
			...schema.keyFields.map((name) => {
				const field = schema.fields.find((entry) => entry.name === name);
				const value = values[name] ?? null;
				return field === undefined ? String(value) : toNative(field, value);
			}),
		];
	}

	private keyPredicate(schema: DatasetSchema): string {
		return [TENANT_COLUMN, ...schema.keyFields]
			.map((name) => `${quoteIdentifier(name)} = ?`)
			.join(" AND ");
	}

	read(
		dataset: string,
		tenant: string,
		key: string,
	): CanonicalRecord | undefined {
		const schema = this.schema(dataset);
		const row = this.get(
			`SELECT * FROM ${quoteIdentifier(dataset)} WHERE ${this.keyPredicate(schema)}`,
			...this.keyParams(schema, tenant, key),
		);
		return row === undefined ? undefined : this.rowToRecord(schema, row);
	}

	fences(dataset: string): FenceRow[] {
		return this.all(
			"SELECT tenant_id, fence_token FROM hobo_data_fences WHERE dataset = ?",
			dataset,
		).map((row) => ({
			tenant: String(row.tenant_id),
			fenceToken: String(row.fence_token),
		}));
	}

	/** The fence that covers a tenant: the dataset-wide one, or the tenant's own. */
	fenceCovering(dataset: string, tenant: string): FenceRow | undefined {
		return this.fences(dataset).find(
			(fence) => fence.tenant === "" || fence.tenant === tenant,
		);
	}

	private assertWritable(
		dataset: string,
		mutations: readonly RecordMutation[],
		fenceToken: string | undefined,
	): void {
		const fences = this.fences(dataset);
		if (fences.length === 0) return;
		for (const mutation of mutations) {
			for (const fence of fences) {
				if (
					(fence.tenant === "" || fence.tenant === mutation.tenant) &&
					fence.fenceToken !== fenceToken
				) {
					throw new FencedWriteError(dataset, mutation.tenant);
				}
			}
		}
	}

	private applyMutation(schema: DatasetSchema, mutation: RecordMutation): void {
		const table = quoteIdentifier(schema.name);
		if (mutation.op === "delete" || mutation.record === undefined) {
			this.run(
				`DELETE FROM ${table} WHERE ${this.keyPredicate(schema)}`,
				...this.keyParams(schema, mutation.tenant, mutation.key),
			);
			return;
		}
		const record = mutation.record;
		const declared = new Set(schema.fields.map((field) => field.name));
		const columns = [
			TENANT_COLUMN,
			...schema.fields.map((field) => field.name),
		];
		const values: SQLInputValue[] = [
			mutation.tenant,
			...schema.fields.map((field) =>
				toNative(field, record[field.name] ?? null),
			),
		];
		if (schema.open) {
			const extra: { [key: string]: JsonValue } = {};
			for (const key of Object.keys(record)) {
				if (!declared.has(key)) extra[key] = record[key] ?? null;
			}
			columns.push(EXTRA_COLUMN);
			values.push(canonicalEncode(extra));
		}
		const assignments = columns
			.filter(
				(name) => name !== TENANT_COLUMN && !schema.keyFields.includes(name),
			)
			.map(
				(name) =>
					`${quoteIdentifier(name)} = excluded.${quoteIdentifier(name)}`,
			);
		const conflict = [TENANT_COLUMN, ...schema.keyFields]
			.map(quoteIdentifier)
			.join(", ");
		this.run(
			`INSERT INTO ${table} (${columns.map(quoteIdentifier).join(", ")})
			 VALUES (${columns.map(() => "?").join(", ")})
			 ON CONFLICT (${conflict}) DO ${
					assignments.length === 0
						? "NOTHING"
						: `UPDATE SET ${assignments.join(", ")}`
}`,
			...values,
		);
	}

	/**
	 * The one write path. Fence check, the mutations, and their journal rows
	 * are one transaction: a change is captured if and only if it landed.
	 */
	commit(
		dataset: string,
		mutations: readonly RecordMutation[],
		fenceToken: string | undefined,
		watermark?: { readonly source: string; readonly position: Position },
	): Position {
		const schema = this.schema(dataset);
		return this.transaction(() => {
			this.assertWritable(dataset, mutations, fenceToken);
			for (const mutation of mutations) {
				this.applyMutation(schema, mutation);
				this.run(
					"INSERT INTO hobo_data_journal (dataset, tenant_id, key, op, record) VALUES (?, ?, ?, ?, ?)",
					dataset,
					mutation.tenant,
					mutation.key,
					mutation.op,
					mutation.op === "upsert" && mutation.record !== undefined
						? canonicalEncode(mutation.record)
						: null,
				);
			}
			if (watermark !== undefined) {
				this.run(
					`INSERT INTO hobo_data_watermarks (dataset, source, position) VALUES (?, ?, ?)
					 ON CONFLICT (dataset, source) DO UPDATE SET position = excluded.position`,
					dataset,
					watermark.source,
					watermark.position,
				);
			}
			return String(this.head());
		});
	}

	watermark(dataset: string, source: string): Position | undefined {
		const row = this.get(
			"SELECT position FROM hobo_data_watermarks WHERE dataset = ? AND source = ?",
			dataset,
			source,
		);
		return row === undefined ? undefined : String(row.position);
	}

	// ── journal / capture ─────────────────────────────────────────────────────

	/** Highest journal sequence ever assigned, even after pruning. */
	head(): number {
		const row = this.get(
			"SELECT seq FROM sqlite_sequence WHERE name = 'hobo_data_journal'",
		);
		return row === undefined ? 0 : Number(row.seq);
	}

	/** Highest journal sequence assigned within a scope. */
	headOf(scope: DatasetScope): number {
		const row =
			scope.tenant === ""
				? this.get(
						"SELECT MAX(seq) AS head FROM hobo_data_journal WHERE dataset = ?",
						scope.dataset,
					)
				: this.get(
						"SELECT MAX(seq) AS head FROM hobo_data_journal WHERE dataset = ? AND tenant_id = ?",
						scope.dataset,
						scope.tenant,
					);
		return row === undefined || row.head === null ? 0 : Number(row.head);
	}

	startSubscription(name: string, dataset: string): Position {
		this.schema(dataset);
		const existing = this.get(
			"SELECT start_position FROM hobo_data_subscriptions WHERE name = ?",
			name,
		);
		if (existing !== undefined) return String(existing.start_position);
		const head = this.head();
		this.run(
			"INSERT INTO hobo_data_subscriptions (name, dataset, start_position, ack_position) VALUES (?, ?, ?, ?)",
			name,
			dataset,
			head,
			head,
		);
		return String(head);
	}

	/** Hold the journal from position zero for a reader that keeps its own cursor. */
	pinJournal(name: string, dataset: string): void {
		this.run(
			`INSERT INTO hobo_data_subscriptions (name, dataset, start_position, ack_position)
			 VALUES (?, ?, 0, 0) ON CONFLICT (name) DO NOTHING`,
			name,
			dataset,
		);
	}

	readChanges(
		scope: DatasetScope,
		after: Position,
		limit: number,
	): CaptureBatch {
		const schema = this.schema(scope.dataset);
		const from = Number(after);
		const rows =
			scope.tenant === ""
				? this.all(
						`SELECT seq, tenant_id, key, op, record FROM hobo_data_journal
						 WHERE dataset = ? AND seq > ? ORDER BY seq LIMIT ?`,
						scope.dataset,
						from,
						limit + 1,
					)
				: this.all(
						`SELECT seq, tenant_id, key, op, record FROM hobo_data_journal
						 WHERE dataset = ? AND seq > ? AND tenant_id = ? ORDER BY seq LIMIT ?`,
						scope.dataset,
						from,
						scope.tenant,
						limit + 1,
					);
		const caughtUp = rows.length <= limit;
		const page = rows.slice(0, limit);
		const changes: ChangeEnvelope[] = page.map((row) => {
			const tenant = String(row.tenant_id);
			const key = String(row.key);
			const mutation: RecordMutation =
				row.op === "upsert" && row.record !== null
					? {
							tenant,
							key,
							op: "upsert",
							record: parseCanonicalRecord(
								schema,
								parseJson(String(row.record)),
							),
						}
					: { tenant, key, op: "delete" };
			return envelopeOf(schema, mutation, String(row.seq));
		});
		const last = page[page.length - 1];
		return {
			changes,
			// Caught up means everything to the head was considered, including
			// changes outside this scope; otherwise resume after the last row.
			position: caughtUp
				? String(Math.max(this.head(), from))
				: String(last === undefined ? from : Number(last.seq)),
			caughtUp,
		};
	}

	/** Changes in scope not yet behind a position. */
	pending(scope: DatasetScope, after: Position): number {
		const row =
			scope.tenant === ""
				? this.get(
						"SELECT COUNT(*) AS pending FROM hobo_data_journal WHERE dataset = ? AND seq > ?",
						scope.dataset,
						Number(after),
					)
				: this.get(
						"SELECT COUNT(*) AS pending FROM hobo_data_journal WHERE dataset = ? AND seq > ? AND tenant_id = ?",
						scope.dataset,
						Number(after),
						scope.tenant,
					);
		return row === undefined ? 0 : Number(row.pending);
	}

	/** Record progress and release journal no subscription still needs. */
	acknowledge(name: string, position: Position): void {
		this.run(
			"UPDATE hobo_data_subscriptions SET ack_position = MAX(ack_position, ?) WHERE name = ?",
			Number(position),
			name,
		);
		this.prune();
	}

	stopSubscription(name: string): void {
		this.run("DELETE FROM hobo_data_subscriptions WHERE name = ?", name);
	}

	private prune(): void {
		// With no reader left there is nobody to say what is safe to drop, so
		// nothing is dropped; a later reader may still want the tail.
		const row = this.get(
			"SELECT MIN(ack_position) AS floor, COUNT(*) AS readers FROM hobo_data_subscriptions",
		);
		if (row === undefined || Number(row.readers) === 0 || row.floor === null)
			return;
		this.run("DELETE FROM hobo_data_journal WHERE seq <= ?", Number(row.floor));
	}

	// ── scans ─────────────────────────────────────────────────────────────────

	/** One keyset page of a scope, in (tenant, key) order. */
	page(
		scope: DatasetScope,
		after: readonly SQLInputValue[] | undefined,
		limit: number,
	): KeysetPage {
		const schema = this.schema(scope.dataset);
		const order = [TENANT_COLUMN, ...schema.keyFields].map(quoteIdentifier);
		const predicates: string[] = [];
		const params: SQLInputValue[] = [];
		if (scope.tenant !== "") {
			predicates.push(`${quoteIdentifier(TENANT_COLUMN)} = ?`);
			params.push(scope.tenant);
		}
		if (after !== undefined) {
			predicates.push(
				`(${order.join(", ")}) > (${order.map(() => "?").join(", ")})`,
			);
			params.push(...after);
		}
		const rows = this.all(
			`SELECT * FROM ${quoteIdentifier(scope.dataset)}
			 ${predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`}
			 ORDER BY ${order.join(", ")} LIMIT ?`,
			...params,
			limit,
		);
		const mutations = rows.map((row): RecordMutation => {
			const record = this.rowToRecord(schema, row);
			return {
				tenant: String(row[TENANT_COLUMN]),
				key: encodeRecordKey(schema, record),
				op: "upsert",
				record,
			};
		});
		const lastRow = rows[rows.length - 1];
		return {
			rows: mutations,
			last:
				lastRow === undefined
					? undefined
					: [TENANT_COLUMN, ...schema.keyFields].map((name) => {
							const value = lastRow[name] ?? null;
							// A BLOB cannot be a key column; everything else binds as read.
							return value instanceof Uint8Array ? null : value;
						}),
		};
	}

	digest(scope: DatasetScope, buckets: number): DatasetDigest {
		const builder = new DatasetDigestBuilder(
			scope.dataset,
			scope.tenant,
			buckets,
		);
		let after: readonly SQLInputValue[] | undefined;
		for (;;) {
			const page = this.page(scope, after, 1000);
			for (const row of page.rows) {
				if (row.record !== undefined)
					builder.add(row.tenant, row.key, row.record);
			}
			if (page.rows.length < 1000 || page.last === undefined) break;
			after = page.last;
		}
		return builder.finish();
	}

	count(scope: DatasetScope): number {
		const table = quoteIdentifier(scope.dataset);
		const row =
			scope.tenant === ""
				? this.get(`SELECT COUNT(*) AS total FROM ${table}`)
				: this.get(
						`SELECT COUNT(*) AS total FROM ${table} WHERE ${quoteIdentifier(TENANT_COLUMN)} = ?`,
						scope.tenant,
					);
		return row === undefined ? 0 : Number(row.total);
	}

	// ── fence / retire ────────────────────────────────────────────────────────

	raiseFence(scope: DatasetScope): string {
		this.schema(scope.dataset);
		return this.transaction(() => {
			const existing = this.fences(scope.dataset).find(
				(fence) => fence.tenant === scope.tenant,
			);
			if (existing !== undefined) return existing.fenceToken;
			const fenceToken = `fence:${scope.dataset}:${scope.tenant}:${this.head()}:${this.clock()}`;
			this.run(
				"INSERT INTO hobo_data_fences (dataset, tenant_id, fence_token, fenced_at) VALUES (?, ?, ?, ?)",
				scope.dataset,
				scope.tenant,
				fenceToken,
				this.clock(),
			);
			return fenceToken;
		});
	}

	releaseFence(scope: DatasetScope, fenceToken: string): void {
		const existing = this.fences(scope.dataset).find(
			(fence) => fence.tenant === scope.tenant,
		);
		if (existing === undefined) return;
		if (existing.fenceToken !== fenceToken) {
			throw new DataCoreError(
				"FENCE_TOKEN_MISMATCH",
				"only the fence token holder may release a fence",
				{ detail: { dataset: scope.dataset } },
			);
		}
		this.run(
			"DELETE FROM hobo_data_fences WHERE dataset = ? AND tenant_id = ?",
			scope.dataset,
			scope.tenant,
		);
	}

	isFenced(scope: DatasetScope): boolean {
		return this.fences(scope.dataset).some(
			(fence) => fence.tenant === scope.tenant,
		);
	}

	/**
	 * Destructive. Refused unless the caller holds the raised fence and the
	 * scope still digests to the verified value. A physical reap, so it is not
	 * journaled: nothing downstream should replay it as a logical delete.
	 */
	retire(
		scope: DatasetScope,
		fenceToken: string,
		expected: DatasetDigest,
	): number {
		return this.transaction(() => {
			const fence = this.fences(scope.dataset).find(
				(entry) => entry.tenant === scope.tenant,
			);
			if (fence === undefined || fence.fenceToken !== fenceToken) {
				throw new DataCoreError(
					"RETIRE_REFUSED",
					"retire needs the raised fence's token; the store may still be authoritative",
					{ detail: { dataset: scope.dataset } },
				);
			}
			const current = this.digest(scope, expected.buckets.length);
			if (
				current.count !== expected.count ||
				current.digest !== expected.digest
			) {
				throw new DataCoreError(
					"RETIRE_REFUSED",
					"the store no longer matches the verified digest",
					{ detail: { dataset: scope.dataset } },
				);
			}
			const table = quoteIdentifier(scope.dataset);
			return scope.tenant === ""
				? this.run(`DELETE FROM ${table}`)
				: this.run(
						`DELETE FROM ${table} WHERE ${quoteIdentifier(TENANT_COLUMN)} = ?`,
						scope.tenant,
					);
		});
	}
}
