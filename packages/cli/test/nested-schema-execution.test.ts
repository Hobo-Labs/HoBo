import { resetTrainables } from "@hobo/runtime";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
	exampleSchemaValue,
	parseFieldSchema,
	renderSchemaType,
	schemaRuntimeSource,
	serializedSchema,
} from "../src/codegen/schema.js";
import type { JsonValue } from "../src/json.js";

// Generated code imported in-process registers trainables in the shared
// registry; with files sharing a worker (isolate: false), clear it after each test.
afterEach(() => {
	resetTrainables();
});

type Validator = {
	parseValue(
		schema: JsonValue,
		value: JsonValue,
		path?: string,
		definitions?: Record<string, JsonValue>,
	): JsonValue;
};
async function emittedValidator(): Promise<Validator> {
	const result = ts.transpileModule(schemaRuntimeSource(), {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
		},
		reportDiagnostics: true,
	});
	expect(result.diagnostics).toEqual([]);
	// SAFETY: the imported module is the compiler output of our executable validator source.
	return (await import(
		`data:text/javascript;base64,${Buffer.from(result.outputText).toString("base64")}`
	)) as Validator;
}

describe("nested schema executable contract", () => {
	const definition = {
		type: "object",
		fields: {
			customer: {
				type: "object",
				properties: {
					name: { type: "string" },
					email: { type: "string", format: "email" },
				},
				required: ["name"],
			},
			items: {
				type: "array",
				items: {
					type: "object",
					fields: {
						sku: { type: "string" },
						quantity: { type: "integer" },
						status: { type: "enum", values: ["new", "paid"] },
					},
				},
			},
			labels: {
				type: "record",
				values: { type: "array", items: { type: "string" } },
			},
			coordinates: {
				type: "tuple",
				items: [{ type: "number" }, { type: "number" }],
			},
			discount: { anyOf: [{ type: "null" }, { type: "number" }] },
			comment: { type: "string", optional: true },
		},
	};
	const value = {
		customer: { name: "Ada" },
		items: [{ sku: "book", quantity: 2, status: "paid" }],
		labels: { category: ["reading"] },
		coordinates: [1, 2],
		discount: null,
	};
	it("renders nested types and executes validation against real values", async () => {
		const schema = parseFieldSchema(definition);
		expect(renderSchemaType(schema)).toContain('"customer":');
		expect(renderSchemaType(schema)).toContain('"email"?: string');
		const runtime = await emittedValidator();
		expect(runtime.parseValue(serializedSchema(schema), value)).toBe(value);
		expect(() =>
			runtime.parseValue(serializedSchema(schema), {
				...value,
				items: [{ sku: "book", quantity: 1.5, status: "paid" }],
			}),
		).toThrow("quantity");
		expect(() =>
			runtime.parseValue(serializedSchema(schema), { ...value, customer: {} }),
		).toThrow("name");
		expect(() =>
			runtime.parseValue(serializedSchema(schema), {
				...value,
				labels: { category: [3] },
			}),
		).toThrow("labels.category[0]");
		expect(() =>
			runtime.parseValue(serializedSchema(schema), {
				...value,
				coordinates: [1],
			}),
		).toThrow("tuple length");
		expect(() =>
			runtime.parseValue(serializedSchema(schema), {
				...value,
				customer: { name: "Ada", email: "bad" },
			}),
		).toThrow("email");
		expect(
			runtime.parseValue(serializedSchema(schema), exampleSchemaValue(schema)),
		).toBeDefined();
	});
	it("preserves recursive schemas and validates finite recursive data", async () => {
		const schema = parseFieldSchema({
			type: "object",
			fields: {
				name: { type: "string" },
				children: { type: "array", items: { $ref: "#/resources/node" } },
			},
		});
		const definitions = { node: serializedSchema(schema) };
		const runtime = await emittedValidator();
		expect(
			runtime.parseValue(
				definitions.node,
				{ name: "root", children: [{ name: "child", children: [] }] },
				"node",
				definitions,
			),
		).toBeDefined();
		expect(() =>
			runtime.parseValue(
				definitions.node,
				{ name: "root", children: [{ name: 3, children: [] }] },
				"node",
				definitions,
			),
		).toThrow("children[0].name");
	});
	it("rejects unsupported schema input instead of weakening it to unknown", () => {
		expect(() => parseFieldSchema({ type: "typo" })).toThrow(
			"unsupported schema kind",
		);
	});
	it("rejects sparse arrays and tuples before JSON serialization can turn holes into null", async () => {
		const runtime = await emittedValidator();
		for (const definition of [
			{ type: "array", items: { type: "number" } },
			{ type: "array", items: { type: "any" } },
			{ type: "tuple", items: [{ type: "number", optional: true }] },
		]) {
			const schema = serializedSchema(parseFieldSchema(definition));
			const sparse: number[] = [];
			sparse.length = 1;
			expect(() => runtime.parseValue(schema, sparse)).toThrow("sparse arrays");
		}
	});
	it("enforces exclusive variants, literal objects and closed nested shapes", async () => {
		const runtime = await emittedValidator();
		const exclusive = parseFieldSchema({
			oneOf: [{ type: "number" }, { type: "integer" }],
		});
		expect(() => runtime.parseValue(serializedSchema(exclusive), 1)).toThrow();
		expect(runtime.parseValue(serializedSchema(exclusive), 0.5)).toBe(0.5);
		expect(
			runtime.parseValue(
				serializedSchema(exclusive),
				exampleSchemaValue(exclusive),
			),
		).toBe(0.5);
		const enumVariant = parseFieldSchema({
			oneOf: [{ enum: ["shared", "unique"] }, { const: "shared" }],
		});
		expect(exampleSchemaValue(enumVariant)).toBe("unique");
		const intersection = parseFieldSchema({
			allOf: [
				{
					type: "object",
					fields: { nested: { type: "object", fields: { left: "string" } } },
				},
				{
					type: "object",
					fields: { nested: { type: "object", fields: { right: "integer" } } },
				},
			],
		});
		expect(
			runtime.parseValue(
				serializedSchema(intersection),
				exampleSchemaValue(intersection),
			),
		).toEqual({ nested: { left: "example", right: 0 } });
		const literal = parseFieldSchema({ const: { kind: "paid", amount: 2 } });
		expect(
			runtime.parseValue(serializedSchema(literal), {
				amount: 2,
				kind: "paid",
			}),
		).toEqual({ kind: "paid", amount: 2 });
		expect(() =>
			runtime.parseValue(serializedSchema(literal), {
				kind: "paid",
				amount: 3,
			}),
		).toThrow();
		const closed = parseFieldSchema({
			type: "object",
			fields: { name: { type: "string" } },
			additionalProperties: false,
		});
		expect(() =>
			runtime.parseValue(serializedSchema(closed), {
				name: "Ada",
				extra: true,
			}),
		).toThrow("unexpected field");
		const extra = parseFieldSchema({
			type: "object",
			fields: { name: { type: "string" } },
			additionalProperties: { type: "integer" },
		});
		expect(() =>
			runtime.parseValue(serializedSchema(extra), {
				name: "Ada",
				extra: "wrong",
			}),
		).toThrow("extra");
	});
});
