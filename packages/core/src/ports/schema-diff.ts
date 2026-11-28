import { createHash } from "node:crypto";
import { CoreParseError } from "../errors.js";
import {
	cloneAsJson,
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import { deepFreeze } from "../parse-utils.js";

// public-contract: the schema id a canonical schema IR is published under.
export const SCHEMA_IR_CONTRACT = "hobo.schema-ir/v1";
// public-contract: the schema id a phased migration plan is published under.
export const MIGRATION_PLAN_CONTRACT = "hobo.migration-plan/v1";

export const CANONICAL_SCHEMA_DIFF_ENGINE_ID = "hobo-canonical"; // public-contract: differ identity stamped into every plan it produces
export const CANONICAL_SCHEMA_DIFF_ENGINE_VERSION = "1.0.0"; // public-contract: participates in every plan digest

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/u;
const MAX_IDENTIFIER_LENGTH = 63;
const TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_ ,.()'[\]]*$/u;
const MAX_TYPE_LENGTH = 128;

// domain-view: parse-time derived type; wire form is SchemaColumnRecord in data-models/schema_ir.proto.
export interface SchemaColumn {
	readonly name: string;
	readonly type: string;
	readonly nullable: boolean;
	readonly primaryKey: boolean;
	readonly unique: boolean;
	readonly defaultExpression?: string;
}

// domain-view: parse-time derived type; wire form is SchemaIndexRecord in data-models/schema_ir.proto.
export interface SchemaIndex {
	readonly name: string;
	readonly columns: readonly string[];
	readonly unique: boolean;
}

// domain-view: parse-time derived type; wire form is SchemaTableRecord in data-models/schema_ir.proto.
export interface SchemaTable {
	readonly name: string;
	readonly columns: readonly SchemaColumn[];
	readonly indexes: readonly SchemaIndex[];
}

// domain-view: parse-time derived type; wire form is SchemaIrRecord in data-models/schema_ir.proto.
export interface SchemaIr {
	readonly contract: typeof SCHEMA_IR_CONTRACT;
	readonly dialect: "postgres";
	readonly tables: readonly SchemaTable[];
}

export const MIGRATION_PHASES = Object.freeze([
	"expand",
	"backfill",
	"contract",
] as const);
export type MigrationPhaseName = (typeof MIGRATION_PHASES)[number];

export const MIGRATION_STEP_KINDS = Object.freeze([
	"create-table",
	"add-column",
	"add-index",
	"widen-column",
	"backfill-column",
	"drop-column",
	"drop-index",
	"drop-table",
	"narrow-column",
] as const);
export type MigrationStepKind = (typeof MIGRATION_STEP_KINDS)[number];

// domain-view: parse-time derived type; wire form is MigrationStepRecord in data-models/schema_ir.proto.
export interface MigrationStep {
	readonly phase: MigrationPhaseName;
	readonly kind: MigrationStepKind;
	readonly table: string;
	readonly column?: string;
	readonly index?: string;
	readonly destructive: boolean;
}

// domain-view: parse-time derived type; wire form is MigrationPlanRecord in data-models/schema_ir.proto.
export interface MigrationPlan {
	readonly contract: typeof MIGRATION_PLAN_CONTRACT;
	readonly steps: readonly MigrationStep[];
	readonly engineId: string;
	readonly engineVersion: string;
	readonly digest: string;
}

export interface SchemaDiffEngine {
	readonly id: string;
	readonly version: string;
	diff(current: SchemaIr, desired: SchemaIr): MigrationPlan;
	emitSql?(
		plan: MigrationPlan,
	): readonly { readonly step: MigrationStep; readonly sql: string }[];
}

export class SchemaIrParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_SCHEMA_IR_PARSE", path, expected, received, message);
		this.name = "SchemaIrParseError";
	}
}

export function parseSchemaIr(value: JsonValue | undefined): SchemaIr {
	const source = expectRecord(value, "schemaIr");
	assertOnlyKeys(source, "schemaIr", ["contract", "dialect", "tables"]);
	if (source.contract !== SCHEMA_IR_CONTRACT) {
		throw new SchemaIrParseError(
			"schemaIr.contract",
			SCHEMA_IR_CONTRACT,
			source.contract,
		);
	}
	if (source.dialect !== "postgres") {
		throw new SchemaIrParseError(
			"schemaIr.dialect",
			"postgres",
			source.dialect,
			'schemaIr.dialect: expected postgres — the canonical IR models one dialect today and refuses rather than pretending to model another (see "HONEST SCOPE")',
		);
	}
	if (!Array.isArray(source.tables)) {
		throw new SchemaIrParseError("schemaIr.tables", "array", source.tables);
	}
	const tableNames = new Set<string>();
	const indexNames = new Set<string>();
	const tables = source.tables.map((entry) => {
		const table = parseTable(entry, indexNames);
		if (tableNames.has(table.name)) {
			throw new SchemaIrParseError(
				"schemaIr.tables",
				"unique table names",
				table.name,
			);
		}
		tableNames.add(table.name);
		return table;
	});
	tables.sort((left, right) => compare(left.name, right.name));
	// SAFETY: assertion required at this I/O or test boundary.
	return deepFreeze({
		contract: SCHEMA_IR_CONTRACT,
		dialect: "postgres",
		tables,
	}) as SchemaIr;
}

export function diffSchemaIr(
	current: SchemaIr,
	desired: SchemaIr,
	engine?: { id: string; version: string },
): MigrationPlan {
	if (current.dialect !== desired.dialect) {
		throw new SchemaIrParseError(
			"diffSchemaIr.dialect",
			`both schemas in dialect ${current.dialect}`,
			desired.dialect,
			"diffSchemaIr: refusing to diff across dialects — a cross-dialect plan would be a portability claim this differ cannot make",
		);
	}
	const engineId = engine?.id ?? CANONICAL_SCHEMA_DIFF_ENGINE_ID;
	const engineVersion = engine?.version ?? CANONICAL_SCHEMA_DIFF_ENGINE_VERSION;

	const currentTables = byName(current.tables);
	const desiredTables = byName(desired.tables);
	const steps: MigrationStep[] = [];

	for (const table of desired.tables) {
		const before = currentTables.get(table.name);
		if (before === undefined) {
			steps.push(step("expand", "create-table", table.name, {}));
			for (const index of table.indexes) {
				steps.push(
					step("expand", "add-index", table.name, { index: index.name }),
				);
			}
			continue;
		}
		diffColumns(before, table, steps);
		diffIndexes(before, table, steps);
	}

	for (const table of current.tables) {
		if (!desiredTables.has(table.name)) {
			steps.push(step("contract", "drop-table", table.name, {}));
		}
	}

	return freezePlan(dedupe(steps).sort(compareSteps), engineId, engineVersion);
}

export const CANONICAL_SCHEMA_DIFF_ENGINE: SchemaDiffEngine = Object.freeze({
	id: CANONICAL_SCHEMA_DIFF_ENGINE_ID,
	version: CANONICAL_SCHEMA_DIFF_ENGINE_VERSION,
	diff(current: SchemaIr, desired: SchemaIr): MigrationPlan {
		return diffSchemaIr(current, desired, {
			id: CANONICAL_SCHEMA_DIFF_ENGINE_ID,
			version: CANONICAL_SCHEMA_DIFF_ENGINE_VERSION,
		});
	},
});

function diffColumns(
	before: SchemaTable,
	after: SchemaTable,
	steps: MigrationStep[],
): void {
	const beforeColumns = byName(before.columns);
	const afterColumns = byName(after.columns);

	for (const column of after.columns) {
		const previous = beforeColumns.get(column.name);
		if (previous === undefined) {
			steps.push(
				step("expand", "add-column", after.name, { column: column.name }),
			);
			if (!column.nullable && column.defaultExpression === undefined) {
				steps.push(
					step("backfill", "backfill-column", after.name, {
						column: column.name,
					}),
				);
				steps.push(
					step("contract", "narrow-column", after.name, {
						column: column.name,
					}),
				);
			}
			continue;
		}
		diffColumnAttributes(after.name, previous, column, steps);
	}

	for (const column of before.columns) {
		if (!afterColumns.has(column.name)) {
			steps.push(
				step("contract", "drop-column", after.name, { column: column.name }),
			);
		}
	}
}

function diffColumnAttributes(
	table: string,
	before: SchemaColumn,
	after: SchemaColumn,
	steps: MigrationStep[],
): void {
	const widen = (): void => {
		steps.push(step("expand", "widen-column", table, { column: after.name }));
	};
	const narrow = (): void => {
		steps.push(
			step("contract", "narrow-column", table, { column: after.name }),
		);
	};

	const typeChange = classifyTypeChange(before.type, after.type);
	if (typeChange === "widen") widen();
	if (typeChange === "narrow") narrow();

	if (before.nullable && !after.nullable) {
		steps.push(
			step("backfill", "backfill-column", table, { column: after.name }),
		);
		narrow();
	}
	if (!before.nullable && after.nullable) widen();

	if (!before.unique && after.unique) narrow();
	if (before.unique && !after.unique) widen();

	if (before.primaryKey !== after.primaryKey) narrow();

	if (before.defaultExpression !== after.defaultExpression) widen();
}

function diffIndexes(
	before: SchemaTable,
	after: SchemaTable,
	steps: MigrationStep[],
): void {
	const beforeIndexes = byName(before.indexes);
	const afterIndexes = byName(after.indexes);

	for (const index of after.indexes) {
		const previous = beforeIndexes.get(index.name);
		if (previous === undefined || !sameIndexLayout(previous, index)) {
			steps.push(
				step("expand", "add-index", after.name, { index: index.name }),
			);
		}
	}

	for (const index of before.indexes) {
		const next = afterIndexes.get(index.name);
		if (next === undefined || !sameIndexLayout(index, next)) {
			steps.push(
				step("contract", "drop-index", after.name, { index: index.name }),
			);
		}
	}
}

function sameIndexLayout(left: SchemaIndex, right: SchemaIndex): boolean {
	return (
		left.unique === right.unique &&
		left.columns.length === right.columns.length &&
		left.columns.every((column, position) => column === right.columns[position])
	);
}

export function classifyTypeChange(
	from: string,
	to: string,
): "same" | "widen" | "narrow" {
	const left = normalizeType(from);
	const right = normalizeType(to);
	if (left.text === right.text) return "same";
	if (left.base === right.base) {
		if (left.parameters.length === 0 && right.parameters.length > 0) {
			return "narrow";
		}
		if (right.parameters.length === 0) return "widen";
		if (left.parameters.length !== right.parameters.length) return "narrow";
		return left.parameters.every(
			(parameter, position) => parameter <= (right.parameters[position] ?? -1),
		)
			? "widen"
			: "narrow";
	}
	const family = TYPE_FAMILIES.find(
		(candidate) =>
			candidate.includes(left.base) && candidate.includes(right.base),
	);
	if (family === undefined) return "narrow";
	return family.indexOf(right.base) > family.indexOf(left.base)
		? "widen"
		: "narrow";
}

const TYPE_FAMILIES: readonly (readonly string[])[] = Object.freeze([
	Object.freeze(["smallint", "integer", "bigint", "numeric"]),
	Object.freeze(["real", "double precision"]),
	Object.freeze(["char", "varchar", "text"]),
]);

const TYPE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	bool: "boolean",
	character: "char",
	"character varying": "varchar",
	decimal: "numeric",
	float4: "real",
	float8: "double precision",
	int: "integer",
	int2: "smallint",
	int4: "integer",
	int8: "bigint",
	timestamptz: "timestamp with time zone",
});

function normalizeType(raw: string) {
	const collapsed = raw.trim().toLowerCase().replace(/\s+/gu, " ");
	const match = collapsed.match(/^([^(]+?)\s*\(([^)]*)\)$/u);
	const rawBase = (match?.[1] ?? collapsed).trim();
	const base =
		// SAFETY: assertion required at this I/O or test boundary.
		(TYPE_ALIASES as Readonly<Record<string, string | undefined>>)[rawBase] ??
		rawBase;
	const parameters =
		match === null
			? []
			: (match[2] ?? "")
					.split(",")
					.map((parameter) => Number.parseInt(parameter.trim(), 10))
					.filter((parameter) => Number.isSafeInteger(parameter));
	const text =
		parameters.length > 0 ? `${base}(${parameters.join(",")})` : base;
	return { text, base, parameters };
}

function step(
	phase: MigrationPhaseName,
	kind: MigrationStepKind,
	table: string,
	target: { readonly column?: string; readonly index?: string },
): MigrationStep {
	return {
		phase,
		kind,
		table,
		...(target.column !== undefined ? { column: target.column } : undefined),
		...(target.index !== undefined ? { index: target.index } : undefined),
		destructive: phase === "contract",
	};
}

function dedupe(steps: readonly MigrationStep[]): MigrationStep[] {
	const seen = new Set<string>();
	const unique: MigrationStep[] = [];
	for (const candidate of steps) {
		const key = `${candidate.phase} ${candidate.kind} ${candidate.table} ${stepTarget(candidate)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function stepTarget(candidate: MigrationStep): string {
	return candidate.column ?? candidate.index ?? "";
}

function compareSteps(left: MigrationStep, right: MigrationStep): number {
	return (
		MIGRATION_PHASES.indexOf(left.phase) -
			MIGRATION_PHASES.indexOf(right.phase) ||
		compare(left.table, right.table) ||
		MIGRATION_STEP_KINDS.indexOf(left.kind) -
			MIGRATION_STEP_KINDS.indexOf(right.kind) ||
		compare(stepTarget(left), stepTarget(right))
	);
}

function freezePlan(
	steps: readonly MigrationStep[],
	engineId: string,
	engineVersion: string,
): MigrationPlan {
	const digest = `sha256:${createHash("sha256")
		.update(canonicalJson(cloneAsJson({ steps, engineId, engineVersion })))
		.digest("hex")}`;
	// SAFETY: assertion required at this I/O or test boundary.
	return deepFreeze({
		contract: MIGRATION_PLAN_CONTRACT,
		steps,
		engineId,
		engineVersion,
		digest,
	}) as MigrationPlan;
}

function canonicalJson(value: JsonValue | undefined): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	if (value !== null && isJsonObject(value)) {
		// SAFETY: assertion required at this I/O or test boundary.
		const entries = Object.entries(value as JsonObject)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => compare(left, right));
		return `{${entries
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function byName<T extends { readonly name: string }>(
	entries: readonly T[],
): Map<string, T> {
	return new Map(entries.map((entry) => [entry.name, entry]));
}

function parseTable(
	value: JsonValue | undefined,
	indexNames: Set<string>,
): SchemaTable {
	const source = expectRecord(value, "schemaIr.tables[]");
	assertOnlyKeys(source, "schemaIr.tables[]", ["name", "columns", "indexes"]);
	const name = parseIdentifier(source.name, "schemaIr.tables[].name");
	if (!Array.isArray(source.columns) || source.columns.length === 0) {
		throw new SchemaIrParseError(
			`schemaIr.tables[${name}].columns`,
			"non-empty array",
			source.columns,
		);
	}
	const columnNames = new Set<string>();
	const columns = source.columns.map((entry) => {
		const column = parseColumn(entry, name);
		if (columnNames.has(column.name)) {
			throw new SchemaIrParseError(
				`schemaIr.tables[${name}].columns`,
				"unique column names",
				column.name,
			);
		}
		columnNames.add(column.name);
		return column;
	});
	columns.sort((left, right) => compare(left.name, right.name));

	const rawIndexes = source.indexes ?? [];
	if (!Array.isArray(rawIndexes)) {
		throw new SchemaIrParseError(
			`schemaIr.tables[${name}].indexes`,
			"array",
			source.indexes,
		);
	}
	const indexes = rawIndexes.map((entry) => {
		const index = parseIndex(entry, name, columnNames);
		if (indexNames.has(index.name)) {
			throw new SchemaIrParseError(
				`schemaIr.tables[${name}].indexes`,
				"index names unique across the schema",
				index.name,
			);
		}
		indexNames.add(index.name);
		return index;
	});
	indexes.sort((left, right) => compare(left.name, right.name));

	return { name, columns, indexes };
}

function parseColumn(
	value: JsonValue | undefined,
	table: string,
): SchemaColumn {
	const path = `schemaIr.tables[${table}].columns[]`;
	const source = expectRecord(value, path);
	assertOnlyKeys(source, path, [
		"name",
		"type",
		"nullable",
		"primaryKey",
		"unique",
		"defaultExpression",
	]);
	const name = parseIdentifier(source.name, `${path}.name`);
	const type = parseTypeToken(source.type, `${path}.type`);
	const nullable = parseBoolean(source.nullable, `${path}.nullable`);
	const primaryKey = parseBoolean(source.primaryKey, `${path}.primaryKey`);
	const unique = parseBoolean(source.unique, `${path}.unique`);
	if (primaryKey && nullable) {
		throw new SchemaIrParseError(
			`${path}.nullable`,
			"false when primaryKey is true",
			true,
			`${path}: a primary-key column cannot be nullable`,
		);
	}
	if (source.defaultExpression === undefined) {
		return { name, type, nullable, primaryKey, unique };
	}
	if (
		!isJsonString(source.defaultExpression) ||
		source.defaultExpression.length === 0
	) {
		throw new SchemaIrParseError(
			`${path}.defaultExpression`,
			"non-empty string",
			source.defaultExpression,
		);
	}
	return {
		name,
		type,
		nullable,
		primaryKey,
		unique,
		defaultExpression: source.defaultExpression,
	};
}

function parseIndex(
	value: JsonValue | undefined,
	table: string,
	columnNames: ReadonlySet<string>,
): SchemaIndex {
	const path = `schemaIr.tables[${table}].indexes[]`;
	const source = expectRecord(value, path);
	assertOnlyKeys(source, path, ["name", "columns", "unique"]);
	const name = parseIdentifier(source.name, `${path}.name`);
	if (!Array.isArray(source.columns) || source.columns.length === 0) {
		throw new SchemaIrParseError(
			`${path}.columns`,
			"non-empty array",
			source.columns,
		);
	}
	const seen = new Set<string>();
	const columns = source.columns.map((entry, position) => {
		const column = parseIdentifier(entry, `${path}.columns[${position}]`);
		if (seen.has(column)) {
			throw new SchemaIrParseError(
				`${path}.columns`,
				"distinct column names",
				column,
			);
		}
		if (!columnNames.has(column)) {
			throw new SchemaIrParseError(
				`${path}.columns`,
				`a column declared on table ${table}`,
				column,
			);
		}
		seen.add(column);
		return column;
	});
	return {
		name,
		columns,
		unique: parseBoolean(source.unique, `${path}.unique`),
	};
}

function parseIdentifier(value: JsonValue | undefined, path: string): string {
	if (
		!isJsonString(value) ||
		value.length === 0 ||
		value.length > MAX_IDENTIFIER_LENGTH ||
		!IDENTIFIER_PATTERN.test(value)
	) {
		throw new SchemaIrParseError(
			path,
			`unquoted SQL identifier matching ${IDENTIFIER_PATTERN.source} (<= ${MAX_IDENTIFIER_LENGTH} chars)`,
			value,
		);
	}
	return value;
}

function parseTypeToken(value: JsonValue | undefined, path: string): string {
	if (
		!isJsonString(value) ||
		value.length === 0 ||
		value.length > MAX_TYPE_LENGTH ||
		!TYPE_PATTERN.test(value)
	) {
		throw new SchemaIrParseError(
			path,
			`SQL type token matching ${TYPE_PATTERN.source} (<= ${MAX_TYPE_LENGTH} chars)`,
			value,
		);
	}
	return value;
}

function parseBoolean(value: JsonValue | undefined, path: string): boolean {
	if (!isJsonBoolean(value)) {
		throw new SchemaIrParseError(path, "boolean", value);
	}
	return value;
}

function expectRecord(value: JsonValue | undefined, path: string): JsonObject {
	if (!isJsonObject(value) || value === null || Array.isArray(value)) {
		throw new SchemaIrParseError(path, "object", value);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return value as JsonObject;
}

function assertOnlyKeys(
	source: JsonObject,
	path: string,
	allowed: readonly string[],
): void {
	for (const key of Object.keys(source)) {
		if (!allowed.includes(key)) {
			throw new SchemaIrParseError(
				path,
				`only keys ${allowed.join(", ")}`,
				key,
			);
		}
	}
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
