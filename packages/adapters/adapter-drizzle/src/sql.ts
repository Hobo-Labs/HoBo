import { createHash } from "node:crypto";
import {
	classifyTypeChange,
	diffSchemaIr,
	type MigrationPlan,
	type MigrationStep,
	type SchemaColumn,
	type SchemaIr,
} from "@hobo/core";
import {
	type DrizzleSnapshotJSON,
	generateDrizzleJson,
	generateMigration,
} from "drizzle-kit/api";
import {
	DEFAULT_DRIZZLE_ENGINE_VERSION,
	DRIZZLE_ENGINE_ID,
	type EmittedSqlStatement,
	groupEmittedSql,
	stepKey,
} from "./engine.js";
import { DrizzleAdapterError } from "./errors.js";
import { ingestDrizzleSchema } from "./ingest.js";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";

export type DrizzleSchemaExports = Parameters<typeof generateDrizzleJson>[0];

export interface GenerateDrizzleMigrationInput {
	readonly current: DrizzleSchemaExports;
	readonly desired: DrizzleSchemaExports;
	readonly backfills?: Readonly<Record<string, string>>;
}

export interface DrizzleMigrationArtifact {
	readonly plan: MigrationPlan;
	readonly statements: readonly EmittedSqlStatement[];
	readonly sqlDigest: string;
}

type SnapshotTable = DrizzleSnapshotJSON["tables"][string];
type SnapshotColumn = SnapshotTable["columns"][string];

export async function generateDrizzleMigration(
	input: GenerateDrizzleMigrationInput,
): Promise<DrizzleMigrationArtifact> {
	const current = ingestDrizzleSchema(input.current);
	const desired = ingestDrizzleSchema(input.desired);
	const findings = [...current.impedance, ...desired.impedance];
	if (findings.length > 0) {
		throw emissionError(
			`Schema contains constructs the migration plan cannot represent: ${findings.map((finding) => finding.code).join(", ")}.`,
		);
	}
	const plan = diffSchemaIr(current.schema, desired.schema, {
		id: DRIZZLE_ENGINE_ID,
		version: DEFAULT_DRIZZLE_ENGINE_VERSION,
	});
	let snapshot = generateDrizzleJson(input.current);
	const target = generateDrizzleJson(input.desired);
	assertSupportedSnapshot(snapshot);
	assertSupportedSnapshot(target);
	const backfills = input.backfills ?? {};
	const expectedBackfills = new Set(
		plan.steps.filter((step) => step.kind === "backfill-column").map(stepKey),
	);
	for (const key of Object.keys(backfills)) {
		if (!expectedBackfills.has(key)) {
			throw emissionError(`Backfill does not match a plan step: ${key}.`);
		}
	}
	const statements: EmittedSqlStatement[] = [];
	for (const step of plan.steps) {
		let sql: readonly string[];
		if (step.kind === "backfill-column") {
			const backfill = backfills[stepKey(step)];
			if (!isJsonString(backfill) || backfill.trim() === "") {
				throw emissionError(`Backfill SQL is required for ${stepKey(step)}.`);
			}
			sql = [backfill];
		} else {
			const next = structuredClone(snapshot);
			const needsBackfill = plan.steps.some(
				(candidate) =>
					candidate.kind === "backfill-column" &&
					candidate.table === step.table &&
					candidate.column === step.column,
			);
			const needsContract = plan.steps.some(
				(candidate) =>
					candidate.kind === "narrow-column" &&
					candidate.table === step.table &&
					candidate.column === step.column,
			);
			applyStep(
				next,
				target,
				current.schema,
				desired.schema,
				step,
				needsBackfill,
				needsContract,
			);
			sql = prepareStepSql(
				step,
				current.schema,
				desired.schema,
				await generateMigration(snapshot, next),
			);
			if (sql.length === 0) {
				throw emissionError(`Drizzle emitted no SQL for ${stepKey(step)}.`);
			}
			snapshot = next;
		}
		for (const statement of sql) statements.push({ step, sql: statement });
	}
	const remainder = await generateMigration(snapshot, target);
	if (remainder.length > 0) {
		throw emissionError(
			"Drizzle found schema changes outside the migration plan.",
		);
	}
	groupEmittedSql(plan, statements);
	const frozenStatements = Object.freeze(
		statements.map((entry) =>
			Object.freeze({ step: entry.step, sql: entry.sql }),
		),
	);
	const sqlDigest = `sha256:${createHash("sha256")
		.update(
			JSON.stringify({ planDigest: plan.digest, statements: frozenStatements }),
		)
		.digest("hex")}`;
	return Object.freeze({ plan, statements: frozenStatements, sqlDigest });
}

function prepareStepSql(
	step: MigrationStep,
	before: SchemaIr,
	after: SchemaIr,
	statements: readonly string[],
): readonly string[] {
	const removesPrimaryKey =
		step.kind === "narrow-column" &&
		step.column !== undefined &&
		columnOf(before, step.table, step.column)?.primaryKey === true &&
		columnOf(after, step.table, step.column)?.primaryKey === false;
	let primaryKeyReplacements = 0;
	const result = statements.map((statement) => {
		if (
			removesPrimaryKey &&
			statement.includes("can't automatically get name for primary key") &&
			statement.includes("-- ALTER TABLE") &&
			statement.includes('DROP CONSTRAINT "<constraint_name>"')
		) {
			primaryKeyReplacements++;
			return dropPrimaryKeySql(step.table);
		}
		if (/^\s*(?:\/\*|--)/u.test(statement))
			throw emissionError(
				`Drizzle emitted a non-executable statement for ${stepKey(step)}.`,
			);
		return statement;
	});
	if (removesPrimaryKey && primaryKeyReplacements !== 1)
		throw emissionError(
			`Drizzle did not emit the expected primary key removal for ${stepKey(step)}.`,
		);
	return result;
}

function dropPrimaryKeySql(table: string): string {
	const relation = `'public."${table}"'::regclass`;
	return `DO $hobo$
DECLARE primary_key_name text;
BEGIN
  SELECT conname INTO STRICT primary_key_name FROM pg_catalog.pg_constraint WHERE conrelid = ${relation} AND contype = 'p';
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', ${relation}, primary_key_name);
END
$hobo$;`;
}

function applyStep(
	snapshot: DrizzleSnapshotJSON,
	target: DrizzleSnapshotJSON,
	before: SchemaIr,
	after: SchemaIr,
	step: MigrationStep,
	needsBackfill: boolean,
	needsContract: boolean,
): void {
	const tableKey = `public.${step.table}`;
	if (step.kind === "create-table") {
		const table = target.tables[tableKey];
		if (!table || snapshot.tables[tableKey])
			throw emissionError(`Invalid table step: ${stepKey(step)}.`);
		snapshot.tables[tableKey] = { ...structuredClone(table), indexes: {} };
		return;
	}
	if (step.kind === "drop-table") {
		if (!snapshot.tables[tableKey])
			throw emissionError(`Missing table for ${stepKey(step)}.`);
		delete snapshot.tables[tableKey];
		return;
	}
	const table = snapshot.tables[tableKey];
	if (!table) throw emissionError(`Missing table for ${stepKey(step)}.`);
	if (step.kind === "drop-index") {
		if (!step.index || !table.indexes[step.index])
			throw emissionError(`Missing index for ${stepKey(step)}.`);
		delete table.indexes[step.index];
		return;
	}
	const desiredTable = target.tables[tableKey];
	if (!desiredTable)
		throw emissionError(`Missing target table for ${stepKey(step)}.`);
	if (step.kind === "add-index") {
		const index = step.index && desiredTable.indexes[step.index];
		if (!step.index || !index || table.indexes[step.index])
			throw emissionError(`Invalid index step: ${stepKey(step)}.`);
		table.indexes[step.index] = structuredClone(index);
		return;
	}
	const name = step.column;
	if (!name) throw emissionError(`Missing column for ${stepKey(step)}.`);
	if (step.kind === "drop-column") {
		if (!table.columns[name])
			throw emissionError(`Missing column for ${stepKey(step)}.`);
		delete table.columns[name];
		copyColumnConstraints(table, desiredTable, name);
		return;
	}
	const desiredColumn = desiredTable.columns[name];
	const targetColumn = columnOf(after, step.table, name);
	if (!desiredColumn || !targetColumn)
		throw emissionError(`Missing target column for ${stepKey(step)}.`);
	if (step.kind === "add-column") {
		if (table.columns[name])
			throw emissionError(`Column already exists for ${stepKey(step)}.`);
		const column = structuredClone(desiredColumn);
		if (needsBackfill) column.notNull = false;
		if (needsContract) column.primaryKey = false;
		table.columns[name] = column;
		copyColumnConstraints(table, desiredTable, name);
		return;
	}
	const column = table.columns[name];
	if (!column) throw emissionError(`Missing column for ${stepKey(step)}.`);
	const original = columnOf(before, step.table, name);
	if (
		original &&
		original.type.toLowerCase() !== targetColumn.type.toLowerCase() &&
		(isSerialType(original.type) || isSerialType(targetColumn.type))
	) {
		throw emissionError(
			`Changing a serial column type is not supported for ${stepKey(step)}.`,
		);
	}
	if (step.kind === "widen-column") {
		if (
			original &&
			classifyTypeChange(original.type, targetColumn.type) === "widen"
		) {
			column.type = desiredColumn.type;
		}
		if (original && !original.nullable && targetColumn.nullable)
			column.notNull = false;
		if (original?.unique && !targetColumn.unique)
			copyColumnConstraints(table, desiredTable, name);
		copyDefault(column, desiredColumn);
		return;
	}
	if (step.kind === "narrow-column") {
		if (
			original &&
			classifyTypeChange(original.type, targetColumn.type) === "narrow"
		) {
			column.type = desiredColumn.type;
		}
		column.notNull = desiredColumn.notNull;
		column.primaryKey = desiredColumn.primaryKey;
		if (!original?.unique && targetColumn.unique)
			copyColumnConstraints(table, desiredTable, name);
		return;
	}
	throw emissionError(`Unsupported plan step: ${stepKey(step)}.`);
}

function isSerialType(type: string): boolean {
	return ["smallserial", "serial", "bigserial"].includes(
		type.trim().toLowerCase(),
	);
}

function columnOf(
	schema: SchemaIr,
	table: string,
	column: string,
): SchemaColumn | undefined {
	return schema.tables
		.find((candidate) => candidate.name === table)
		?.columns.find((candidate) => candidate.name === column);
}

function copyDefault(column: SnapshotColumn, target: SnapshotColumn): void {
	if (Object.hasOwn(target, "default")) column.default = target.default;
	else delete column.default;
}

function copyColumnConstraints(
	table: SnapshotTable,
	target: SnapshotTable,
	column: string,
): void {
	for (const name of Object.keys(table.uniqueConstraints)) {
		if (table.uniqueConstraints[name]?.columns.includes(column))
			delete table.uniqueConstraints[name];
	}
	for (const name of Object.keys(target.uniqueConstraints)) {
		const constraint = target.uniqueConstraints[name];
		if (constraint?.columns.includes(column))
			table.uniqueConstraints[name] = structuredClone(constraint);
	}
}

function assertSupportedSnapshot(snapshot: DrizzleSnapshotJSON): void {
	for (const collection of [
		snapshot.enums,
		snapshot.schemas,
		snapshot.sequences,
		snapshot.roles,
		snapshot.policies,
		snapshot.views,
	]) {
		if (Object.keys(collection).length > 0)
			throw emissionError(
				"Drizzle snapshot contains objects outside the canonical schema IR.",
			);
	}
	for (const tableName of Object.keys(snapshot.tables)) {
		const table = snapshot.tables[tableName];
		if (!table)
			throw emissionError(
				`Missing table ${tableName} in the Drizzle snapshot.`,
			);
		if (
			(table.schema !== "" && table.schema !== "public") ||
			table.isRLSEnabled ||
			Object.keys(table.foreignKeys).length ||
			Object.keys(table.compositePrimaryKeys).length ||
			Object.keys(table.policies).length ||
			Object.keys(table.checkConstraints).length
		) {
			throw emissionError(
				`Table ${table.name} contains features outside the canonical schema IR.`,
			);
		}
		for (const name of Object.keys(table.uniqueConstraints)) {
			const constraint = table.uniqueConstraints[name];
			if (!constraint)
				throw emissionError(`Missing unique constraint ${name}.`);
			if (constraint.columns.length !== 1 || constraint.nullsNotDistinct)
				throw emissionError(
					`Table ${table.name} contains a unique constraint outside the canonical schema IR.`,
				);
		}
		let primaryKeyCount = 0;
		for (const name of Object.keys(table.columns)) {
			const column = table.columns[name];
			if (!column) throw emissionError(`Missing column ${table.name}.${name}.`);
			if (column.primaryKey && ++primaryKeyCount > 1)
				throw emissionError(
					`Table ${table.name} contains multiple primary keys.`,
				);
			if (
				column.identity ||
				column.generated ||
				column.typeSchema ||
				column.nullsNotDistinct
			)
				throw emissionError(
					`Column ${table.name}.${column.name} contains features outside the canonical schema IR.`,
				);
		}
		for (const name of Object.keys(table.indexes)) {
			const index = table.indexes[name];
			if (!index) throw emissionError(`Missing index ${name}.`);
			if (
				index.where ||
				index.concurrently ||
				index.method !== "btree" ||
				Object.keys(index.with).length ||
				index.columns.some(
					(column: JsonValue) =>
						!isJsonObject(column) ||
						column.isExpression !== false ||
						column.asc !== true ||
						column.nulls !== "last" ||
						column.opclass !== undefined,
				)
			) {
				throw emissionError(
					`Index ${index.name} contains features outside the canonical schema IR.`,
				);
			}
		}
	}
}

function emissionError(message: string): DrizzleAdapterError {
	return new DrizzleAdapterError(
		"SQL_EMISSION_INCOMPLETE",
		message,
		"Resolve the reported schema or backfill issue before executing the migration.",
	);
}
