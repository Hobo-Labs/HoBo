import { describe, expect, it } from "vitest";
import {
	DrizzleAdapterError,
	type DrizzleImpedanceCode,
	ingestDrizzleSchema,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";
import type { ExtraConfigBuilder } from "../src/shape.js";
import {
	column,
	indexBuilder,
	indexedColumn,
	partialIndexBuilder,
	representativeSchemaModule,
	sqlExpression,
	table,
	typelessColumn,
	view,
} from "./fixtures.js";
import * as schemaModule from "./schema-module.fixture.js";

function codes(module: JsonObject): readonly DrizzleImpedanceCode[] {
	return ingestDrizzleSchema(module).impedance.map((finding) => finding.code);
}

function thrownCode(run: () => void): string {
	try {
		run();
	} catch (error) {
		return error instanceof DrizzleAdapterError
			? error.code
			: `unexpected:${String(error)}`;
	}
	return "no-throw";
}

describe("ingestDrizzleSchema", () => {
	it("reads a representative schema module into the canonical IR", () => {
		const { schema } = ingestDrizzleSchema(representativeSchemaModule());

		expect(schema.dialect).toBe("postgres");
		expect(schema.tables.map((entry) => entry.name)).toEqual([
			"posts",
			"users",
		]);

		const users = schema.tables.find((entry) => entry.name === "users");
		expect(users?.columns).toEqual([
			{
				name: "active",
				type: "boolean",
				nullable: false,
				primaryKey: false,
				unique: false,
				defaultExpression: "true",
			},
			{
				name: "display_name",
				type: "text",
				nullable: true,
				primaryKey: false,
				unique: false,
			},
			{
				name: "email",
				type: "varchar(320)",
				nullable: false,
				primaryKey: false,
				unique: true,
			},
			{
				name: "id",
				type: "serial",
				nullable: false,
				primaryKey: true,
				unique: false,
			},
		]);
	});

	it("reads indexes out of the extra-config callback, sorted and flagged", () => {
		const { schema } = ingestDrizzleSchema(representativeSchemaModule());
		const users = schema.tables.find((entry) => entry.name === "users");

		expect(users?.indexes).toEqual([
			{ name: "users_active_idx", columns: ["active"], unique: false },
			{ name: "users_email_idx", columns: ["email"], unique: true },
		]);
	});

	it("is deterministic: the same module ingested twice is deep-equal, ordering included", () => {
		const module = representativeSchemaModule();
		const first = ingestDrizzleSchema(module);
		const second = ingestDrizzleSchema(module);

		expect(second).toEqual(first);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it("is independent of export declaration order", () => {
		const forward = representativeSchemaModule();
		// SAFETY: assertion to `Object.fromEntries( Object.entries(forward).reverse(), ) as JsonObject` is required at this boundary.
		const reversed = Object.fromEntries(
			Object.entries(forward).reverse(),
		) as JsonObject;

		expect(JSON.stringify(ingestDrizzleSchema(reversed))).toBe(
			JSON.stringify(ingestDrizzleSchema(forward)),
		);
	});

	it("freezes the result so a consumer cannot mutate the ingested IR", () => {
		const result = ingestDrizzleSchema(representativeSchemaModule());

		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.impedance)).toBe(true);
	});

	it("records an unrecognized export as impedance instead of throwing or dropping it", () => {
		const module = {
			users: table("users", { id: column("id", { primary: true }) }),
			userRole: () => "an enum helper",
			appVersion: 3,
		};

		const result = ingestDrizzleSchema(module);

		expect(result.schema.tables.map((entry) => entry.name)).toEqual(["users"]);
		expect(result.impedance).toEqual([
			{
				code: "DRIZZLE_EXPORT_UNRECOGNIZED",
				detail: expect.stringContaining('Export "appVersion"'),
			},
			{
				code: "DRIZZLE_EXPORT_UNRECOGNIZED",
				detail: expect.stringContaining('Export "userRole"'),
			},
		]);
	});

	const impedanceCases: [string, JsonObject, DrizzleImpedanceCode][] = [
		[
			"a view export",
			{
				activeUsers: view("active_users"),
				t: table("t", { id: column("id") }),
			},
			"DRIZZLE_VIEW_UNREAD",
		],
		[
			"a schema-qualified table",
			{ t: table("t", { id: column("id") }, { schema: "analytics" }) },
			"DRIZZLE_TABLE_SCHEMA_UNREPRESENTABLE",
		],
		[
			"inline foreign keys",
			{
				t: table(
					"t",
					{ id: column("id") },
					{ inlineForeignKeys: [{ ref: "other.id" }] },
				),
			},
			"DRIZZLE_FOREIGN_KEY_UNREAD",
		],
		[
			"a non-column property in the column map",
			{ t: table("t", { id: column("id"), broken: { notAColumn: true } }) },
			"DRIZZLE_COLUMN_UNRECOGNIZED",
		],
		[
			"a column with no readable SQL type",
			{
				t: table("t", {
					id: column("id"),
					mystery: typelessColumn("mystery"),
				}),
			},
			"DRIZZLE_COLUMN_TYPE_UNREADABLE",
		],
		[
			"a non-postgres column",
			{
				t: table("t", {
					id: column("id"),
					legacy: column("legacy", { columnType: "MySqlVarChar" }),
				}),
			},
			"DRIZZLE_NON_POSTGRES_TABLE",
		],
		[
			"a table with nothing readable in it",
			{
				t: table("t", { nothing: { notAColumn: true } }),
				u: table("u", { id: column("id") }),
			},
			"DRIZZLE_TABLE_COLUMNS_EMPTY",
		],
	];

	it.each(
		impedanceCases,
	)("surfaces %s as an impedance finding rather than a silent drop", (_why, module, code) => {
		expect(codes(module)).toContain(code);
	});

	it("keeps the first export by name when two exports declare the same table", () => {
		const module = {
			accounts: table("users", { id: column("id", { sqlType: "serial" }) }),
			zzUsers: table("users", { id: column("id", { sqlType: "bigserial" }) }),
		};

		const result = ingestDrizzleSchema(module);

		expect(result.schema.tables).toHaveLength(1);
		expect(result.schema.tables[0]?.columns[0]?.type).toBe("serial");
		expect(result.impedance).toEqual([
			{
				code: "DRIZZLE_TABLE_NAME_DUPLICATE",
				detail: expect.stringContaining('"accounts" and "zzUsers"'),
			},
		]);
	});

	it("carries literal defaults and refuses to guess non-literal ones", () => {
		const module = {
			t: table("t", {
				label: column("label", { default: "o'brien" }),
				count: column("count", { sqlType: "integer", default: 0 }),
				flag: column("flag", { sqlType: "boolean", default: false }),
				createdAt: column("created_at", {
					sqlType: "timestamp",
					hasDefault: true,
					default: { sql: "now()" },
				}),
				token: column("token", {
					hasDefault: true,
					defaultFn: () => "generated",
				}),
			}),
		};

		const result = ingestDrizzleSchema(module);
		const byName = new Map(
			(result.schema.tables[0]?.columns ?? []).map((entry) => [
				entry.name,
				entry,
			]),
		);

		expect(byName.get("label")?.defaultExpression).toBe("'o''brien'");
		expect(byName.get("count")?.defaultExpression).toBe("0");
		expect(byName.get("flag")?.defaultExpression).toBe("false");
		expect(byName.get("created_at")?.defaultExpression).toBeUndefined();
		expect(byName.get("token")?.defaultExpression).toBeUndefined();
		expect(
			result.impedance.filter(
				(finding) => finding.code === "DRIZZLE_DEFAULT_UNREPRESENTABLE",
			),
		).toHaveLength(2);
	});

	it("falls back to the column class when getSQLType throws", () => {
		const module = {
			t: table("t", {
				id: column("id", {
					columnType: "PgUUID",
					sqlType: () => {
						throw new Error("renderer unavailable");
					},
				}),
			}),
		};

		const result = ingestDrizzleSchema(module);

		expect(result.schema.tables[0]?.columns[0]?.type).toBe("uuid");
	});

	const extraConfigCases: [string, ExtraConfigBuilder][] = [
		[
			"a throwing extra-config callback",
			(): JsonValue => {
				throw new Error("needs a real table proxy");
			},
		],
		["a scalar return", () => "not builders"],
		["unreadable entries", () => [{ config: { name: "i" } }]],
	];

	it.each(
		extraConfigCases,
	)("records %s as extra-config impedance", (_why, builder) => {
		const module = {
			t: table("t", { id: column("id") }, { extraConfigBuilder: builder }),
		};

		const result = ingestDrizzleSchema(module);

		expect(result.schema.tables[0]?.indexes).toEqual([]);
		expect(codes(module)).toContain("DRIZZLE_EXTRA_CONFIG_UNREAD");
		expect(result.impedance[0]?.detail.length).toBeGreaterThan(0);
	});

	it("reads a record-shaped extra-config return as well as an array", () => {
		const module = {
			t: table(
				"t",
				{ id: column("id") },
				{
					extraConfigBuilder: () => ({
						byId: indexBuilder("t_id_idx", ["id"], true),
					}),
				},
			),
		};

		expect(ingestDrizzleSchema(module).schema.tables[0]?.indexes).toEqual([
			{ name: "t_id_idx", columns: ["id"], unique: true },
		]);
	});

	it("ingests a partial index on its columns and names the dropped predicate", () => {
		const module = {
			t: table(
				"t",
				{ id: column("id"), deleted_at: column("deleted_at") },
				{
					extraConfigBuilder: () => [partialIndexBuilder("t_live", ["id"])],
				},
			),
		};

		const result = ingestDrizzleSchema(module);

		expect(result.schema.tables[0]?.indexes).toEqual([
			{ name: "t_live", columns: ["id"], unique: false },
		]);
		expect(result.impedance).toEqual([
			{
				code: "DRIZZLE_INDEX_PREDICATE_UNREPRESENTABLE",
				detail: expect.stringContaining('"t_live"'),
			},
		]);
	});

	it("ingests an index without its non-default key order and says so", () => {
		const module = {
			t: table(
				"t",
				{ id: column("id"), seq: column("seq") },
				{
					extraConfigBuilder: () => [
						indexBuilder("t_plain", [indexedColumn("id")]),
						indexBuilder("t_recent", [
							indexedColumn("id"),
							indexedColumn("seq", { order: "desc", nulls: "first" }),
						]),
					],
				},
			),
		};

		const result = ingestDrizzleSchema(module);

		expect(result.schema.tables[0]?.indexes).toEqual([
			{ name: "t_plain", columns: ["id"], unique: false },
			{ name: "t_recent", columns: ["id", "seq"], unique: false },
		]);
		expect(result.impedance).toEqual([
			{
				code: "DRIZZLE_INDEX_KEY_ORDER_UNREPRESENTABLE",
				detail: expect.stringMatching(/"t_recent".*"seq"/u),
			},
		]);
	});

	it("refuses to ingest an expression index rather than record it on fewer keys", () => {
		const module = {
			t: table(
				"t",
				{ id: column("id"), body: column("body") },
				{
					extraConfigBuilder: () => [
						indexBuilder("t_by_kind", [
							"id",
							sqlExpression("(body ->> 'kind')"),
						]),
					],
				},
			),
		};

		const result = ingestDrizzleSchema(module);

		expect(result.schema.tables[0]?.indexes).toEqual([]);
		expect(result.impedance).toEqual([
			{
				code: "DRIZZLE_INDEX_EXPRESSION_UNREPRESENTABLE",
				detail: expect.stringContaining('"t_by_kind"'),
			},
		]);
	});

	it("accepts the module namespace object `import * as schema` yields", () => {
		expect(Object.prototype.toString.call(schemaModule)).toBe(
			"[object Module]",
		);

		const result = ingestDrizzleSchema(schemaModule);

		expect(result.schema.tables.map((entry) => entry.name)).toEqual([
			"accounts",
		]);
		expect(result.impedance.map((finding) => finding.code)).toEqual([
			"DRIZZLE_EXPORT_UNRECOGNIZED",
		]);
	});

	it("sorts impedance findings by code then detail", () => {
		const module = {
			bView: view("b_view"),
			aValue: 1,
			cView: view("c_view"),
			t: table("t", { id: column("id") }),
		};

		const ordered = ingestDrizzleSchema(module).impedance;

		expect(ordered.map((finding) => finding.code)).toEqual([
			"DRIZZLE_EXPORT_UNRECOGNIZED",
			"DRIZZLE_VIEW_UNREAD",
			"DRIZZLE_VIEW_UNREAD",
		]);
		expect(ordered[1]?.detail).toContain('"bView"');
		expect(ordered[2]?.detail).toContain('"cView"');
	});

	const refusalCases: [string, () => void, string][] = [
		[
			"null in place of a module",
			() => {
				// SAFETY: invalid ingest input is a null module at this refusal case.
				ingestDrizzleSchema(null as never);
			},
			"DRIZZLE_INGEST_INPUT_INVALID",
		],
		[
			"a string in place of a module",
			() => {
				// SAFETY: invalid ingest input is a string module at this refusal case.
				ingestDrizzleSchema("schema" as never);
			},
			"DRIZZLE_INGEST_INPUT_INVALID",
		],
		[
			"a non-postgres dialect",
			() => {
				// SAFETY: unsupported dialect is refused at this ingest boundary.
				ingestDrizzleSchema({}, { dialect: "mysql" as never });
			},
			"DRIZZLE_DIALECT_UNSUPPORTED",
		],
	];

	it.each(refusalCases)("refuses %s with a typed code", (_why, run, code) => {
		expect(thrownCode(run)).toBe(code);
	});

	it("carries remediation text on every refusal", () => {
		try {
			// SAFETY: assertion to `undefined as never` is required at this boundary.
			ingestDrizzleSchema(undefined as never);
			expect.unreachable("ingestDrizzleSchema should refuse a non-object");
		} catch (error) {
			expect(error).toBeInstanceOf(DrizzleAdapterError);
			// SAFETY: assertion to `error as DrizzleAdapterError` is required at this boundary.
			expect((error as DrizzleAdapterError).remediation.length).toBeGreaterThan(
				0,
			);
		}
	});
});
