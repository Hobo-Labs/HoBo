import {
	createHash,
	createPublicKey,
	KeyObject,
	randomUUID,
	verify,
} from "node:crypto";
import {
	DatabaseSync,
	type SQLInputValue,
	type SQLOutputValue,
	type StatementSync,
} from "node:sqlite";
import {
	type CanonicalRecord,
	type CaptureBatch,
	CapturePositionError,
	type ChangeEnvelope,
	canonicalEncode,
	canonicalFenceOperationReceipt,
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
	type FenceOperationClaim,
	type FenceOperationObservation,
	type FenceOperationReceipt,
	fenceTokenDigest,
	type JsonObject,
	type JsonValue,
	type Position,
	parseCanonicalRecord,
	parseDatasetSchema,
	type RecordMutation,
	StaleApplyError,
	schemaDigest,
} from "@hobo/data-core";

const tagOf = Object.prototype.toString;

type Row = Record<string, SQLOutputValue>;

const EXTRA_COLUMN = "hobo_extra";
const TENANT_COLUMN = "tenant_id";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/**
 * Table names a dataset may not take: this binding's own metadata tables and
 * SQLite's internal ones. A dataset named after the fence table would hand
 * the records port every fence token, and the means to delete a fence.
 */
const RESERVED_TABLE_PREFIXES: readonly string[] = Object.freeze([
	"hobo_data_",
	"sqlite_",
]);
const POSITION = /^(0|[1-9][0-9]*)$/u;

function assertNotReserved(dataset: string): void {
	const name = dataset.toLowerCase();
	if (RESERVED_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
		throw new DataCoreError(
			"INVALID_DATASET_SCHEMA",
			`dataset name ${dataset} is reserved by the SQLite binding`,
			{ detail: { dataset } },
		);
	}
}

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
			return canonicalEncode(value);
		case "string": {
			const text = String(value);
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
	readonly path: string;
	readonly clock?: () => string;
	readonly operationReceivers?: ReadonlyMap<
		string,
		string | Buffer | KeyObject
	>;
}

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
	private readonly operationReceivers: ReadonlyMap<
		string,
		{ key: KeyObject; digest: string }
	>;

	constructor(options: SqliteStoreOptions) {
		this.path = options.path;
		this.clock = options.clock ?? (() => new Date().toISOString());
		this.operationReceivers = new Map(
			[...(options.operationReceivers ?? [])].map(([id, value]) => {
				const key = value instanceof KeyObject ? value : createPublicKey(value);
				if (
					!id ||
					id.length > 512 ||
					id !== id.trim() ||
					/\p{Cc}/u.test(id) ||
					key.type !== "public" ||
					key.asymmetricKeyType !== "ed25519"
				)
					throw new Error("invalid native fence receiver enrollment");
				return [
					id,
					{
						key,
						digest: createHash("sha256")
							.update(key.export({ type: "spki", format: "der" }))
							.digest("hex"),
					},
				] as const;
			}),
		);
		this.db = new DatabaseSync(options.path);
		try {
			this.bootstrap();
			this.transaction(() => {
				const policy = this.get(
					"SELECT id FROM hobo_data_fence_policy WHERE id = 1",
				);
				if (!policy && this.operationReceivers.size) {
					this.run("INSERT INTO hobo_data_fence_policy (id) VALUES (1)");
					for (const [id, receiver] of this.operationReceivers)
						this.run(
							"INSERT INTO hobo_data_fence_receivers (key_id, key_digest) VALUES (?, ?)",
							id,
							receiver.digest,
						);
				} else if (policy && this.operationReceivers.size) {
					const enrolled = this.all(
						"SELECT key_id, key_digest FROM hobo_data_fence_receivers",
					);
					if (
						enrolled.length !== this.operationReceivers.size ||
						enrolled.some(
							(row) =>
								this.operationReceivers.get(String(row.key_id))?.digest !==
								row.key_digest,
						)
					)
						throw new Error(
							"native fence receiver policy differs from its durable enrollment",
						);
				}
			});
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	private bootstrap(): void {
		this.db.exec("PRAGMA secure_delete = ON");
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
				record TEXT,
				tx INTEGER
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
			CREATE TABLE IF NOT EXISTS hobo_data_fence_operations (
				dataset TEXT NOT NULL,
				tenant_id TEXT NOT NULL,
				operation_id TEXT NOT NULL,
				route_digest TEXT NOT NULL,
				receiver_key_id TEXT NOT NULL,
				receiver_key_digest TEXT NOT NULL,
				fence_token_digest TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('held', 'completed')),
				PRIMARY KEY (dataset, tenant_id, operation_id)
			);
			CREATE UNIQUE INDEX IF NOT EXISTS hobo_data_one_held_fence_operation
				ON hobo_data_fence_operations (dataset, tenant_id) WHERE status = 'held';
			CREATE TABLE IF NOT EXISTS hobo_data_fence_policy (id INTEGER PRIMARY KEY CHECK (id = 1));
			CREATE TABLE IF NOT EXISTS hobo_data_fence_receivers (key_id TEXT PRIMARY KEY, key_digest TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS hobo_data_subscriptions (
				name TEXT PRIMARY KEY,
				dataset TEXT NOT NULL,
				tenant_id TEXT,
				start_position INTEGER NOT NULL,
				ack_position INTEGER NOT NULL
			);
		`);
		const bound = this.db
			.prepare(
				"SELECT 1 AS present FROM pragma_table_info('hobo_data_subscriptions') WHERE name = 'tenant_id'",
			)
			.get();
		if (bound === undefined) {
			this.db.exec(
				"ALTER TABLE hobo_data_subscriptions ADD COLUMN tenant_id TEXT",
			);
		}
		const marked = this.db
			.prepare(
				"SELECT 1 AS present FROM pragma_table_info('hobo_data_journal') WHERE name = 'tx'",
			)
			.get();
		if (marked === undefined) {
			this.db.exec("ALTER TABLE hobo_data_journal ADD COLUMN tx INTEGER");
		}
		const unowed = this.get(
			"SELECT seq FROM hobo_data_journal WHERE seq <= ? LIMIT 1",
			this.journalFloor(),
		);
		if (unowed !== undefined) this.prune();
	}

	connection(): DatabaseSync {
		return this.db;
	}

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
		prepared.setReadBigInts(true);
		this.statements.set(sql, prepared);
		return prepared;
	}

	private all(sql: string, ...params: SQLInputValue[]): Row[] {
		return this.statement(sql).all(...params) as Row[];
	}

	private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
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
		assertNotReserved(name);
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

	ensure(schema: DatasetSchema, serialized: JsonObject): boolean {
		assertNotReserved(schema.name);
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

	private rowToRecord(schema: DatasetSchema, row: Row): CanonicalRecord {
		// Entries, not property assignment or Object.assign: either would treat
		// an undeclared field named `__proto__` as the prototype and drop it.
		const entries: [string, JsonValue][] = schema.fields.map((field) => [
			field.name,
			fromNative(field, row[field.name] ?? null),
		]);
		const extra = row[EXTRA_COLUMN];
		if (schema.open && isText(extra)) {
			const parsed = parseJson(extra);
			if (parsed !== null && tagOf.call(parsed) === "[object Object]") {
				entries.push(...Object.entries(parsed as JsonObject));
			}
		}
		return parseCanonicalRecord(schema, Object.fromEntries(entries));
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

	private assertWritable(
		dataset: string,
		mutations: readonly RecordMutation[],
		fenceToken: string | undefined,
	): void {
		for (const tenant of new Set(mutations.map((mutation) => mutation.tenant)))
			this.assertNoFenceOperation({ dataset, tenant });
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
			// Entries again: assigning a field named `__proto__` would drop it
			// here while the journal still carried it.
			const extra = Object.fromEntries(
				Object.entries(record).filter(([key]) => !declared.has(key)),
			);
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
	 * The one constructor for a mutation this store will apply. The record is
	 * parsed again rather than trusted, and the key must be the canonical key:
	 * a caller's uppercase uuid and its canonical lowercase would otherwise be
	 * two rows that read back under one key, and a mutation whose key named a
	 * different record than it carried would land under the record's.
	 */
	private parseMutation(
		schema: DatasetSchema,
		mutation: RecordMutation,
	): RecordMutation {
		const refuse = (message: string): never => {
			throw new DataCoreError("INVALID_RECORD", message, {
				detail: { dataset: schema.name, field: "key" },
			});
		};
		if (mutation.op === "delete") {
			const key = encodeRecordKey(
				schema,
				decodeRecordKey(schema, mutation.key),
			);
			if (key !== mutation.key) {
				refuse("a delete must name its record by the canonical key");
			}
			return { tenant: mutation.tenant, key, op: "delete" };
		}
		const record = parseCanonicalRecord(schema, mutation.record);
		const key = encodeRecordKey(schema, record);
		if (key !== mutation.key) {
			refuse("a mutation's key must be the canonical key of its record");
		}
		return { tenant: mutation.tenant, key, op: "upsert", record };
	}

	commit(
		dataset: string,
		requested: readonly RecordMutation[],
		fenceToken: string | undefined,
		watermark?: {
			readonly source: string;
			readonly position: Position;
			readonly expected?: Position | null;
		},
	): Position {
		const schema = this.schema(dataset);
		const mutations = requested.map((mutation) =>
			this.parseMutation(schema, mutation),
		);
		return this.transaction(() => {
			this.assertWritable(dataset, mutations, fenceToken);
			if (watermark !== undefined)
				this.assertNoFenceOperation({ dataset, tenant: "" });
			if (
				watermark?.expected !== undefined &&
				(this.watermark(dataset, watermark.source) ?? null) !==
					watermark.expected
			) {
				throw new StaleApplyError(dataset, watermark.source);
			}
			const tx = this.head();
			for (const mutation of mutations) {
				this.applyMutation(schema, mutation);
				this.run(
					"INSERT INTO hobo_data_journal (dataset, tenant_id, key, op, record, tx) VALUES (?, ?, ?, ?, ?, ?)",
					dataset,
					mutation.tenant,
					mutation.key,
					mutation.op,
					mutation.record === undefined
						? null
						: canonicalEncode(mutation.record),
					tx,
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
			this.prune();
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

	/** Highest journal sequence ever assigned, even after pruning. */
	head(): number {
		const row = this.get(
			"SELECT seq FROM sqlite_sequence WHERE name = 'hobo_data_journal'",
		);
		return row === undefined ? 0 : Number(row.seq);
	}

	journalFloor(): number {
		const head = this.head();
		const row = this.get(
			"SELECT MIN(ack_position) AS floor FROM hobo_data_subscriptions",
		);
		return row === undefined || row.floor === null
			? head
			: Math.min(Number(row.floor), head);
	}

	private parsePosition(position: Position, subscription = ""): number {
		const head = this.head();
		if (!POSITION.test(position) || !(Number(position) <= head)) {
			throw new CapturePositionError(
				subscription,
				`a capture position for this store is a journal sequence from 0 to its head, ${head}`,
			);
		}
		return Number(position);
	}

	private parseReadPosition(after: Position): number {
		const from = this.parsePosition(after);
		const floor = this.journalFloor();
		if (from < floor) {
			throw new CapturePositionError(
				"",
				`changes at or before ${floor} were released; the journal cannot be read from ${from}`,
			);
		}
		return from;
	}

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

	startSubscription(name: string, scope: DatasetScope): Position {
		this.schema(scope.dataset);
		return this.transaction(() => {
			this.assertNoFenceOperation(scope);
			const existing = this.get(
				"SELECT dataset, tenant_id, start_position FROM hobo_data_subscriptions WHERE name = ?",
				name,
			);
			if (existing !== undefined) {
				const bound = existing.tenant_id;
				if (
					String(existing.dataset) !== scope.dataset ||
					(bound !== null && String(bound) !== scope.tenant)
				) {
					throw new DataCoreError(
						"CAPTURE_SUBSCRIPTION_CONFLICT",
						`subscription ${name} is bound to another scope`,
						{ detail: { subscription: name } },
					);
				}
				if (bound === null) {
					this.run(
						"UPDATE hobo_data_subscriptions SET tenant_id = ? WHERE name = ? AND tenant_id IS NULL",
						scope.tenant,
						name,
					);
				}
				return String(existing.start_position);
			}
			const head = this.head();
			this.run(
				"INSERT INTO hobo_data_subscriptions (name, dataset, tenant_id, start_position, ack_position) VALUES (?, ?, ?, ?, ?)",
				name,
				scope.dataset,
				scope.tenant,
				head,
				head,
			);
			return String(head);
		});
	}

	pinJournal(name: string, dataset: string): void {
		this.transaction(() => {
			this.assertNoFenceOperation({ dataset, tenant: "" });
			const floor = this.journalFloor();
			this.run(
				`INSERT INTO hobo_data_subscriptions (name, dataset, start_position, ack_position)
			 VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING`,
				name,
				dataset,
				floor,
				floor,
			);
		});
	}

	readChanges(
		scope: DatasetScope,
		after: Position,
		limit: number,
	): CaptureBatch {
		const schema = this.schema(scope.dataset);
		const from = this.parseReadPosition(after);
		const inScope =
			scope.tenant === "" ? "dataset = ?" : "dataset = ? AND tenant_id = ?";
		const scopeParams: SQLInputValue[] =
			scope.tenant === "" ? [scope.dataset] : [scope.dataset, scope.tenant];
		const select = `SELECT seq, tenant_id, key, op, record, tx FROM hobo_data_journal WHERE ${inScope}`;
		const rows = this.all(
			`${select} AND seq > ? ORDER BY seq LIMIT ?`,
			...scopeParams,
			from,
			limit + 1,
		);
		let caughtUp = rows.length <= limit;
		let page = rows.slice(0, limit);
		const boundary = page[page.length - 1];
		const tx = boundary?.tx ?? null;
		if (boundary !== undefined && tx !== null && rows[limit]?.tx === tx) {
			page = [
				...page,
				...this.all(
					`${select} AND tx = ? AND seq > ? ORDER BY seq`,
					...scopeParams,
					Number(tx),
					Number(boundary.seq),
				),
			];
			caughtUp =
				this.get(
					`SELECT seq FROM hobo_data_journal WHERE ${inScope} AND seq > ? LIMIT 1`,
					...scopeParams,
					Number(page[page.length - 1]?.seq ?? boundary.seq),
				) === undefined;
		}
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
			position: caughtUp
				? String(this.head())
				: String(last === undefined ? from : Number(last.seq)),
			caughtUp,
		};
	}

	pending(scope: DatasetScope, after: Position): number {
		const from = this.parseReadPosition(after);
		const row =
			scope.tenant === ""
				? this.get(
						"SELECT COUNT(*) AS pending FROM hobo_data_journal WHERE dataset = ? AND seq > ?",
						scope.dataset,
						from,
					)
				: this.get(
						"SELECT COUNT(*) AS pending FROM hobo_data_journal WHERE dataset = ? AND seq > ? AND tenant_id = ?",
						scope.dataset,
						from,
						scope.tenant,
					);
		return row === undefined ? 0 : Number(row.pending);
	}

	acknowledge(name: string, position: Position): void {
		this.transaction(() => {
			const subscription = this.get(
				"SELECT dataset, tenant_id FROM hobo_data_subscriptions WHERE name = ?",
				name,
			);
			if (subscription)
				this.assertNoFenceOperation({
					dataset: String(subscription.dataset),
					tenant: String(subscription.tenant_id ?? ""),
				});
			this.run(
				"UPDATE hobo_data_subscriptions SET ack_position = MAX(ack_position, ?) WHERE name = ?",
				this.parsePosition(position, name),
				name,
			);
			this.prune();
		});
	}

	stopSubscription(name: string): void {
		this.transaction(() => {
			const subscription = this.get(
				"SELECT dataset, tenant_id FROM hobo_data_subscriptions WHERE name = ?",
				name,
			);
			if (subscription)
				this.assertNoFenceOperation({
					dataset: String(subscription.dataset),
					tenant: String(subscription.tenant_id ?? ""),
				});
			this.run("DELETE FROM hobo_data_subscriptions WHERE name = ?", name);
			this.prune();
		});
	}

	private prune(): void {
		this.run(
			`DELETE FROM hobo_data_journal WHERE seq <= ? AND NOT EXISTS (
				SELECT 1 FROM hobo_data_fence_operations AS held
				WHERE held.status = 'held' AND held.dataset = hobo_data_journal.dataset
				AND (held.tenant_id = '' OR held.tenant_id = hobo_data_journal.tenant_id)
			)`,
			this.journalFloor(),
		);
	}

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

	operationFenceEnabled(): boolean {
		return (
			this.get("SELECT id FROM hobo_data_fence_policy WHERE id = 1") !==
			undefined
		);
	}

	private assertNoFenceOperation(scope: DatasetScope): void {
		const held = this.get(
			"SELECT operation_id FROM hobo_data_fence_operations WHERE dataset = ? AND status = 'held' AND (tenant_id = '' OR ? = '' OR tenant_id = ?) LIMIT 1",
			scope.dataset,
			scope.tenant,
			scope.tenant,
		);
		if (held)
			throw new DataCoreError(
				"FENCE_OPERATION_HELD",
				"native fence operation is still held",
			);
	}

	claimFenceOperation(input: {
		scope: DatasetScope;
		fenceToken: string;
		operationId: string;
		routeDigest: string;
		receiverKeyId: string;
	}): FenceOperationClaim {
		const { dataset, tenant } = input.scope;
		const key = this.operationReceivers.get(input.receiverKeyId);
		if (!key)
			throw new DataCoreError(
				"FENCE_OPERATION_UNTRUSTED",
				"native fence receiver is not enrolled",
			);
		const claim = Object.freeze({
			scope: Object.freeze({ dataset, tenant }),
			operationId: input.operationId,
			routeDigest: input.routeDigest,
			receiverKeyId: input.receiverKeyId,
			fenceTokenDigest: fenceTokenDigest(input.fenceToken),
		});
		canonicalFenceOperationReceipt({
			...claim,
			contract: "hobo.fence-operation-receipt/v1",
			outcome: "committed",
		});
		return this.transaction(() => {
			const fence = this.fences(dataset).find((row) => row.tenant === tenant);
			if (!fence || fence.fenceToken !== input.fenceToken)
				throw new DataCoreError(
					"FENCE_TOKEN_MISMATCH",
					"native fence token is no longer current",
				);
			const prior = this.get(
				"SELECT route_digest, receiver_key_id, receiver_key_digest, fence_token_digest, status FROM hobo_data_fence_operations WHERE dataset = ? AND tenant_id = ? AND operation_id = ?",
				dataset,
				tenant,
				claim.operationId,
			);
			if (prior) {
				if (
					prior.status !== "held" ||
					prior.route_digest !== claim.routeDigest ||
					prior.receiver_key_id !== claim.receiverKeyId ||
					prior.receiver_key_digest !== key.digest ||
					prior.fence_token_digest !== claim.fenceTokenDigest
				)
					throw new DataCoreError(
						"FENCE_OPERATION_CONFLICT",
						"native fence operation identity was already used",
					);
				return claim;
			}
			this.assertNoFenceOperation(claim.scope);
			this.run(
				"INSERT INTO hobo_data_fence_operations (dataset, tenant_id, operation_id, route_digest, receiver_key_id, receiver_key_digest, fence_token_digest, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'held')",
				dataset,
				tenant,
				claim.operationId,
				claim.routeDigest,
				claim.receiverKeyId,
				key.digest,
				claim.fenceTokenDigest,
			);
			return claim;
		});
	}

	completeFenceOperation(input: FenceOperationReceipt): void {
		const { signature, ...body } = input;
		const payload = canonicalFenceOperationReceipt(body);
		const {
			scope,
			operationId,
			routeDigest,
			receiverKeyId,
			fenceTokenDigest: tokenDigest,
		} = body;
		const key = this.operationReceivers.get(receiverKeyId);
		if (
			!key ||
			!/^[A-Za-z0-9_-]{86}$/u.test(signature) ||
			Buffer.from(signature, "base64url").toString("base64url") !== signature ||
			!verify(
				null,
				Buffer.from(payload),
				key.key,
				Buffer.from(signature, "base64url"),
			)
		)
			throw new DataCoreError(
				"FENCE_OPERATION_UNTRUSTED",
				"native fence operation receipt is untrusted",
			);
		this.transaction(() => {
			const row = this.get(
				"SELECT route_digest, receiver_key_id, receiver_key_digest, fence_token_digest, status FROM hobo_data_fence_operations WHERE dataset = ? AND tenant_id = ? AND operation_id = ?",
				scope.dataset,
				scope.tenant,
				operationId,
			);
			if (
				!row ||
				row.route_digest !== routeDigest ||
				row.receiver_key_id !== receiverKeyId ||
				row.receiver_key_digest !== key.digest ||
				row.fence_token_digest !== tokenDigest
			)
				throw new DataCoreError(
					"FENCE_OPERATION_CONFLICT",
					"native fence operation receipt has a foreign scope",
				);
			if (row.status === "completed") return;
			const fence = this.fences(scope.dataset).find(
				(entry) => entry.tenant === scope.tenant,
			);
			if (
				row.status !== "held" ||
				!fence ||
				fenceTokenDigest(fence.fenceToken) !== tokenDigest
			)
				throw new DataCoreError(
					"FENCE_TOKEN_MISMATCH",
					"native fence changed before operation completion",
				);
			this.run(
				"UPDATE hobo_data_fence_operations SET status = 'completed' WHERE dataset = ? AND tenant_id = ? AND operation_id = ?",
				scope.dataset,
				scope.tenant,
				operationId,
			);
		});
	}

	inspectFenceOperation(
		scope: DatasetScope,
		operationId?: string,
	): FenceOperationObservation | undefined {
		const row =
			operationId === undefined
				? this.get(
						"SELECT operation_id, route_digest, receiver_key_id, fence_token_digest, status FROM hobo_data_fence_operations WHERE dataset = ? AND tenant_id = ? AND status = 'held'",
						scope.dataset,
						scope.tenant,
					)
				: this.get(
						"SELECT operation_id, route_digest, receiver_key_id, fence_token_digest, status FROM hobo_data_fence_operations WHERE dataset = ? AND tenant_id = ? AND operation_id = ?",
						scope.dataset,
						scope.tenant,
						operationId,
					);
		if (!row) return undefined;
		if (row.status !== "held" && row.status !== "completed")
			throw new DataCoreError(
				"FENCE_OPERATION_CONFLICT",
				"native fence operation is malformed",
			);
		return Object.freeze({
			status: row.status,
			claim: Object.freeze({
				scope: Object.freeze({ ...scope }),
				operationId: String(row.operation_id),
				routeDigest: String(row.route_digest),
				receiverKeyId: String(row.receiver_key_id),
				fenceTokenDigest: String(row.fence_token_digest),
			}),
		});
	}

	raiseFence(scope: DatasetScope): string {
		this.schema(scope.dataset);
		return this.transaction(() => {
			const existing = this.fences(scope.dataset).find(
				(fence) => fence.tenant === scope.tenant,
			);
			if (existing !== undefined) return existing.fenceToken;
			this.assertNoFenceOperation(scope);
			// Random, never derived: a token built from the scope, the head and
			// the clock repeats when a fence is released and raised again, and
			// the previous holder would pass the new fence.
			const fenceToken = randomUUID();
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
		this.transaction(() => {
			this.assertNoFenceOperation(scope);
			const existing = this.fences(scope.dataset).find(
				(fence) => fence.tenant === scope.tenant,
			);
			if (existing === undefined) return;
			if (existing.fenceToken !== fenceToken)
				throw new DataCoreError(
					"FENCE_TOKEN_MISMATCH",
					"only the fence token holder may release a fence",
					{ detail: { dataset: scope.dataset } },
				);
			this.run(
				"DELETE FROM hobo_data_fences WHERE dataset = ? AND tenant_id = ?",
				scope.dataset,
				scope.tenant,
			);
		});
	}

	isFenced(scope: DatasetScope): boolean {
		return this.fences(scope.dataset).some(
			(fence) => fence.tenant === scope.tenant,
		);
	}

	retire(
		scope: DatasetScope,
		fenceToken: string,
		expected: DatasetDigest,
	): number {
		return this.transaction(() => {
			this.assertNoFenceOperation(scope);
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
			if (current.count === 0) return 0;
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
			if (scope.tenant === "") {
				this.run(
					"DELETE FROM hobo_data_journal WHERE dataset = ?",
					scope.dataset,
				);
				return this.run(`DELETE FROM ${table}`);
			}
			this.run(
				"DELETE FROM hobo_data_journal WHERE dataset = ? AND tenant_id = ?",
				scope.dataset,
				scope.tenant,
			);
			return this.run(
				`DELETE FROM ${table} WHERE ${quoteIdentifier(TENANT_COLUMN)} = ?`,
				scope.tenant,
			);
		});
	}
}
