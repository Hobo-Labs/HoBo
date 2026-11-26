// ADR-0160: the canonical schema IR parse boundary and the forward-only
// expand/backfill/contract differ. The cases below pin what makes a plan
// reviewable — determinism under input permutation, destructive work confined
// to the contract phase, no inverse steps, and a digest that moves when the
// engine version moves even though the steps are identical.
import { describe, expect, it } from "vitest";

import {
	CANONICAL_SCHEMA_DIFF_ENGINE,
	CANONICAL_SCHEMA_DIFF_ENGINE_ID,
	CANONICAL_SCHEMA_DIFF_ENGINE_VERSION,
	classifyTypeChange,
	diffSchemaIr,
	MIGRATION_PLAN_CONTRACT,
	MIGRATION_STEP_KINDS,
	type MigrationStep,
	parseSchemaIr,
	SCHEMA_IR_CONTRACT,
	type SchemaColumn,
	type SchemaIndex,
	type SchemaIr,
	SchemaIrParseError,
	type SchemaTable,
} from "../src/index.js";

function column(overrides: Partial<SchemaColumn> = {}): SchemaColumn {
	return {
		name: "id",
		type: "integer",
		nullable: false,
		primaryKey: true,
		unique: true,
		...overrides,
	};
}

function table(overrides: Partial<SchemaTable> = {}): SchemaTable {
	return {
		name: "accounts",
		columns: [column()],
		indexes: [],
		...overrides,
	};
}

function ir(tables: readonly SchemaTable[]): SchemaIr {
	return {
		contract: SCHEMA_IR_CONTRACT,
		dialect: "postgres",
		tables,
	};
}

function index(overrides: Partial<SchemaIndex> = {}): SchemaIndex {
	return {
		name: "accounts_email_idx",
		columns: ["email"],
		unique: false,
		...overrides,
	};
}

function kinds(steps: readonly MigrationStep[]): string[] {
	return steps.map(
		(step) =>
			`${step.phase}:${step.kind}:${step.table}:${step.column ?? step.index ?? ""}`,
	);
}

describe("parseSchemaIr", () => {
	it("returns a deeply frozen, name-sorted derived type", () => {
		const parsed = parseSchemaIr({
			contract: SCHEMA_IR_CONTRACT,
			dialect: "postgres",
			tables: [
				{
					name: "widgets",
					columns: [
						{
							name: "name",
							type: "text",
							nullable: true,
							primaryKey: false,
							unique: false,
						},
						{
							name: "id",
							type: "integer",
							nullable: false,
							primaryKey: true,
							unique: true,
						},
					],
					indexes: [],
				},
				{
					name: "accounts",
					columns: [
						{
							name: "id",
							type: "integer",
							nullable: false,
							primaryKey: true,
							unique: true,
						},
					],
				},
			],
		});
		expect(parsed.tables.map((entry) => entry.name)).toEqual([
			"accounts",
			"widgets",
		]);
		expect(parsed.tables[1]?.columns.map((entry) => entry.name)).toEqual([
			"id",
			"name",
		]);
		expect(parsed.tables[0]?.indexes).toEqual([]);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.tables[0]?.columns[0])).toBe(true);
	});

	it("omits defaultExpression rather than carrying an undefined value", () => {
		const parsed = parseSchemaIr(
			ir([table({ columns: [column({ name: "id" })] })]),
		);
		expect(
			Object.hasOwn(parsed.tables[0]?.columns[0] ?? {}, "defaultExpression"),
		).toBe(false);
	});

	it.each([
		[
			{ contract: "hobo.schema-ir/v2", dialect: "postgres", tables: [] },
			"wrong contract",
		],
		[
			{ contract: SCHEMA_IR_CONTRACT, dialect: "sqlite", tables: [] },
			"unsupported dialect",
		],
		[
			{ contract: SCHEMA_IR_CONTRACT, dialect: "postgres" },
			"tables must be an array",
		],
		["not an object", "a string is not a schema IR"],
	])("refuses %o (%s)", (value) => {
		expect(() => parseSchemaIr(value)).toThrow(SchemaIrParseError);
	});

	it.each([
		[[table(), table()], "duplicate table names"],
		[[table({ columns: [column(), column()] })], "duplicate column names"],
		[[table({ columns: [] })], "a table with no columns"],
		[
			[table({ columns: [column({ name: "drop table x" })] })],
			"an identifier outside the unquoted-SQL grammar",
		],
		[
			[table({ columns: [column({ type: "text; drop table x" })] })],
			"a type token carrying a statement separator",
		],
		[
			[table({ columns: [column({ primaryKey: true, nullable: true })] })],
			"a nullable primary key",
		],
		[
			[table({ indexes: [index({ columns: ["missing"] })] })],
			"an index over an undeclared column",
		],
		[
			[
				table({ indexes: [index()], columns: [column({ name: "email" })] }),
				table({
					name: "profiles",
					columns: [column({ name: "email" })],
					indexes: [index()],
				}),
			],
			"an index name reused across tables",
		],
	])("refuses a schema with %o — %s", (tables) => {
		expect(() => parseSchemaIr(ir(tables))).toThrow(SchemaIrParseError);
	});

	it("reports a typed code on every refusal", () => {
		try {
			parseSchemaIr(ir([table({ columns: [] })]));
			throw new Error("expected a parse refusal");
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as SchemaIrParseError).code).toBe(
				"HOBO_CORE_SCHEMA_IR_PARSE",
			);
		}
	});
});

describe("diffSchemaIr", () => {
	it("produces an empty plan for identical schemas", () => {
		const schema = parseSchemaIr(ir([table()]));
		const plan = diffSchemaIr(schema, schema);
		expect(plan.steps).toEqual([]);
		expect(plan.contract).toBe(MIGRATION_PLAN_CONTRACT);
		expect(plan.engineId).toBe(CANONICAL_SCHEMA_DIFF_ENGINE_ID);
		expect(plan.engineVersion).toBe(CANONICAL_SCHEMA_DIFF_ENGINE_VERSION);
		expect(plan.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(Object.isFrozen(plan)).toBe(true);
	});

	it("puts an added nullable column in expand, non-destructive", () => {
		const before = parseSchemaIr(ir([table()]));
		const after = parseSchemaIr(
			ir([
				table({
					columns: [
						column(),
						column({
							name: "email",
							type: "text",
							nullable: true,
							primaryKey: false,
							unique: false,
						}),
					],
				}),
			]),
		);
		const plan = diffSchemaIr(before, after);
		expect(kinds(plan.steps)).toEqual(["expand:add-column:accounts:email"]);
		expect(plan.steps[0]?.destructive).toBe(false);
	});

	it("stages a NOT NULL column without a default as expand → backfill → contract", () => {
		const before = parseSchemaIr(ir([table()]));
		const after = parseSchemaIr(
			ir([
				table({
					columns: [
						column(),
						column({
							name: "email",
							type: "text",
							nullable: false,
							primaryKey: false,
							unique: false,
						}),
					],
				}),
			]),
		);
		expect(kinds(diffSchemaIr(before, after).steps)).toEqual([
			"expand:add-column:accounts:email",
			"backfill:backfill-column:accounts:email",
			"contract:narrow-column:accounts:email",
		]);
	});

	it("needs no backfill when the added NOT NULL column carries a default", () => {
		const before = parseSchemaIr(ir([table()]));
		const after = parseSchemaIr(
			ir([
				table({
					columns: [
						column(),
						column({
							name: "state",
							type: "text",
							nullable: false,
							primaryKey: false,
							unique: false,
							defaultExpression: "'pending'",
						}),
					],
				}),
			]),
		);
		expect(kinds(diffSchemaIr(before, after).steps)).toEqual([
			"expand:add-column:accounts:state",
		]);
	});

	it("puts a dropped column in contract and marks it destructive", () => {
		const before = parseSchemaIr(
			ir([
				table({
					columns: [
						column(),
						column({
							name: "legacy",
							type: "text",
							nullable: true,
							primaryKey: false,
							unique: false,
						}),
					],
				}),
			]),
		);
		const after = parseSchemaIr(ir([table()]));
		const plan = diffSchemaIr(before, after);
		expect(kinds(plan.steps)).toEqual(["contract:drop-column:accounts:legacy"]);
		expect(plan.steps[0]?.destructive).toBe(true);
	});

	it("creates a new table with its indexes in expand and drops a removed table in contract", () => {
		const accounts = table({
			columns: [
				column(),
				column({
					name: "email",
					type: "text",
					nullable: true,
					primaryKey: false,
					unique: false,
				}),
			],
			indexes: [index()],
		});
		const before = parseSchemaIr(ir([table({ name: "legacy_jobs" })]));
		const after = parseSchemaIr(ir([accounts]));
		const plan = diffSchemaIr(before, after);
		expect(kinds(plan.steps)).toEqual([
			"expand:create-table:accounts:",
			"expand:add-index:accounts:accounts_email_idx",
			"contract:drop-table:legacy_jobs:",
		]);
		expect(plan.steps.filter((step) => step.destructive)).toHaveLength(1);
	});

	it("classifies widenings into expand and narrowings into contract", () => {
		const base = (type: string): SchemaIr =>
			ir([
				table({
					columns: [
						column({
							name: "amount",
							type,
							nullable: true,
							primaryKey: false,
							unique: false,
						}),
					],
				}),
			]);
		expect(
			kinds(
				diffSchemaIr(
					parseSchemaIr(base("integer")),
					parseSchemaIr(base("bigint")),
				).steps,
			),
		).toEqual(["expand:widen-column:accounts:amount"]);
		expect(
			kinds(
				diffSchemaIr(
					parseSchemaIr(base("bigint")),
					parseSchemaIr(base("integer")),
				).steps,
			),
		).toEqual(["contract:narrow-column:accounts:amount"]);
		expect(
			kinds(
				diffSchemaIr(
					parseSchemaIr(base("varchar(32)")),
					parseSchemaIr(base("varchar(64)")),
				).steps,
			),
		).toEqual(["expand:widen-column:accounts:amount"]);
	});

	it("backfills before narrowing a column to NOT NULL", () => {
		const nullableEmail = (nullable: boolean): SchemaIr =>
			ir([
				table({
					columns: [
						column({
							name: "email",
							type: "text",
							nullable,
							primaryKey: false,
							unique: false,
						}),
					],
				}),
			]);
		expect(
			kinds(
				diffSchemaIr(
					parseSchemaIr(nullableEmail(true)),
					parseSchemaIr(nullableEmail(false)),
				).steps,
			),
		).toEqual([
			"backfill:backfill-column:accounts:email",
			"contract:narrow-column:accounts:email",
		]);
	});

	it("replaces a redefined index with a contract drop plus an expand add", () => {
		const before = parseSchemaIr(
			ir([
				table({
					columns: [
						column({
							name: "email",
							type: "text",
							nullable: true,
							primaryKey: false,
							unique: false,
						}),
					],
					indexes: [index()],
				}),
			]),
		);
		const after = parseSchemaIr(
			ir([
				table({
					columns: [
						column({
							name: "email",
							type: "text",
							nullable: true,
							primaryKey: false,
							unique: false,
						}),
					],
					indexes: [index({ unique: true })],
				}),
			]),
		);
		expect(kinds(diffSchemaIr(before, after).steps)).toEqual([
			"expand:add-index:accounts:accounts_email_idx",
			"contract:drop-index:accounts:accounts_email_idx",
		]);
	});

	it("never emits an inverse step and confines destructive work to contract", () => {
		const before = parseSchemaIr(
			ir([
				table({
					columns: [
						column(),
						column({
							name: "legacy",
							type: "bigint",
							nullable: true,
							primaryKey: false,
							unique: false,
						}),
					],
					indexes: [
						index({ name: "accounts_legacy_idx", columns: ["legacy"] }),
					],
				}),
				table({ name: "sessions" }),
			]),
		);
		const after = parseSchemaIr(
			ir([
				table({
					columns: [
						column(),
						column({
							name: "email",
							type: "text",
							nullable: false,
							primaryKey: false,
							unique: false,
						}),
					],
				}),
				table({ name: "audits" }),
			]),
		);
		const plan = diffSchemaIr(before, after);
		for (const step of plan.steps) {
			expect(MIGRATION_STEP_KINDS).toContain(step.kind);
			expect(step.destructive).toBe(step.phase === "contract");
		}
		expect(
			plan.steps
				.filter((step) => step.phase === "expand")
				.every((step) => !step.kind.startsWith("drop-")),
		).toBe(true);
	});

	it("orders steps identically under input permutation", () => {
		const tables: readonly SchemaTable[] = [
			table({
				name: "zeta",
				columns: [
					column(),
					column({
						name: "email",
						type: "text",
						nullable: true,
						primaryKey: false,
						unique: false,
					}),
				],
				indexes: [index({ name: "zeta_email_idx" })],
			}),
			table({
				name: "alpha",
				columns: [
					column(),
					column({
						name: "note",
						type: "text",
						nullable: true,
						primaryKey: false,
						unique: false,
					}),
				],
				indexes: [index({ name: "alpha_note_idx", columns: ["note"] })],
			}),
		];
		const empty = parseSchemaIr(ir([]));
		const forward = diffSchemaIr(empty, parseSchemaIr(ir(tables)));
		const reversed = diffSchemaIr(
			empty,
			parseSchemaIr(ir([...tables].reverse())),
		);
		expect(kinds(reversed.steps)).toEqual(kinds(forward.steps));
		expect(reversed.digest).toBe(forward.digest);
		expect(kinds(forward.steps)).toEqual([
			"expand:create-table:alpha:",
			"expand:add-index:alpha:alpha_note_idx",
			"expand:create-table:zeta:",
			"expand:add-index:zeta:zeta_email_idx",
		]);
	});

	it("changes the digest when the engine version changes with identical steps", () => {
		const before = parseSchemaIr(ir([table()]));
		const after = parseSchemaIr(ir([table(), table({ name: "sessions" })]));
		const first = diffSchemaIr(before, after, {
			id: "drizzle-kit",
			version: "0.31.0",
		});
		const second = diffSchemaIr(before, after, {
			id: "drizzle-kit",
			version: "0.32.0",
		});
		expect(kinds(second.steps)).toEqual(kinds(first.steps));
		expect(second.digest).not.toBe(first.digest);
		const sameEngine = diffSchemaIr(before, after, {
			id: "drizzle-kit",
			version: "0.31.0",
		});
		expect(sameEngine.digest).toBe(first.digest);
	});

	it("changes the digest when the engine id changes", () => {
		const before = parseSchemaIr(ir([table()]));
		const after = parseSchemaIr(ir([table(), table({ name: "sessions" })]));
		expect(
			diffSchemaIr(before, after, { id: "atlas", version: "1" }).digest,
		).not.toBe(
			diffSchemaIr(before, after, { id: "drizzle-kit", version: "1" }).digest,
		);
	});

	it("exposes the canonical differ as a SchemaDiffEngine with no SQL emission", () => {
		const before = parseSchemaIr(ir([table()]));
		const after = parseSchemaIr(ir([table(), table({ name: "sessions" })]));
		expect(CANONICAL_SCHEMA_DIFF_ENGINE.emitSql).toBeUndefined();
		expect(CANONICAL_SCHEMA_DIFF_ENGINE.diff(before, after).digest).toBe(
			diffSchemaIr(before, after).digest,
		);
	});
});

describe("classifyTypeChange", () => {
	it.each([
		["integer", "integer", "same"],
		["int4", "integer", "same"],
		["INTEGER", " integer ", "same"],
		["smallint", "bigint", "widen"],
		["bigint", "numeric", "widen"],
		["real", "double precision", "widen"],
		["varchar(10)", "text", "widen"],
		["varchar(10)", "varchar", "widen"],
		["numeric(10,2)", "numeric(12,2)", "widen"],
		["text", "varchar(10)", "narrow"],
		["numeric(10,2)", "numeric(10,1)", "narrow"],
		["double precision", "real", "narrow"],
		["text", "jsonb", "narrow"],
		["integer", "double precision", "narrow"],
	])("classifies %s → %s as %s", (from, to, expected) => {
		expect(classifyTypeChange(from, to)).toBe(expected);
	});
});
