/**
 * The dataset store: everything the record-shaped ports do against real
 * tables. One class so the ports share one bootstrap, one schema cache, and
 * one write path — the fence and the capture log both depend on there being
 * exactly one way a record gets written.
 */
import { randomUUID } from "node:crypto";
import {
	type CanonicalRecord,
	canonicalEncode,
	DataCoreError,
	type DatasetDigest,
	DatasetDigestBuilder,
	type DatasetSchema,
	type DatasetScope,
	decodeRecordKey,
	encodeRecordKey,
	FencedWriteError,
	type JsonValue,
	parseCanonicalRecord,
	parseDatasetSchema,
	type RecordMutation,
	StaleApplyError,
	schemaDigest,
	schemaToJson,
	upsertMutation,
} from "@hobo/data-core";
import {
	type PostgresExecutor,
	type PostgresParameter,
	type PostgresRow,
	sqlStateOf,
} from "./executor.js";
import {
	METADATA_TABLES,
	OPEN_FIELDS_COLUMN,
	qualifiedName,
	quoteIdentifier,
	RESERVED_TABLE_NAMES,
	TENANT_COLUMN,
} from "./identifiers.js";
import {
	BOOTSTRAP_MARKER,
	bootstrapProbe,
	bootstrapStatements,
	type DatasetStatements,
	datasetStatements,
	FENCE_TOKEN_SETTING,
	FENCED_WRITE_SQLSTATE,
	guardStatements,
} from "./statements.js";
import {
	assertNoReservedColumns,
	assertStorableText,
	canonicalFromNative,
	datasetTableDdl,
	encodeParameter,
	keyFieldsOf,
	openFieldsOf,
} from "./types.js";

/** A dataset as the store holds it: the schema and its prepared statements. */
export interface StoredDataset {
	readonly schema: DatasetSchema;
	readonly statements: DatasetStatements;
}

/** One stored record with the scope coordinates it lives at. */
export interface StoredRecord {
	readonly tenant: string;
	readonly key: string;
	readonly record: CanonicalRecord;
}

const DUPLICATE_TABLE = "42P07";
const UNIQUE_VIOLATION = "23505";

function parseJsonText(text: string): JsonValue {
	// SAFETY: JSON.parse yields a JSON value at this document boundary.
	return JSON.parse(text) as JsonValue;
}

function missingDataset(name: string): DataCoreError {
	return new DataCoreError("INVALID_RECORD", `dataset ${name} does not exist`, {
		detail: { dataset: name },
	});
}

/**
 * Rethrow a refused write as what the contract calls it. The fence trigger's
 * SQLSTATE becomes `FencedWriteError`; a value the server would not store
 * becomes `INVALID_RECORD`. Anything else is rethrown unchanged — a
 * serialization failure or a lost connection is the caller's to retry, not
 * ours to relabel.
 */
export function rethrowWriteError(
	cause: unknown,
	dataset: string,
	tenant: string,
): never {
	const state = sqlStateOf(cause);
	if (state === FENCED_WRITE_SQLSTATE) {
		throw new FencedWriteError(dataset, tenant);
	}
	// Class 22 is a data exception (a value out of range, a byte the encoding
	// forbids); 23502 and 23514 are a NULL or a value a constraint refuses.
	if (
		state !== undefined &&
		(state.startsWith("22") || state === "23502" || state === "23514")
	) {
		// The server's message can quote the offending value, so only the
		// SQLSTATE is carried forward.
		throw new DataCoreError(
			"INVALID_RECORD",
			`the server refused a value for ${dataset} (SQLSTATE ${state}); nothing was stored`,
			{ detail: { dataset, sqlState: state } },
		);
	}
	throw cause;
}

export interface DatasetStoreOptions {
	readonly executor: PostgresExecutor;
	readonly namespace: string;
	readonly pageSize: number;
}

export class DatasetStore {
	readonly executor: PostgresExecutor;
	readonly namespace: string;
	private readonly pageSize: number;
	private readonly known = new Map<string, StoredDataset>();
	private bootstrap: Promise<string> | undefined;

	constructor(options: DatasetStoreOptions) {
		this.executor = options.executor;
		this.namespace = options.namespace;
		this.pageSize = options.pageSize;
	}

	meta(table: keyof typeof METADATA_TABLES): string {
		return qualifiedName(this.namespace, METADATA_TABLES[table]);
	}

	/** True once this store has reached the server at all. */
	get touched(): boolean {
		return this.bootstrap !== undefined;
	}

	/**
	 * Make sure the namespace, the metadata tables and the trigger functions
	 * exist, once, and answer the database name.
	 */
	ready(): Promise<string> {
		this.bootstrap ??= this.bootstrapOnce().catch((cause) => {
			// A failed bootstrap is retried by the next call, not remembered.
			this.bootstrap = undefined;
			throw cause;
		});
		return this.bootstrap;
	}

	private async bootstrapOnce(): Promise<string> {
		// One read answers whether the namespace is already bootstrapped, so a
		// binding opened against an existing store runs no DDL at all.
		const probe = await this.executor.query(
			"SELECT current_database()::text AS database, obj_description(to_regprocedure($1::text), 'pg_proc') AS marker",
			[bootstrapProbe(this.namespace)],
		);
		const database = probe.rows[0]?.database ?? "";
		if (probe.rows[0]?.marker === BOOTSTRAP_MARKER) return database;
		await this.executor.transaction(async (tx) => {
			// Serialised across bindings, so two processes starting together
			// do not race on the same DDL.
			await tx.query(
				"SELECT pg_advisory_xact_lock(hashtext($1::text))::text AS locked",
				[`hobo-data:${this.namespace}`],
			);
			for (const statement of bootstrapStatements(this.namespace)) {
				await tx.query(statement);
			}
		});
		return database;
	}

	/** Drop the namespace and everything in it. Only an ephemeral close does this. */
	async dropNamespace(): Promise<void> {
		this.known.clear();
		this.bootstrap = undefined;
		await this.executor.query(
			`DROP SCHEMA IF EXISTS ${quoteIdentifier(this.namespace)} CASCADE`,
		);
	}

	// ── datasets ──────────────────────────────────────────────────────────────

	private async load(name: string): Promise<StoredDataset | undefined> {
		await this.ready();
		const result = await this.executor.query(
			`SELECT schema_json FROM ${this.meta("datasets")} WHERE dataset = $1::text`,
			[name],
		);
		const text = result.rows[0]?.schema_json;
		if (text === null || text === undefined) {
			this.known.delete(name);
			return undefined;
		}
		const schema = parseDatasetSchema(parseJsonText(text));
		const stored: StoredDataset = {
			schema,
			statements: datasetStatements(this.namespace, schema),
		};
		this.known.set(name, stored);
		return stored;
	}

	async describe(name: string): Promise<DatasetSchema | undefined> {
		return (await this.load(name))?.schema;
	}

	/** The dataset, or the contract's error for an absent one. */
	async dataset(name: string): Promise<StoredDataset> {
		const stored = this.known.get(name) ?? (await this.load(name));
		if (stored === undefined) throw missingDataset(name);
		return stored;
	}

	private differs(schema: DatasetSchema): DataCoreError {
		return new DataCoreError(
			"INVALID_DATASET_SCHEMA",
			`dataset ${schema.name} exists with a different schema`,
			{ detail: { dataset: schema.name } },
		);
	}

	async ensure(schema: DatasetSchema): Promise<boolean> {
		assertNoReservedColumns(schema);
		if (RESERVED_TABLE_NAMES.includes(schema.name)) {
			throw new DataCoreError(
				"INVALID_DATASET_SCHEMA",
				`dataset name ${schema.name} is reserved by the PostgreSQL binding`,
				{ detail: { dataset: schema.name } },
			);
		}
		const existing = await this.load(schema.name);
		if (existing !== undefined) {
			if (schemaDigest(existing.schema) !== schemaDigest(schema)) {
				throw this.differs(schema);
			}
			return false;
		}
		try {
			await this.executor.transaction(async (tx) => {
				await tx.query(datasetTableDdl(this.namespace, schema));
				for (const statement of guardStatements(this.namespace, schema.name)) {
					await tx.query(statement);
				}
				await tx.query(
					`INSERT INTO ${this.meta("datasets")} (dataset, schema_json, schema_digest) VALUES ($1::text, $2::text, $3::text)`,
					[
						schema.name,
						JSON.stringify(schemaToJson(schema)),
						schemaDigest(schema),
					],
				);
			});
		} catch (cause) {
			const state = sqlStateOf(cause);
			if (state !== DUPLICATE_TABLE && state !== UNIQUE_VIOLATION) throw cause;
			// Either another binding created the dataset first, or a table of
			// that name exists that is not a dataset. Only the former is fine.
			const raced = await this.load(schema.name);
			if (raced === undefined) {
				throw new DataCoreError(
					"INVALID_DATASET_SCHEMA",
					`a table named ${schema.name} already exists and is not a dataset`,
					{ cause, detail: { dataset: schema.name } },
				);
			}
			if (schemaDigest(raced.schema) !== schemaDigest(schema)) {
				throw this.differs(schema);
			}
			return false;
		}
		await this.load(schema.name);
		return true;
	}

	// ── conversion ────────────────────────────────────────────────────────────

	private stored(schema: DatasetSchema, row: PostgresRow): StoredRecord {
		const record = canonicalFromNative(
			schema,
			(column) => row[column],
			"select",
		);
		return {
			tenant: row[TENANT_COLUMN] ?? "",
			key: encodeRecordKey(schema, record),
			record,
		};
	}

	private keyParameters(
		schema: DatasetSchema,
		key: string,
	): PostgresParameter[] {
		const values = decodeRecordKey(schema, key);
		return keyFieldsOf(schema).map((field) =>
			encodeParameter(field.type, values[field.name] ?? null, field.name),
		);
	}

	private upsertParameters(
		schema: DatasetSchema,
		mutation: RecordMutation,
	): PostgresParameter[] {
		const record = parseCanonicalRecord(schema, mutation.record);
		const claimed = canonicalEncode(
			schema.keyFields.map(
				(name) => decodeRecordKey(schema, mutation.key)[name] ?? null,
			),
		);
		if (claimed !== encodeRecordKey(schema, record)) {
			// A typed table keys a row by its key columns. A mutation whose key
			// disagrees with its own record would land somewhere other than
			// where its key says, so it is refused.
			throw new DataCoreError(
				"INVALID_RECORD",
				"a mutation's key must be the key of its record",
				{ detail: { dataset: schema.name, field: "key" } },
			);
		}
		return [
			mutation.tenant,
			...schema.fields.map((field) =>
				encodeParameter(field.type, record[field.name] ?? null, field.name),
			),
			...(schema.open
				? [
						encodeParameter(
							"json",
							openFieldsOf(schema, record),
							OPEN_FIELDS_COLUMN,
						),
					]
				: []),
		];
	}

	// ── the one write path ────────────────────────────────────────────────────

	/** Present the fence token to the trigger, for this transaction only. */
	private async present(
		tx: PostgresExecutor,
		fenceToken: string | undefined,
	): Promise<void> {
		if (fenceToken === undefined) return;
		await tx.query(
			`SELECT set_config('${FENCE_TOKEN_SETTING}', $1::text, true) AS presented`,
			[fenceToken],
		);
	}

	/** Apply mutations in order on an open transaction. */
	async applyOn(
		tx: PostgresExecutor,
		stored: StoredDataset,
		mutations: readonly RecordMutation[],
		fenceToken: string | undefined,
	): Promise<void> {
		const { schema, statements } = stored;
		await this.present(tx, fenceToken);
		for (const mutation of mutations) {
			// The tenant is a text key column like any other: one the server
			// would alter or reject is refused before it is sent.
			assertStorableText(mutation.tenant, "tenant");
			const upsert = mutation.op === "upsert" && mutation.record !== undefined;
			if (
				!upsert &&
				encodeRecordKey(schema, decodeRecordKey(schema, mutation.key)) !==
					mutation.key
			) {
				// A delete names a key and nothing else. Read leniently, an
				// uppercase uuid or a spaced-out key would delete here and
				// delete nothing in an engine that compares keys as text.
				throw new DataCoreError(
					"INVALID_RECORD",
					"a delete names a record by its canonical key",
					{ detail: { dataset: schema.name, field: "key" } },
				);
			}
			const parameters = upsert
				? this.upsertParameters(schema, mutation)
				: [mutation.tenant, ...this.keyParameters(schema, mutation.key)];
			try {
				await tx.query(
					upsert ? statements.upsert : statements.remove,
					parameters,
				);
			} catch (cause) {
				rethrowWriteError(cause, schema.name, mutation.tenant);
			}
		}
	}

	async write(
		dataset: string,
		mutations: readonly RecordMutation[],
		fenceToken: string | undefined,
	): Promise<void> {
		const stored = await this.dataset(dataset);
		await this.executor.transaction((tx) =>
			this.applyOn(tx, stored, mutations, fenceToken),
		);
	}

	/**
	 * Changes and their watermark, in one transaction.
	 *
	 * With `expected` the apply is conditional, and the watermark is written
	 * *first*: one statement that only takes effect when the row is what the
	 * applier named. It takes the row's lock, so a second applier naming the
	 * same watermark waits for the first to commit, then matches nothing and
	 * is refused before it has written a record; a refusal rolls back.
	 */
	async apply(
		dataset: string,
		changes: readonly RecordMutation[],
		source: string,
		position: string,
		fenceToken: string | undefined,
		expected?: string | null,
	): Promise<void> {
		const stored = await this.dataset(dataset);
		await this.executor.transaction(async (tx) => {
			if (expected === undefined) {
				await this.applyOn(tx, stored, changes, fenceToken);
				await tx.query(
					`INSERT INTO ${this.meta("watermarks")} (dataset, source, log_position) VALUES ($1::text, $2::text, $3::text) ON CONFLICT (dataset, source) DO UPDATE SET log_position = EXCLUDED.log_position`,
					[dataset, source, position],
				);
				return;
			}
			const moved =
				expected === null
					? await tx.query(
							`INSERT INTO ${this.meta("watermarks")} (dataset, source, log_position) VALUES ($1::text, $2::text, $3::text) ON CONFLICT (dataset, source) DO NOTHING`,
							[dataset, source, position],
						)
					: await tx.query(
							`UPDATE ${this.meta("watermarks")} SET log_position = $3::text WHERE dataset = $1::text AND source = $2::text AND log_position = $4::text`,
							[dataset, source, position, expected],
						);
			if (moved.rowCount !== 1) throw new StaleApplyError(dataset, source);
			await this.applyOn(tx, stored, changes, fenceToken);
		});
	}

	async watermark(
		dataset: string,
		source: string,
	): Promise<string | undefined> {
		await this.dataset(dataset);
		const result = await this.executor.query(
			`SELECT log_position FROM ${this.meta("watermarks")} WHERE dataset = $1::text AND source = $2::text`,
			[dataset, source],
		);
		return result.rows[0]?.log_position ?? undefined;
	}

	// ── reads ─────────────────────────────────────────────────────────────────

	async read(
		dataset: string,
		tenant: string,
		key: string,
	): Promise<CanonicalRecord | undefined> {
		const { schema, statements } = await this.dataset(dataset);
		const result = await this.executor.query(statements.readOne, [
			tenant,
			...this.keyParameters(schema, key),
		]);
		const row = result.rows[0];
		return row === undefined ? undefined : this.stored(schema, row).record;
	}

	/** One keyset page in primary-key order, after `last` when it is given. */
	async page(
		on: PostgresExecutor,
		stored: StoredDataset,
		tenant: string,
		last: StoredRecord | undefined,
		size: number,
	): Promise<readonly StoredRecord[]> {
		const { schema, statements } = stored;
		const scoped = tenant !== "";
		const parameters: PostgresParameter[] = [];
		if (scoped) parameters.push(tenant);
		if (last !== undefined) {
			parameters.push(last.tenant, ...this.keyParameters(schema, last.key));
		}
		parameters.push(String(size));
		const result = await on.query(
			statements.scan(scoped, last !== undefined),
			parameters,
		);
		return result.rows.map((row) => this.stored(schema, row));
	}

	/** Stream the scope through the canonical digest builder. */
	async digestOn(
		on: PostgresExecutor,
		stored: StoredDataset,
		scope: DatasetScope,
		buckets: number,
	): Promise<DatasetDigest> {
		const builder = new DatasetDigestBuilder(
			scope.dataset,
			scope.tenant,
			buckets,
		);
		let last: StoredRecord | undefined;
		for (;;) {
			const rows = await this.page(
				on,
				stored,
				scope.tenant,
				last,
				this.pageSize,
			);
			for (const row of rows) builder.add(row.tenant, row.key, row.record);
			last = rows[rows.length - 1];
			if (rows.length < this.pageSize) break;
		}
		return builder.finish();
	}

	async digest(scope: DatasetScope, buckets: number): Promise<DatasetDigest> {
		const stored = await this.dataset(scope.dataset);
		// One snapshot for the whole scan, so the digest describes a state the
		// store was actually in rather than a blend of several.
		return this.executor.transaction(async (tx) => {
			await tx.query(
				"SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
			);
			return this.digestOn(tx, stored, scope, buckets);
		});
	}

	/** A keyset-paginated scan yielding upserts, one chunk per call. */
	openScan(
		stored: StoredDataset,
		tenant: string,
		chunkSize: number,
	): () => Promise<readonly RecordMutation[] | undefined> {
		let last: StoredRecord | undefined;
		let done = false;
		return async () => {
			if (done) return undefined;
			const rows = await this.page(
				this.executor,
				stored,
				tenant,
				last,
				chunkSize,
			);
			if (rows.length < chunkSize) done = true;
			last = rows[rows.length - 1] ?? last;
			return rows.length === 0
				? undefined
				: rows.map((row) => upsertMutation(row.tenant, row.key, row.record));
		};
	}

	// ── fence ─────────────────────────────────────────────────────────────────

	private async fenceToken(
		on: PostgresExecutor,
		scope: DatasetScope,
	): Promise<string | undefined> {
		const result = await on.query(
			`SELECT token FROM ${this.meta("fences")} WHERE dataset = $1::text AND tenant = $2::text`,
			[scope.dataset, scope.tenant],
		);
		return result.rows[0]?.token ?? undefined;
	}

	async raiseFence(scope: DatasetScope, reason: string): Promise<string> {
		await this.dataset(scope.dataset);
		const existing = await this.fenceToken(this.executor, scope);
		if (existing !== undefined) return existing;
		const minted = `fence:${scope.dataset}:${scope.tenant}:${randomUUID()}`;
		return this.executor.transaction(async (tx) => {
			// Updating the dataset's metadata row conflicts with the share lock
			// every writer's trigger takes: this waits for in-flight writers to
			// finish, and holds later ones until the fence row is committed.
			await tx.query(
				`UPDATE ${this.meta("datasets")} SET fence_epoch = fence_epoch + 1 WHERE dataset = $1::text`,
				[scope.dataset],
			);
			await tx.query(
				`INSERT INTO ${this.meta("fences")} (dataset, tenant, token, reason) VALUES ($1::text, $2::text, $3::text, $4::text) ON CONFLICT (dataset, tenant) DO NOTHING`,
				[scope.dataset, scope.tenant, minted, reason],
			);
			return (await this.fenceToken(tx, scope)) ?? minted;
		});
	}

	async releaseFence(scope: DatasetScope, fenceToken: string): Promise<void> {
		await this.dataset(scope.dataset);
		const existing = await this.fenceToken(this.executor, scope);
		if (existing === undefined) return;
		if (existing !== fenceToken) {
			throw new DataCoreError(
				"FENCE_TOKEN_MISMATCH",
				"only the fence token holder may release a fence",
				{ detail: { dataset: scope.dataset } },
			);
		}
		await this.executor.query(
			`DELETE FROM ${this.meta("fences")} WHERE dataset = $1::text AND tenant = $2::text AND token = $3::text`,
			[scope.dataset, scope.tenant, fenceToken],
		);
	}

	async isFenced(scope: DatasetScope): Promise<boolean> {
		await this.dataset(scope.dataset);
		return (await this.fenceToken(this.executor, scope)) !== undefined;
	}

	// ── retire ────────────────────────────────────────────────────────────────

	async retire(
		scope: DatasetScope,
		fenceToken: string,
		expected: DatasetDigest,
	): Promise<number> {
		const stored = await this.dataset(scope.dataset);
		const refused = (message: string): DataCoreError =>
			new DataCoreError("RETIRE_REFUSED", message, {
				detail: { dataset: scope.dataset },
			});
		try {
			return await this.executor.transaction(async (tx) => {
				// Exclusive on the dataset's metadata row: no writer — not even
				// one holding the token — can land between the digest and the
				// delete.
				await tx.query(
					`SELECT dataset FROM ${this.meta("datasets")} WHERE dataset = $1::text FOR UPDATE`,
					[scope.dataset],
				);
				if ((await this.fenceToken(tx, scope)) !== fenceToken) {
					throw refused(
						"retire needs the raised fence's token; the store may still be authoritative",
					);
				}
				await this.present(tx, fenceToken);
				const current = await this.digestOn(
					tx,
					stored,
					scope,
					expected.buckets.length,
				);
				// Redelivery: the scope is already empty behind the caller's
				// own fence. There is nothing left to compare or to remove.
				if (current.count === 0) return 0;
				if (
					current.count !== expected.count ||
					current.digest !== expected.digest
				) {
					throw refused("the store no longer matches the verified digest");
				}
				const scoped = scope.tenant !== "";
				const removed = await tx.query(
					stored.statements.removeScope(scoped),
					scoped ? [scope.tenant] : [],
				);
				return removed.rowCount;
			});
		} catch (cause) {
			if (sqlStateOf(cause) === FENCED_WRITE_SQLSTATE) {
				// A wider or narrower fence held by someone else covers part of
				// this scope: the caller is not the only authority over it.
				throw refused("another fence covers part of this scope");
			}
			throw cause;
		}
	}
}
