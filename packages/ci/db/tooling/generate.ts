/**
 * Schema source in, checked-in migration out — by the route ADR-0160 names.
 *
 * 1. `@hobo/adapter-drizzle` ingests the Drizzle schema module into the
 *    canonical `SchemaIr`, plus the impedance findings for what the IR cannot
 *    carry.
 * 2. The adapter's engine diffs the previous IR against it through core's
 *    canonical differ. The result is HoBo's `MigrationPlan`: phased, forward
 *    only, stamped with the drizzle-kit version so an upgrade moves the digest.
 * 3. drizzle-kit renders the SQL. This module is the host-supplied emitter the
 *    adapter requires: it classifies each drizzle-kit statement, pairs it with
 *    the plan step it implements, and hands the pairs back through the
 *    adapter, which refuses if any plan step is left without SQL.
 * 4. `toDataMigrationPlan` partitions the SQL by phase and attaches the
 *    violations query the runner executes before it records anything.
 *
 * Two things are added to drizzle-kit's SQL, both mechanical and both visible
 * in the file: an `IF NOT EXISTS` guard on every statement, because the
 * migration has to converge on a database whose tables the embedded DDL already
 * created; and a `-- step:` comment naming the plan step each statement is
 * bound to.
 *
 * A statement the plan has no step for is bound to its table's `create-table`
 * step and recorded as a fallback. That happens for exactly one construct
 * today: an index keyed on a SQL expression, which the canonical IR refuses to
 * record. Any other unplanned statement is refused.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
	createDrizzleDiffEngine,
	type DrizzleImpedanceFinding,
	type EmittedSqlStatement,
	ingestDrizzleSchema,
	stepKey,
	toDataMigrationPlan,
} from "@hobo/adapter-drizzle";
import {
	type MigrationPlan,
	parseSchemaIr,
	SCHEMA_IR_CONTRACT,
	type SchemaIr,
} from "@hobo/core";
import {
	type DrizzleSnapshotJSON,
	generateDrizzleJson,
	generateMigration,
} from "drizzle-kit/api";
import { z } from "zod";
import {
	type FallbackBindingRecord,
	journalPlan,
	readJournal,
	readSnapshot,
	SCHEMA_JOURNAL_CONTRACT,
	SCHEMA_SNAPSHOT_CONTRACT,
	type SchemaJournal,
	type SchemaJournalEntry,
	SchemaMigrationError,
	type SchemaSnapshot,
	STATEMENT_BREAKPOINT,
	serializeJson,
	sha256Hex,
	splitStatements,
} from "./journal.js";

/** What drizzle-kit accepts as a schema module; the toolchain owns this type. */
export type DrizzleSchemaModule = Parameters<typeof generateDrizzleJson>[0];

export interface SchemaSource {
	/** Recorded with every applied migration; the owning package's name. */
	readonly scope: string;
	/** Advisory locks the embedded initialisation takes, shared by the runner. */
	readonly advisoryLocks: readonly string[];
	/** `db/migrations/`, as a directory URL with a trailing slash. */
	readonly directory: URL;
	readonly loadSchema: () => Promise<DrizzleSchemaModule>;
}

export interface GeneratedMigration {
	readonly entry: SchemaJournalEntry;
	readonly sqlText: string;
	readonly snapshot: SchemaSnapshot;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const BASELINE_ID = "0000_baseline";
const Manifest = z.object({ version: z.string().min(1) });

/** The installed drizzle-kit release; it is hashed into every plan digest. */
export async function drizzleKitVersion(): Promise<string> {
	const entry = createRequire(import.meta.url).resolve("drizzle-kit/api");
	const manifest = await readFile(new URL("./package.json", `file://${entry}`));
	return Manifest.parse(JSON.parse(manifest.toString("utf8"))).version;
}

function emptySchemaIr(): SchemaIr {
	return parseSchemaIr({
		contract: SCHEMA_IR_CONTRACT,
		dialect: "postgres",
		tables: [],
	});
}

/**
 * drizzle-kit stamps each snapshot with a random id. The id plays no part in a
 * diff, and a checked-in file that changes on every run cannot be checked.
 */
function withStableIds(snapshot: DrizzleSnapshotJSON): DrizzleSnapshotJSON {
	return { ...snapshot, id: NIL_UUID, prevId: NIL_UUID };
}

/**
 * drizzle-kit walks a schema module in the order its exports enumerate, and
 * that order is the runtime's: a real module namespace sorts its keys, a
 * bundler's stand-in keeps declaration order. Sorting here makes the generated
 * SQL the same wherever it is generated, which a byte-for-byte check needs.
 */
function inExportNameOrder(
	schemaModule: DrizzleSchemaModule,
): DrizzleSchemaModule {
	return Object.fromEntries(
		Object.entries(schemaModule).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		),
	);
}

interface RenderedStatement {
	/** The statement as it will run: drizzle-kit's SQL plus the guard. */
	readonly sql: string;
	readonly table: string;
	/** The plan step this statement implements, as the adapter keys steps. */
	readonly step: string;
	/** A named index or constraint this statement creates, for verification. */
	readonly index: string | undefined;
	readonly constraints: readonly string[];
}

const CREATE_TABLE = /^CREATE TABLE "([^"]+)" /u;
const CREATE_INDEX = /^CREATE (UNIQUE )?INDEX "([^"]+)" ON "([^"]+)" /u;
const ADD_COLUMN = /^ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)" /u;
const NAMED_CONSTRAINT = /^\s*CONSTRAINT "([^"]+)" /gmu;

function expandStep(
	kind: "create-table" | "add-column" | "add-index",
	table: string,
	target: { readonly column?: string; readonly index?: string },
): string {
	return stepKey({
		phase: "expand",
		kind,
		table,
		destructive: false,
		...target,
	});
}

/**
 * Reads one drizzle-kit statement. Only additive statements are understood;
 * anything else (a drop, a type change, a constraint change) is refused rather
 * than passed through, because this tooling does not yet emit the backfill and
 * contract phases those need.
 */
function renderStatement(raw: string): RenderedStatement {
	const statement = raw.trim().replace(/;$/u, "");
	const table = CREATE_TABLE.exec(statement);
	if (table?.[1] !== undefined) {
		return {
			sql: `${statement.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")};`,
			table: table[1],
			step: expandStep("create-table", table[1], {}),
			index: undefined,
			constraints: [...statement.matchAll(NAMED_CONSTRAINT)].flatMap((match) =>
				match[1] === undefined ? [] : [match[1]],
			),
		};
	}
	const index = CREATE_INDEX.exec(statement);
	if (index?.[2] !== undefined && index[3] !== undefined) {
		return {
			sql: `${statement.replace(/ INDEX "/u, ' INDEX IF NOT EXISTS "')};`,
			table: index[3],
			step: expandStep("add-index", index[3], { index: index[2] }),
			index: index[2],
			constraints: [],
		};
	}
	const column = ADD_COLUMN.exec(statement);
	if (column?.[1] !== undefined && column[2] !== undefined) {
		return {
			sql: `${statement.replace(" ADD COLUMN ", " ADD COLUMN IF NOT EXISTS ")};`,
			table: column[1],
			step: expandStep("add-column", column[1], { column: column[2] }),
			index: undefined,
			constraints: [],
		};
	}
	throw new SchemaMigrationError(
		`drizzle-kit emitted a statement this tooling does not emit yet (only CREATE TABLE, CREATE INDEX and ADD COLUMN are): ${statement.split("\n")[0]}`,
	);
}

interface Binding {
	readonly emitted: readonly EmittedSqlStatement[];
	readonly fallbacks: readonly FallbackBindingRecord[];
}

/**
 * Pairs statements with plan steps. A statement whose own step is absent from
 * the plan goes to its table's `create-table` step, and the fallback is
 * recorded with the impedance finding that explains the absence. With neither
 * step in the plan there is nowhere honest to put the statement.
 */
function bindStatements(
	plan: MigrationPlan,
	statements: readonly RenderedStatement[],
	impedance: readonly DrizzleImpedanceFinding[],
): Binding {
	const planned = new Set(plan.steps.map((step) => stepKey(step)));
	const sqlByStep = new Map<string, string[]>();
	const fallbacks: FallbackBindingRecord[] = [];
	for (const statement of statements) {
		let target = statement.step;
		if (!planned.has(target)) {
			target = expandStep("create-table", statement.table, {});
			const finding = impedance.find(
				(entry) =>
					statement.index !== undefined &&
					entry.detail.includes(`"${statement.index}"`),
			);
			if (!planned.has(target) || finding === undefined)
				throw new SchemaMigrationError(
					`no plan step for "${statement.sql.split("\n")[0]}": the canonical schema IR does not see this change, so it cannot be planned. Write this migration by hand.`,
				);
			fallbacks.push({
				statement: statement.step,
				boundTo: target,
				reason: `${finding.code}: ${finding.detail}`,
			});
		}
		sqlByStep.set(target, [...(sqlByStep.get(target) ?? []), statement.sql]);
	}
	const emitted = plan.steps.flatMap((step) => {
		const chunks = sqlByStep.get(stepKey(step));
		return chunks === undefined
			? []
			: [{ step, sql: chunks.join(`\n${STATEMENT_BREAKPOINT}\n`) }];
	});
	return { emitted, fallbacks };
}

function sqlLiteral(text: string): string {
	return `'${text.replaceAll("'", "''")}'`;
}

/** The type `format_type` reports for a column declared with this IR type. */
function catalogType(type: string): string {
	const base = type.replace(/\(.*\)$/u, "").trim();
	if (base === "bigserial") return "bigint";
	if (base === "serial") return "integer";
	if (base === "smallserial") return "smallint";
	return base;
}

function valuesList(rows: readonly string[], empty: string): string {
	return rows.length > 0 ? `VALUES ${rows.join(", ")}` : empty;
}

/**
 * The violations query: every row it returns is something the migration was
 * meant to leave behind and did not. It checks what the canonical IR carries
 * (each column's presence, type and nullability; each index by name) and, by
 * name, the indexes and constraints the SQL created that the IR cannot carry.
 *
 * This is what makes the guarded baseline safe to run against an existing
 * database: `CREATE TABLE IF NOT EXISTS` skips a table that is already there,
 * so a table left at an older layout would otherwise be recorded as migrated.
 */
export function violationsQuery(
	schema: SchemaIr,
	statements: readonly RenderedStatement[],
): string {
	const columns = schema.tables.flatMap((table) =>
		table.columns.map(
			(column) =>
				`(${sqlLiteral(table.name)}, ${sqlLiteral(column.name)}, ${sqlLiteral(catalogType(column.type))}, ${column.nullable})`,
		),
	);
	const indexNames = new Set([
		...schema.tables.flatMap((table) =>
			table.indexes.map((index) => index.name),
		),
		...statements.flatMap((statement) =>
			statement.index === undefined ? [] : [statement.index],
		),
	]);
	const indexes = [...indexNames].sort().map((name) => `(${sqlLiteral(name)})`);
	const constraints = statements.flatMap((statement) =>
		statement.constraints.map(
			(name) => `(${sqlLiteral(statement.table)}, ${sqlLiteral(name)})`,
		),
	);
	return [
		"WITH expected_columns(table_name, column_name, type_name, nullable) AS (",
		`\t${valuesList(columns, "SELECT NULL::text, NULL::text, NULL::text, NULL::boolean WHERE false")}`,
		"), expected_indexes(index_name) AS (",
		`\t${valuesList(indexes, "SELECT NULL::text WHERE false")}`,
		"), expected_constraints(table_name, constraint_name) AS (",
		`\t${valuesList(constraints, "SELECT NULL::text, NULL::text WHERE false")}`,
		"), live_relations AS (",
		"\tSELECT c.oid, c.relname, c.relkind FROM pg_catalog.pg_class c",
		"\tJOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
		"\tWHERE n.nspname = current_schema()",
		"), live_columns AS (",
		"\tSELECT r.relname AS table_name, a.attname AS column_name, a.atttypid, NOT a.attnotnull AS nullable",
		"\tFROM pg_catalog.pg_attribute a JOIN live_relations r ON r.oid = a.attrelid",
		"\tWHERE r.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped",
		")",
		"SELECT 'column' AS object, e.table_name || '.' || e.column_name AS name,",
		"\tCASE WHEN l.column_name IS NULL THEN 'missing'",
		"\t\tWHEN l.atttypid IS DISTINCT FROM pg_catalog.to_regtype(e.type_name) THEN 'type is ' || pg_catalog.format_type(l.atttypid, NULL) || ', expected ' || e.type_name",
		"\t\tELSE 'nullable is ' || l.nullable || ', expected ' || e.nullable END AS problem",
		"FROM expected_columns e",
		"LEFT JOIN live_columns l ON l.table_name = e.table_name AND l.column_name = e.column_name",
		"WHERE l.column_name IS NULL OR l.atttypid IS DISTINCT FROM pg_catalog.to_regtype(e.type_name) OR l.nullable <> e.nullable",
		"UNION ALL",
		"SELECT 'index', e.index_name, 'missing' FROM expected_indexes e",
		"WHERE NOT EXISTS (SELECT 1 FROM live_relations r WHERE r.relkind = 'i' AND r.relname = e.index_name)",
		"UNION ALL",
		"SELECT 'constraint', e.table_name || '.' || e.constraint_name, 'missing' FROM expected_constraints e",
		"WHERE NOT EXISTS (",
		"\tSELECT 1 FROM pg_catalog.pg_constraint k JOIN live_relations r ON r.oid = k.conrelid",
		"\tWHERE r.relname = e.table_name AND k.conname = e.constraint_name",
		")",
		"ORDER BY 1, 2",
	].join("\n");
}

function renderSql(
	scope: string,
	id: string,
	plan: MigrationPlan,
	phases: {
		readonly expand: readonly string[];
		readonly backfill: readonly string[];
		readonly contract: readonly string[];
	},
	emitted: readonly EmittedSqlStatement[],
): string {
	const stepBySql = new Map(
		emitted.map((entry) => [entry.sql, stepKey(entry.step)]),
	);
	const chunks: string[] = [];
	for (const phase of ["expand", "backfill", "contract"] as const) {
		for (const sql of phases[phase]) {
			chunks.push(`-- step: ${stepBySql.get(sql) ?? phase}\n${sql}`);
		}
	}
	const header = [
		"-- HoBo CI relay schema migration. Generated by `pnpm run db:generate`; never edited by hand.",
		`-- scope: ${scope}`,
		`-- migration: ${id}`,
		`-- plan: ${plan.digest} (${plan.engineId} ${plan.engineVersion}, ${plan.steps.length} steps)`,
	].join("\n");
	return `${header}\n${chunks.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`;
}

function nextId(journal: SchemaJournal | undefined, name: string): string {
	const count = journal?.migrations.length ?? 0;
	if (count === 0) return BASELINE_ID;
	if (!/^[a-z0-9_]+$/u.test(name))
		throw new SchemaMigrationError(
			"a migration after the baseline needs --name <lowercase_words>",
		);
	return `${String(count).padStart(4, "0")}_${name}`;
}

/**
 * Plans and renders the migration from `previous` to the schema module as it
 * stands. Returns `undefined` when neither the canonical differ nor drizzle-kit
 * sees a change.
 *
 * The plan is stamped with the installed drizzle-kit version unless
 * `engineVersion` names another. Only the reproducibility check passes one: it
 * re-renders an existing migration under the version that migration was
 * generated with, so a toolchain upgrade fails the check exactly when the
 * upgrade changes the SQL, and not merely because the stamp moved.
 */
export async function planMigration(
	source: SchemaSource,
	previous: SchemaSnapshot | undefined,
	id: string,
	engineVersion?: string,
): Promise<GeneratedMigration | undefined> {
	const schemaModule = inExportNameOrder(await source.loadSchema());
	const { schema: desired, impedance } = ingestDrizzleSchema(schemaModule);
	const before =
		previous?.drizzleKit ?? withStableIds(generateDrizzleJson({}, NIL_UUID));
	const after = withStableIds(generateDrizzleJson(schemaModule, NIL_UUID));
	const statements = (await generateMigration(before, after)).map(
		renderStatement,
	);

	let fallbacks: readonly FallbackBindingRecord[] = [];
	const engine = createDrizzleDiffEngine({
		version: engineVersion ?? (await drizzleKitVersion()),
		toolchainPresent: true,
		emitSql: (plan) => {
			const binding = bindStatements(plan, statements, impedance);
			fallbacks = binding.fallbacks;
			return binding.emitted;
		},
	});
	const plan = engine.diff(previous?.schemaIr ?? emptySchemaIr(), desired);
	if (plan.steps.length === 0 && statements.length === 0) return undefined;
	if (engine.emitSql === undefined)
		throw new SchemaMigrationError("the drizzle engine exposes no SQL emitter");
	const emitted = engine.emitSql(plan);

	const violations = violationsQuery(desired, statements);
	const phases = toDataMigrationPlan({
		plan,
		emitted,
		migrationId: id,
		verify: { afterBackfill: violations },
	});
	const sqlText = renderSql(source.scope, id, plan, phases, emitted);
	return {
		entry: {
			id,
			sql: {
				file: `${id}.sql`,
				sha256: sha256Hex(sqlText),
				statements: splitStatements(sqlText).length,
			},
			plan: journalPlan(plan),
			impedance: impedance.map((finding) => ({ ...finding })),
			fallbacks: [...fallbacks],
			verify: { afterBackfill: phases.verify.afterBackfill },
		},
		sqlText,
		snapshot: { schemaIr: desired, drizzleKit: after },
	};
}

/** `db:generate`: appends the next migration, or reports there is none. */
export async function generateNextMigration(
	source: SchemaSource,
	name: string,
): Promise<GeneratedMigration | undefined> {
	const journal = await readJournal(source.directory);
	const previous = await readSnapshot(source.directory);
	const generated = await planMigration(
		source,
		previous,
		nextId(journal, name),
	);
	if (generated === undefined) return undefined;
	await writeFile(
		new URL(generated.entry.sql.file, source.directory),
		generated.sqlText,
	);
	await writeFile(
		new URL("journal.json", source.directory),
		serializeJson({
			contract: SCHEMA_JOURNAL_CONTRACT,
			scope: source.scope,
			advisoryLocks: source.advisoryLocks,
			migrations: [...(journal?.migrations ?? []), generated.entry],
		}),
	);
	await writeFile(
		new URL("snapshot.json", source.directory),
		serializeJson({
			contract: SCHEMA_SNAPSHOT_CONTRACT,
			...generated.snapshot,
		}),
	);
	return generated;
}

/**
 * `db:check`: every way the checked-in migrations can disagree with the schema
 * module, as a list. Empty means they agree.
 */
export async function checkMigrations(source: SchemaSource): Promise<string[]> {
	const journal = await readJournal(source.directory);
	const snapshot = await readSnapshot(source.directory);
	if (journal === undefined || snapshot === undefined)
		return ["db/migrations has no journal.json or snapshot.json"];
	const problems: string[] = [];
	if (journal.scope !== source.scope)
		problems.push(`journal scope is ${journal.scope}, not ${source.scope}`);
	if (
		JSON.stringify(journal.advisoryLocks) !==
		JSON.stringify(source.advisoryLocks)
	)
		problems.push("journal advisory locks differ from the schema source");

	const pending = await planMigration(source, snapshot, "9999_pending");
	if (pending !== undefined)
		problems.push(
			`db/schema.ts has changes no migration carries (${pending.entry.plan.steps.length} plan steps, ${pending.entry.sql.statements} statements); run db:generate`,
		);

	const baseline = journal.migrations[0];
	if (journal.migrations.length === 1 && baseline !== undefined) {
		// With only the baseline, the whole artifact is reproducible from the
		// schema module, so it is compared byte for byte.
		const regenerated = await planMigration(
			source,
			undefined,
			baseline.id,
			baseline.plan.engineVersion,
		);
		const checkedIn = await readFile(
			new URL(baseline.sql.file, source.directory),
			"utf8",
		);
		if (regenerated?.sqlText !== checkedIn)
			problems.push(`${baseline.sql.file} is not what db/schema.ts generates`);
		if (serializeJson(regenerated?.entry) !== serializeJson(baseline))
			problems.push("journal.json is not what db/schema.ts generates");
		if (
			serializeJson(regenerated?.snapshot) !==
			serializeJson({
				schemaIr: snapshot.schemaIr,
				drizzleKit: snapshot.drizzleKit,
			})
		)
			problems.push("snapshot.json is not what db/schema.ts generates");
	}
	return problems;
}
