/**
 * Snapshot replication from the writer to one standby.
 *
 * It needs nothing but two ordinary connections: no replication role, no
 * publication, no extension. The source is read in one `REPEATABLE READ READ
 * ONLY` transaction, so the copy is a single consistent point in time. The
 * target is replaced in one transaction, so a standby is always exactly some
 * earlier state of the writer and never a mixture.
 *
 * The cost is what a snapshot costs: every run reads and rewrites every row of
 * every copied table, so time and statement count grow with the size of the
 * database, not with how much changed. A standby is as stale as the time since
 * the last run. Both are stated limits, not accidents.
 *
 * The step that makes this safe to run unattended is on the target, inside the
 * target's transaction and under the fleet's exclusive lock: the target's own
 * newest log entry must be the very assignment the caller resolved, and that
 * assignment must name another backend as the writer. A backend that is, or is
 * about to be, the writer holds an entry saying so (it is always written there
 * first), so it refuses to be overwritten no matter how stale the caller is.
 */
import { PostgresDataError } from "../errors.js";
import {
	assignmentKey,
	type PostgresFleetAssignment,
	readAssignmentRows,
} from "./assignment.js";
import {
	FLEET_LOCK_CLASS,
	type FleetLayout,
	isReplicatedTable,
} from "./layout.js";
import {
	column,
	type FleetBackend,
	inTransaction,
	optionalColumn,
	parseCount,
	parseFlag,
	quoteIdentifier,
	type SqlSession,
} from "./sql.js";

export type ReplicatedTable = {
	readonly name: string;
	readonly rows: number;
	/** Order-independent SHA-256 digest of the table's rows in text form. */
	readonly digest: string;
};

// parallel-type-allowed: the parsed in-process record read back through readWatermark; the proto PostgresFleetWatermark is its wire projection.
export type PostgresFleetWatermark = {
	/** The backend the standby was copied from. */
	readonly source: string;
	/** The assignment epoch the copy was made under. */
	readonly sourceEpoch: number;
	/** When the snapshot was taken, on the source's clock. */
	readonly snapshotAtMs: number;
	readonly tables: readonly ReplicatedTable[];
	readonly rowCount: number;
	readonly byteCount: number;
	/** SHA-256 over every table's name, row count and digest. */
	readonly digest: string;
};

export const REPLICATION_REFUSALS = [
	"same-backend",
	"source-is-not-writer",
	"target-is-writer",
	"target-log-differs",
	"schema-mismatch",
	"oversized",
	"busy",
	"digest-mismatch",
] as const;

export type ReplicationRefusal = (typeof REPLICATION_REFUSALS)[number];

export type ReplicationLimits = {
	/** Refuse to copy more rows than this in one run. */
	readonly maxRows: number;
	/** Refuse to copy more JSON text than this in one run. */
	readonly maxBytes: number;
	readonly batchRows: number;
	readonly batchBytes: number;
};

export const DEFAULT_REPLICATION_LIMITS: ReplicationLimits = Object.freeze({
	maxRows: 2_000_000,
	maxBytes: 512 * 1024 * 1024,
	batchRows: 500,
	batchBytes: 4 * 1024 * 1024,
});

export type ReplicationRequest = {
	readonly source: FleetBackend;
	readonly target: FleetBackend;
	readonly layout: FleetLayout;
	/** The decided current assignment, as the caller resolved it by majority. */
	readonly assignment: PostgresFleetAssignment;
	readonly limits?: Partial<ReplicationLimits>;
};

export type ReplicationOutcome =
	| {
			readonly status: "replicated";
			readonly watermark: PostgresFleetWatermark;
	  }
	| {
			readonly status: "refused";
			readonly refusal: ReplicationRefusal;
			/** Names a table or column; never data and never a connection. */
			readonly detail: string;
	  };

class Refused extends Error {
	constructor(
		readonly refusal: ReplicationRefusal,
		readonly detail: string,
	) {
		super(refusal);
	}
}

type CatalogColumn = {
	readonly name: string;
	readonly type: string;
	readonly generated: boolean;
	readonly sequence: string | undefined;
};

type CatalogTable = {
	readonly name: string;
	readonly columns: readonly CatalogColumn[];
};

/**
 * Make text output identical on both sides. `row_to_json` writes a
 * `timestamptz` in the session's time zone and a `bytea` in the session's
 * output format, so two servers with different defaults would otherwise
 * describe the same row with different bytes.
 */
async function pinSession(session: SqlSession): Promise<void> {
	await session.query(
		`SELECT set_config('TimeZone', 'UTC', true), set_config('DateStyle', 'ISO, YMD', true),
			set_config('IntervalStyle', 'iso_8601', true), set_config('extra_float_digits', '3', true),
			set_config('bytea_output', 'hex', true)`,
	);
}

/** The copied tables of one backend, discovered from its catalog. */
async function readCatalog(
	session: SqlSession,
	layout: FleetLayout,
): Promise<readonly CatalogTable[]> {
	const result = await session.query(
		`SELECT c.relname::text AS table_name, a.attname::text AS column_name,
			format_type(a.atttypid, a.atttypmod) AS type_name,
			(a.attgenerated <> '')::text AS generated,
			pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) AS sequence_name
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		WHERE n.nspname = current_schema() AND c.relkind = 'r' AND starts_with(c.relname, $1)
		ORDER BY c.relname, a.attname`,
		[layout.dataPrefix],
	);
	const tables = new Map<string, CatalogColumn[]>();
	for (const row of result.rows) {
		const table = column(row, "table_name");
		if (!isReplicatedTable(layout, table)) continue;
		const columns = tables.get(table) ?? [];
		const name = optionalColumn(row, "column_name");
		if (name !== undefined)
			columns.push({
				name,
				type: column(row, "type_name"),
				generated: parseFlag(column(row, "generated"), "generated"),
				sequence: optionalColumn(row, "sequence_name"),
			});
		tables.set(table, columns);
	}
	return [...tables.entries()].map(([name, columns]) => ({ name, columns }));
}

/** The first difference between two catalogs, or nothing when they match. */
function catalogDifference(
	source: readonly CatalogTable[],
	target: readonly CatalogTable[],
): string | undefined {
	const targets = new Map(target.map((table) => [table.name, table]));
	for (const table of source) {
		const other = targets.get(table.name);
		if (other === undefined) return `table ${table.name} is missing on target`;
		if (table.columns.length === 0) return `table ${table.name} has no columns`;
		const columns = new Map(other.columns.map((entry) => [entry.name, entry]));
		for (const entry of table.columns) {
			const match = columns.get(entry.name);
			if (match === undefined)
				return `column ${table.name}.${entry.name} is missing on target`;
			if (match.type !== entry.type || match.generated !== entry.generated)
				return `column ${table.name}.${entry.name} is ${entry.type} on source and ${match.type} on target`;
		}
		if (other.columns.length !== table.columns.length)
			return `table ${table.name} has extra columns on target`;
	}
	if (target.length !== source.length) {
		const names = new Set(source.map((table) => table.name));
		const extra = target.find((table) => !names.has(table.name));
		return `table ${extra?.name ?? "?"} is missing on source`;
	}
	return undefined;
}

/**
 * Every column as its text form. A value travels and is digested as the text
 * PostgreSQL itself prints for its type, which is the one representation every
 * type reads back exactly. Relying on JSON's own typing instead would lose the
 * difference between an SQL NULL and a `json` column holding `null`.
 */
function textList(columns: readonly CatalogColumn[]): string {
	return columns
		.map((entry) => {
			const name = quoteIdentifier(entry.name);
			return `${name}::text AS ${name}`;
		})
		.join(", ");
}

/**
 * Row count and an order-independent digest of one table, computed by the
 * server in one pass: each row, as a JSON object of its columns' text forms, is hashed with SHA-256, the
 * hash is split into four 64-bit words, and the words are summed. Summation
 * makes row order irrelevant and keeps memory constant.
 */
async function digestTable(
	session: SqlSession,
	table: CatalogTable,
): Promise<ReplicatedTable> {
	const word = (offset: number) =>
		`('x' || encode(substring(h FROM ${offset} FOR 8), 'hex'))::bit(64)::bigint::numeric`;
	const result = await session.query(
		`SELECT count(*)::text AS row_count,
			encode(sha256(convert_to(concat_ws(':', count(*)::text,
				coalesce(sum(w1), 0)::text, coalesce(sum(w2), 0)::text,
				coalesce(sum(w3), 0)::text, coalesce(sum(w4), 0)::text), 'UTF8')), 'hex') AS digest
		FROM (
			SELECT ${word(1)} AS w1, ${word(9)} AS w2, ${word(17)} AS w3, ${word(25)} AS w4
			FROM (
				SELECT sha256(convert_to(row_to_json(r)::text, 'UTF8')) AS h
				FROM (SELECT ${textList(table.columns)} FROM ${quoteIdentifier(table.name)}) r
			) hashed
		) words`,
	);
	const row = result.rows[0];
	if (row === undefined)
		throw new PostgresDataError(
			"FLEET_RECORD_INVALID",
			"table digest returned no row",
		);
	return {
		name: table.name,
		rows: parseCount(column(row, "row_count"), "rowCount"),
		digest: column(row, "digest"),
	};
}

/**
 * Digest every copied table of one backend at one consistent point in time.
 * Two backends hold the same data exactly when these lists are equal.
 */
export async function readDataDigests(
	backend: FleetBackend,
	layout: FleetLayout,
): Promise<readonly ReplicatedTable[]> {
	return inTransaction(
		backend.executor,
		"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
		async (session) => {
			await pinSession(session);
			const digests: ReplicatedTable[] = [];
			for (const table of await readCatalog(session, layout))
				digests.push(await digestTable(session, table));
			return digests;
		},
	);
}

export type SequencePosition = {
	readonly table: string;
	readonly column: string;
	/** The last value handed out, or nothing if the sequence was never used. */
	readonly value: number | undefined;
};

async function sequencePositions(
	session: SqlSession,
	tables: readonly CatalogTable[],
): Promise<
	readonly (SequencePosition & {
		readonly sequence: string;
	})[]
> {
	const positions = [];
	for (const table of tables)
		for (const entry of table.columns) {
			if (entry.sequence === undefined) continue;
			const result = await session.query(
				"SELECT pg_sequence_last_value($1::regclass)::text AS last_value",
				[entry.sequence],
			);
			const last =
				result.rows[0] === undefined
					? undefined
					: optionalColumn(result.rows[0], "last_value");
			positions.push({
				table: table.name,
				column: entry.name,
				sequence: entry.sequence,
				value: last === undefined ? undefined : parseCount(last, "sequence"),
			});
		}
	return positions;
}

/** Where every sequence owned by a copied table stands on one backend. */
export async function readSequencePositions(
	backend: FleetBackend,
	layout: FleetLayout,
): Promise<readonly SequencePosition[]> {
	return backend.executor.session(async (session) => {
		const positions = await sequencePositions(
			session,
			await readCatalog(session, layout),
		);
		return positions.map(({ table, column: name, value }) => ({
			table,
			column: name,
			value,
		}));
	});
}

async function copyTable(
	from: SqlSession,
	to: SqlSession,
	table: CatalogTable,
	limits: ReplicationLimits,
	budget: { bytes: number },
): Promise<void> {
	const writable = table.columns.filter((entry) => !entry.generated);
	const name = quoteIdentifier(table.name);
	const names = writable.map((entry) => quoteIdentifier(entry.name));
	const casts = writable.map(
		(entry) => `x.${quoteIdentifier(entry.name)}::${entry.type}`,
	);
	const record = names.map((entry) => `${entry} text`);
	await from.query(
		`DECLARE fleet_copy NO SCROLL CURSOR FOR
			SELECT row_to_json(r)::text AS doc FROM (SELECT ${textList(writable)} FROM ${name}) r`,
	);
	// Start small: one row can be megabytes, and a fetch is sized from what
	// the rows so far have actually weighed.
	let fetchRows = Math.min(16, limits.batchRows);
	for (;;) {
		const batch = await from.query(`FETCH ${fetchRows} FROM fleet_copy`);
		if (batch.rows.length === 0) break;
		const docs = batch.rows.map((row) => column(row, "doc"));
		const bytes = docs.reduce((total, doc) => total + doc.length, 0);
		budget.bytes += bytes;
		if (budget.bytes > limits.maxBytes)
			throw new Refused(
				"oversized",
				`copied data exceeds ${limits.maxBytes} bytes at table ${table.name}`,
			);
		await to.query(
			`INSERT INTO ${name} (${names.join(", ")}) OVERRIDING SYSTEM VALUE
				SELECT ${casts.join(", ")} FROM json_to_recordset($1::json) AS x(${record.join(", ")})`,
			[`[${docs.join(",")}]`],
		);
		const average = Math.max(1, Math.ceil(bytes / docs.length));
		fetchRows = Math.max(
			1,
			Math.min(limits.batchRows, Math.floor(limits.batchBytes / average)),
		);
	}
	await from.query("CLOSE fleet_copy");
}

async function writeWatermark(
	to: SqlSession,
	layout: FleetLayout,
	watermark: Omit<PostgresFleetWatermark, "digest">,
): Promise<string> {
	const lines = watermark.tables
		.map((table) => `${table.name}:${table.rows}:${table.digest}`)
		.join("\n");
	const result = await to.query(
		`INSERT INTO ${layout.watermarkTable}
			(singleton, source, source_epoch, snapshot_at, tables, row_count, byte_count, digest, replicated_at)
		VALUES (true, $1::text, $2::bigint, timestamptz 'epoch' + $3::bigint * interval '1 millisecond',
			$4::jsonb, $5::bigint, $6::bigint, encode(sha256(convert_to($7::text, 'UTF8')), 'hex'), clock_timestamp())
		ON CONFLICT (singleton) DO UPDATE SET source = EXCLUDED.source, source_epoch = EXCLUDED.source_epoch,
			snapshot_at = EXCLUDED.snapshot_at, tables = EXCLUDED.tables, row_count = EXCLUDED.row_count,
			byte_count = EXCLUDED.byte_count, digest = EXCLUDED.digest, replicated_at = EXCLUDED.replicated_at
		RETURNING digest`,
		[
			watermark.source,
			watermark.sourceEpoch,
			watermark.snapshotAtMs,
			JSON.stringify(watermark.tables),
			watermark.rowCount,
			watermark.byteCount,
			lines,
		],
	);
	const row = result.rows[0];
	if (row === undefined)
		throw new PostgresDataError(
			"FLEET_RECORD_INVALID",
			"watermark write returned no row",
		);
	return column(row, "digest");
}

/**
 * Replace the target's copied tables with a snapshot of the source's.
 *
 * Returns `refused` with a named reason for every condition this function
 * checks. A failed connection or statement is thrown, and both transactions
 * are rolled back: the target keeps its previous snapshot and watermark.
 */
export async function replicateSnapshot(
	request: ReplicationRequest,
): Promise<ReplicationOutcome> {
	const { source, target, layout, assignment } = request;
	const limits = { ...DEFAULT_REPLICATION_LIMITS, ...request.limits };
	if (source.id === target.id)
		return {
			status: "refused",
			refusal: "same-backend",
			detail: "source and target are the same backend",
		};
	if (assignment.active !== source.id)
		return {
			status: "refused",
			refusal: "source-is-not-writer",
			detail: `assignment ${assignment.epoch} does not name the source as writer`,
		};
	try {
		const watermark = await inTransaction(
			source.executor,
			"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
			async (from) => {
				await pinSession(from);
				const clock = await from.query(
					"SELECT round(extract(epoch FROM now()) * 1000)::bigint::text AS snapshot_at_ms",
				);
				const snapshotAtMs = parseCount(
					column(clock.rows[0] ?? {}, "snapshot_at_ms"),
					"snapshotAtMs",
				);
				const catalog = await readCatalog(from, layout);
				const tables: ReplicatedTable[] = [];
				for (const relation of catalog)
					tables.push(await digestTable(from, relation));
				const rowCount = tables.reduce((total, table) => total + table.rows, 0);
				if (rowCount > limits.maxRows)
					throw new Refused(
						"oversized",
						`${rowCount} rows exceed the limit of ${limits.maxRows}`,
					);
				const sourceSequences = await sequencePositions(from, catalog);
				return inTransaction(target.executor, "BEGIN", async (to) => {
					await pinSession(to);
					const lock = await to.query(
						"SELECT pg_try_advisory_xact_lock($1::int, hashtext($2))::text AS locked",
						[FLEET_LOCK_CLASS, layout.assignmentTable],
					);
					if (!parseFlag(column(lock.rows[0] ?? {}, "locked"), "locked"))
						throw new Refused(
							"busy",
							"another copy into the target is running",
						);
					// The target's own log, read on this session and under the lock.
					const held = await readAssignmentRows(to, layout, 1);
					const newest = held.at(-1);
					if (newest?.active === target.id)
						throw new Refused(
							"target-is-writer",
							`the target's own log names it writer at epoch ${newest.epoch}`,
						);
					if (
						newest === undefined ||
						assignmentKey(newest) !== assignmentKey(assignment)
					)
						throw new Refused(
							"target-log-differs",
							`the target's newest entry is epoch ${newest?.epoch ?? 0}, not the resolved epoch ${assignment.epoch}`,
						);
					const targetCatalog = await readCatalog(to, layout);
					const difference = catalogDifference(catalog, targetCatalog);
					if (difference !== undefined)
						throw new Refused("schema-mismatch", difference);
					if (catalog.length > 0)
						await to.query(
							`TRUNCATE ${catalog.map((relation) => quoteIdentifier(relation.name)).join(", ")}`,
						);
					const budget = { bytes: 0 };
					for (const relation of catalog)
						await copyTable(from, to, relation, limits, budget);
					for (const position of sourceSequences) {
						if (position.value === undefined) continue;
						const match = targetCatalog
							.find((relation) => relation.name === position.table)
							?.columns.find((entry) => entry.name === position.column);
						if (match?.sequence === undefined)
							throw new Refused(
								"schema-mismatch",
								`column ${position.table}.${position.column} owns no sequence on target`,
							);
						// Never backwards: a returned writer may have handed out more.
						await to.query(
							`SELECT setval($1::regclass, GREATEST($2::bigint,
								coalesce(pg_sequence_last_value($1::regclass), $2::bigint)), true)::text AS position`,
							[match.sequence, position.value],
						);
					}
					for (const [index, relation] of catalog.entries()) {
						const copied = await digestTable(to, relation);
						const expected = tables[index];
						if (
							expected === undefined ||
							copied.rows !== expected.rows ||
							copied.digest !== expected.digest
						)
							throw new Refused(
								"digest-mismatch",
								`table ${relation.name} differs from the source after the copy`,
							);
					}
					const record = {
						source: source.id,
						sourceEpoch: assignment.epoch,
						snapshotAtMs,
						tables,
						rowCount,
						byteCount: budget.bytes,
					};
					return {
						...record,
						digest: await writeWatermark(to, layout, record),
					};
				});
			},
		);
		return { status: "replicated", watermark };
	} catch (error) {
		if (error instanceof Refused)
			return {
				status: "refused",
				refusal: error.refusal,
				detail: error.detail,
			};
		throw error;
	}
}

/** The watermark of one backend, or nothing if it was never a copy target. */
export async function readWatermark(
	backend: FleetBackend,
	layout: FleetLayout,
): Promise<PostgresFleetWatermark | undefined> {
	const result = await backend.executor.query(
		`SELECT w.source, w.source_epoch::text AS source_epoch,
			round(extract(epoch FROM w.snapshot_at) * 1000)::bigint::text AS snapshot_at_ms,
			w.row_count::text AS row_count, w.byte_count::text AS byte_count, w.digest,
			t.value ->> 'name' AS table_name, t.value ->> 'rows' AS table_rows,
			t.value ->> 'digest' AS table_digest
		FROM ${layout.watermarkTable} w
		LEFT JOIN LATERAL jsonb_array_elements(w.tables) t ON true
		ORDER BY t.value ->> 'name'`,
	);
	const first = result.rows[0];
	if (first === undefined) return undefined;
	const tables: ReplicatedTable[] = [];
	for (const row of result.rows) {
		const name = optionalColumn(row, "table_name");
		if (name === undefined) continue;
		tables.push({
			name,
			rows: parseCount(column(row, "table_rows"), "rows"),
			digest: column(row, "table_digest"),
		});
	}
	return {
		source: column(first, "source"),
		sourceEpoch: parseCount(column(first, "source_epoch"), "sourceEpoch"),
		snapshotAtMs: parseCount(column(first, "snapshot_at_ms"), "snapshotAtMs"),
		tables,
		rowCount: parseCount(column(first, "row_count"), "rowCount"),
		byteCount: parseCount(column(first, "byte_count"), "byteCount"),
		digest: column(first, "digest"),
	};
}

/**
 * How far a standby is behind: the time since its snapshot was taken. This is
 * an upper bound on what a promotion would lose, not a count of lost writes.
 */
export function standbyLagMs(
	watermark: PostgresFleetWatermark,
	nowMs: number,
): number {
	return Math.max(0, nowMs - watermark.snapshotAtMs);
}
