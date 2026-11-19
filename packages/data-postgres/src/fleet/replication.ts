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
	type SqlExecutor,
	type SqlSession,
} from "./sql.js";

export type ReplicatedTable = {
	readonly name: string;
	readonly rows: number;
	readonly digest: string;
};

// parallel-type-allowed: the parsed in-process record read back through readWatermark; the proto PostgresFleetWatermark is its wire projection.
export type PostgresFleetWatermark = {
	readonly source: string;
	readonly sourceEpoch: number;
	readonly snapshotAtMs: number;
	readonly tables: readonly ReplicatedTable[];
	readonly rowCount: number;
	readonly byteCount: number;
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
	readonly maxRows: number;
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
	readonly assignment: PostgresFleetAssignment;
	readonly limits?: Partial<ReplicationLimits> | undefined;
};

export type ReplicationOutcome =
	| {
			readonly status: "replicated";
			readonly watermark: PostgresFleetWatermark;
	  }
	| {
			readonly status: "refused";
			readonly refusal: ReplicationRefusal;
			readonly detail: string;
	  };

export class ReplicationRefused extends Error {
	constructor(
		readonly refusal: ReplicationRefusal,
		readonly detail: string,
	) {
		super(refusal);
		this.name = "ReplicationRefused";
	}
}

export type SnapshotCopy = {
	readonly snapshotAtMs: number;
	readonly tables: readonly ReplicatedTable[];
	readonly rowCount: number;
	readonly byteCount: number;
};

export type SnapshotCopyRequest<T> = {
	readonly source: SqlExecutor;
	readonly target: SqlExecutor;
	readonly layout: FleetLayout;
	readonly limits?: Partial<ReplicationLimits> | undefined;
	readonly admit: (to: SqlSession) => Promise<void>;
	readonly record: (to: SqlSession, copy: SnapshotCopy) => Promise<T>;
};

type CatalogColumn = {
	readonly name: string;
	readonly type: string;
	readonly generated: boolean;
	readonly sequence: string | undefined;
	readonly sequenceValue: number | undefined;
};

type CatalogTable = {
	readonly name: string;
	readonly columns: readonly CatalogColumn[];
	readonly referenced: boolean;
	readonly references: readonly string[];
};

export function insertionOrder<
	T extends Pick<CatalogTable, "name" | "references">,
>(tables: readonly T[]): readonly T[] {
	const byName = new Map(tables.map((table) => [table.name, table]));
	const placed = new Set<string>();
	const visiting = new Set<string>();
	const ordered: T[] = [];
	const visit = (table: T) => {
		if (placed.has(table.name) || visiting.has(table.name)) return;
		visiting.add(table.name);
		for (const parent of [...table.references].sort()) {
			const found = byName.get(parent);
			if (found !== undefined && parent !== table.name) visit(found);
		}
		visiting.delete(table.name);
		placed.add(table.name);
		ordered.push(table);
	};
	for (const table of [...tables].sort((a, b) => (a.name < b.name ? -1 : 1)))
		visit(table);
	return ordered;
}

async function pinSession(session: SqlSession): Promise<number> {
	const result = await session.query(
		`SELECT set_config('TimeZone', 'UTC', true), set_config('DateStyle', 'ISO, YMD', true),
			set_config('IntervalStyle', 'iso_8601', true), set_config('extra_float_digits', '3', true),
			set_config('bytea_output', 'hex', true),
			round(extract(epoch FROM now()) * 1000)::bigint::text AS started_at_ms`,
	);
	return parseCount(
		column(result.rows[0] ?? {}, "started_at_ms"),
		"snapshotAtMs",
	);
}

async function readCatalog(
	session: SqlSession,
	layout: FleetLayout,
): Promise<readonly CatalogTable[]> {
	const result = await session.query(
		`SELECT c.relname::text AS table_name, a.attname::text AS column_name,
			format_type(a.atttypid, a.atttypmod) AS type_name,
			(a.attgenerated <> '')::text AS generated,
			s.sequence_name,
			pg_sequence_last_value(s.sequence_name::regclass)::text AS sequence_value,
			EXISTS (SELECT 1 FROM pg_constraint k
				WHERE k.contype = 'f' AND k.confrelid = c.oid AND k.conrelid <> c.oid)::text AS referenced
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		LEFT JOIN LATERAL (SELECT pg_get_serial_sequence(
			quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) AS sequence_name) s ON true
		WHERE n.nspname = current_schema() AND c.relkind = 'r' AND starts_with(c.relname, $1)
		ORDER BY c.relname, a.attname`,
		[layout.dataPrefix],
	);
	const keys = await session.query(
		`SELECT c.relname::text AS table_name, p.relname::text AS parent_name
		FROM pg_constraint k
		JOIN pg_class c ON c.oid = k.conrelid
		JOIN pg_class p ON p.oid = k.confrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE k.contype = 'f' AND n.nspname = current_schema()
		ORDER BY 1, 2`,
	);
	const parents = new Map<string, string[]>();
	for (const row of keys.rows) {
		const table = column(row, "table_name");
		parents.set(table, [
			...(parents.get(table) ?? []),
			column(row, "parent_name"),
		]);
	}
	const tables = new Map<
		string,
		{ columns: CatalogColumn[]; referenced: boolean; references: string[] }
	>();
	for (const row of result.rows) {
		const table = column(row, "table_name");
		if (!isReplicatedTable(layout, table)) continue;
		const entry = tables.get(table) ?? {
			columns: [],
			referenced: parseFlag(column(row, "referenced"), "referenced"),
			references: (parents.get(table) ?? []).filter((parent) =>
				isReplicatedTable(layout, parent),
			),
		};
		const name = optionalColumn(row, "column_name");
		const position = optionalColumn(row, "sequence_value");
		if (name !== undefined)
			entry.columns.push({
				name,
				type: column(row, "type_name"),
				generated: parseFlag(column(row, "generated"), "generated"),
				sequence: optionalColumn(row, "sequence_name"),
				sequenceValue:
					position === undefined ? undefined : parseCount(position, "sequence"),
			});
		tables.set(table, entry);
	}
	return [...tables.entries()].map(([name, entry]) => ({ name, ...entry }));
}

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
			if ((match.sequence === undefined) !== (entry.sequence === undefined))
				return `column ${table.name}.${entry.name} owns a sequence on one side only`;
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

function textList(columns: readonly CatalogColumn[]): string {
	return columns
		.map((entry) => {
			const name = quoteIdentifier(entry.name);
			return `${name}::text AS ${name}`;
		})
		.join(", ");
}

async function digestTables(
	session: SqlSession,
	tables: readonly CatalogTable[],
): Promise<readonly ReplicatedTable[]> {
	if (tables.length === 0) return [];
	const word = (offset: number) =>
		`('x' || encode(substring(h FROM ${offset} FOR 8), 'hex'))::bit(64)::bigint::numeric`;
	const result = await session.query(
		tables
			.map(
				(
					table,
				) => `SELECT '${table.name.replaceAll("'", "''")}'::text AS table_name,
			count(*)::text AS row_count,
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
			)
			.join("\nUNION ALL\n"),
	);
	const digests = new Map(
		result.rows.map((row) => [
			column(row, "table_name"),
			{
				rows: parseCount(column(row, "row_count"), "rowCount"),
				digest: column(row, "digest"),
			},
		]),
	);
	return tables.map((table) => {
		const entry = digests.get(table.name);
		if (entry === undefined)
			throw new PostgresDataError(
				"FLEET_RECORD_INVALID",
				"table digest returned no row",
				{ detail: { table: table.name } },
			);
		return { name: table.name, ...entry };
	});
}

export async function readDataDigests(
	backend: FleetBackend,
	layout: FleetLayout,
): Promise<readonly ReplicatedTable[]> {
	return inTransaction(
		backend.executor,
		"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
		async (session) => {
			await pinSession(session);
			return digestTables(session, await readCatalog(session, layout));
		},
	);
}

export type SequencePosition = {
	readonly table: string;
	readonly column: string;
	readonly value: number | undefined;
};

function sequencePositions(
	tables: readonly CatalogTable[],
): readonly (SequencePosition & { readonly sequence: string })[] {
	return tables.flatMap((table) =>
		table.columns.flatMap((entry) =>
			entry.sequence === undefined
				? []
				: [
						{
							table: table.name,
							column: entry.name,
							sequence: entry.sequence,
							value: entry.sequenceValue,
						},
					],
		),
	);
}

export async function readSequencePositions(
	backend: FleetBackend,
	layout: FleetLayout,
): Promise<readonly SequencePosition[]> {
	return sequencePositions(await readCatalog(backend.executor, layout)).map(
		({ table, column: name, value }) => ({ table, column: name, value }),
	);
}

async function copyTable(
	from: SqlSession,
	to: SqlSession,
	table: CatalogTable,
	cursor: string,
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
		`DECLARE ${cursor} NO SCROLL CURSOR FOR
			SELECT row_to_json(r)::text AS doc FROM (SELECT ${textList(writable)} FROM ${name}) r`,
	);
	let fetchRows = Math.min(16, limits.batchRows);
	for (;;) {
		const batch = await from.query(`FETCH ${fetchRows} FROM ${cursor}`);
		if (batch.rows.length === 0) break;
		const docs = batch.rows.map((row) => column(row, "doc"));
		const bytes = docs.reduce((total, doc) => total + doc.length, 0);
		budget.bytes += bytes;
		if (budget.bytes > limits.maxBytes)
			throw new ReplicationRefused(
				"oversized",
				`copied data exceeds ${limits.maxBytes} bytes at table ${table.name}`,
			);
		await to.query(
			`INSERT INTO ${name} (${names.join(", ")}) OVERRIDING SYSTEM VALUE
				SELECT ${casts.join(", ")} FROM json_to_recordset($1::json) AS x(${record.join(", ")})`,
			[`[${docs.join(",")}]`],
		);
		if (docs.length < fetchRows) break;
		const average = Math.max(1, Math.ceil(bytes / docs.length));
		fetchRows = Math.max(
			1,
			Math.min(limits.batchRows, Math.floor(limits.batchBytes / average)),
		);
	}
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

function sameTable(
	left: ReplicatedTable | undefined,
	right: ReplicatedTable | undefined,
): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.rows === right.rows &&
		left.digest === right.digest
	);
}

export async function copySnapshot<T>(
	request: SnapshotCopyRequest<T>,
): Promise<T> {
	const { layout } = request;
	const limits = { ...DEFAULT_REPLICATION_LIMITS, ...request.limits };
	return inTransaction(
		request.source,
		"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
		async (from) => {
			const snapshotAtMs = await pinSession(from);
			const catalog = await readCatalog(from, layout);
			const tables = await digestTables(from, catalog);
			const rowCount = tables.reduce((total, table) => total + table.rows, 0);
			if (rowCount > limits.maxRows)
				throw new ReplicationRefused(
					"oversized",
					`${rowCount} rows exceed the limit of ${limits.maxRows}`,
				);
			return inTransaction(request.target, "BEGIN", async (to) => {
				await pinSession(to);
				await request.admit(to);
				const targetCatalog = await readCatalog(to, layout);
				const difference = catalogDifference(catalog, targetCatalog);
				if (difference !== undefined)
					throw new ReplicationRefused("schema-mismatch", difference);
				const before = await digestTables(to, targetCatalog);
				const stale = catalog.filter(
					(relation, index) =>
						!sameTable(
							tables[index],
							before.find((entry) => entry.name === relation.name),
						),
				);
				const rewrite =
					stale.length > 0 && catalog.some((relation) => relation.referenced)
						? catalog
						: stale;
				const budget = { bytes: 0 };
				if (rewrite.length > 0) {
					await to.query(
						`TRUNCATE ${rewrite.map((relation) => quoteIdentifier(relation.name)).join(", ")}`,
					);
					for (const [index, relation] of insertionOrder(rewrite).entries())
						await copyTable(
							from,
							to,
							relation,
							`fleet_copy_${index}`,
							limits,
							budget,
						);
				}
				const positions = sequencePositions(catalog).flatMap((position) => {
					const match = targetCatalog
						.find((relation) => relation.name === position.table)
						?.columns.find((entry) => entry.name === position.column);
					return position.value === undefined || match?.sequence === undefined
						? []
						: [{ sequence: match.sequence, value: position.value }];
				});
				if (positions.length > 0)
					await to.query(
						`SELECT setval(s.name::regclass, GREATEST(s.position,
							coalesce(pg_sequence_last_value(s.name::regclass), s.position)), true)::text AS position
						FROM (VALUES ${positions
							.map(
								(_, index) =>
									`($${index * 2 + 1}::text, $${index * 2 + 2}::bigint)`,
							)
							.join(", ")}) AS s(name, position)`,
						positions.flatMap((position) => [
							position.sequence,
							position.value,
						]),
					);
				if (rewrite.length > 0) {
					const after = await digestTables(to, rewrite);
					for (const copied of after)
						if (
							!sameTable(
								copied,
								tables.find((entry) => entry.name === copied.name),
							)
						)
							throw new ReplicationRefused(
								"digest-mismatch",
								`table ${copied.name} differs from the source after the copy`,
							);
				}
				return request.record(to, {
					snapshotAtMs,
					tables,
					rowCount,
					byteCount: budget.bytes,
				});
			});
		},
	);
}

export async function replicateSnapshot(
	request: ReplicationRequest,
): Promise<ReplicationOutcome> {
	const { source, target, layout, assignment } = request;
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
		const watermark = await copySnapshot({
			source: source.executor,
			target: target.executor,
			layout,
			limits: request.limits,
			admit: async (to) => {
				const lock = await to.query(
					"SELECT pg_try_advisory_xact_lock($1::int, hashtext($2))::text AS locked",
					[FLEET_LOCK_CLASS, layout.assignmentTable],
				);
				if (!parseFlag(column(lock.rows[0] ?? {}, "locked"), "locked"))
					throw new ReplicationRefused(
						"busy",
						"another copy into the target is running",
					);
				const held = await readAssignmentRows(to, layout, 1);
				const newest = held.at(-1);
				if (newest?.active === target.id)
					throw new ReplicationRefused(
						"target-is-writer",
						`the target's own log names it writer at epoch ${newest.epoch}`,
					);
				if (
					newest === undefined ||
					assignmentKey(newest) !== assignmentKey(assignment)
				)
					throw new ReplicationRefused(
						"target-log-differs",
						`the target's newest entry is epoch ${newest?.epoch ?? 0}, not the resolved epoch ${assignment.epoch}`,
					);
			},
			record: async (to, copy) => {
				const record = {
					source: source.id,
					sourceEpoch: assignment.epoch,
					snapshotAtMs: copy.snapshotAtMs,
					tables: copy.tables,
					rowCount: copy.rowCount,
					byteCount: copy.byteCount,
				};
				return {
					...record,
					digest: await writeWatermark(to, layout, record),
				};
			},
		});
		return { status: "replicated", watermark };
	} catch (error) {
		if (error instanceof ReplicationRefused)
			return {
				status: "refused",
				refusal: error.refusal,
				detail: error.detail,
			};
		throw error;
	}
}

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

export function standbyLagMs(
	watermark: PostgresFleetWatermark,
	nowMs: number,
): number {
	return Math.max(0, nowMs - watermark.snapshotAtMs);
}
