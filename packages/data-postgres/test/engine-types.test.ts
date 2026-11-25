// The type-mapping annex and the two conversions behind it. Always on: the
// native text forms below are what a PostgreSQL server produces (the live
// lane proves that against a real one), so the conversion itself needs none.
import assert from "node:assert/strict";
import {
	CANONICAL_TYPES,
	type CanonicalType,
	canonicalEncode,
	composeTypeMapping,
	DataCoreError,
	type JsonValue,
	parseCanonicalRecord,
	parseDatasetSchema,
	parseTypeMappingAnnex,
	REFERENCE_TYPE_MAPPING,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import { parameterExpression, selectExpression } from "../src/engine/types.js";
import {
	canonicalFromNative,
	encodeParameter,
	type NativeTextSource,
	nativeTextToCanonical,
	POSTGRES_NATIVE_TYPES,
	POSTGRES_TYPE_MAPPING,
	type PostgresRow,
} from "../src/index.js";
import { EVERY_TYPE_RECORD, EVERY_TYPE_SCHEMA } from "./engine-support.js";

/** Answer a column from a row the way the binding's accessors do. */
function cellsOf(
	row: PostgresRow,
): (column: string) => string | null | undefined {
	return (column) => row[column];
}

function refused(action: () => void, label: string): void {
	assert.throws(
		action,
		(cause) =>
			cause instanceof DataCoreError && cause.code === "INVALID_RECORD",
		label,
	);
}

describe("type-mapping annex", () => {
	const annex = parseTypeMappingAnnex(POSTGRES_TYPE_MAPPING);

	test("every canonical type is mapped once, to the declared native type", () => {
		assert.equal(annex.engine, "postgres");
		assert.deepEqual(
			annex.edges.map((edge) => edge.canonical).sort(),
			[...CANONICAL_TYPES].sort(),
		);
		for (const edge of annex.edges) {
			assert.equal(edge.native, POSTGRES_NATIVE_TYPES[edge.canonical]);
		}
		assert.deepEqual(POSTGRES_NATIVE_TYPES, {
			bool: "boolean",
			int64: "bigint",
			float64: "double precision",
			decimal: "numeric",
			string: "text",
			bytes: "bytea",
			timestamp: "timestamptz",
			date: "date",
			uuid: "uuid",
			json: "jsonb",
			encrypted: "jsonb",
		});
	});

	test("no edge is lossy, and every limit is stated in words", () => {
		for (const edge of annex.edges) {
			assert.notEqual(edge.write, "lossy", edge.canonical);
			assert.notEqual(edge.read, "lossy", edge.canonical);
			if (edge.write !== "exact" || edge.read !== "exact") {
				assert.ok(edge.note.length > 20, edge.canonical);
			}
		}
		const byType = new Map(annex.edges.map((edge) => [edge.canonical, edge]));
		// The constraint the contract asks to be honest about.
		assert.equal(byType.get("string")?.write, "constrained");
		assert.match(byType.get("string")?.note ?? "", /U\+0000/u);
		assert.equal(byType.get("int64")?.write, "exact");
		assert.equal(byType.get("int64")?.read, "exact");
	});

	test("a plan into this engine surfaces its constraints as findings, none blocking", () => {
		const findings = composeTypeMapping(
			EVERY_TYPE_SCHEMA,
			REFERENCE_TYPE_MAPPING,
			annex,
		);
		assert.ok(findings.length > 0);
		assert.ok(
			findings.every((finding) => finding.code === "MAPPING_CONSTRAINED"),
		);
		assert.ok(findings.some((finding) => finding.field === "note"));
	});
});

describe("canonical → native", () => {
	test("each type is sent as text and cast by the statement", () => {
		const cases: readonly (readonly [CanonicalType, string])[] = [
			["bool", "$3::boolean"],
			["int64", "$3::bigint"],
			["float64", "$3::double precision"],
			["decimal", "$3::numeric"],
			["string", "$3::text"],
			["bytes", "decode($3::text, 'hex')"],
			["timestamp", "$3::timestamptz"],
			["date", "$3::date"],
			["uuid", "$3::uuid"],
			["json", "$3::jsonb"],
			["encrypted", "$3::jsonb"],
		];
		for (const [type, expression] of cases) {
			assert.equal(parameterExpression(type, 3), expression);
		}
	});

	test("values are encoded exactly", () => {
		assert.equal(encodeParameter("bool", true, "f"), "true");
		assert.equal(encodeParameter("bool", false, "f"), "false");
		assert.equal(
			encodeParameter("int64", "-9223372036854775808", "f"),
			"-9223372036854775808",
		);
		// The shortest text that parses back to the same double.
		assert.equal(
			encodeParameter("float64", 1.7976931348623157e308, "f"),
			"1.7976931348623157e+308",
		);
		assert.equal(encodeParameter("float64", 0.1, "f"), "0.1");
		assert.equal(encodeParameter("float64", 5e-324, "f"), "5e-324");
		assert.equal(encodeParameter("bytes", "AAECA/8=", "f"), "00010203ff");
		assert.equal(encodeParameter("bytes", "", "f"), "");
		assert.equal(
			encodeParameter("json", { b: [1, null], a: "x" }, "f"),
			'{"b":[1,null],"a":"x"}',
		);
		assert.equal(encodeParameter("json", "text", "f"), '"text"');
		assert.equal(encodeParameter("string", "", "f"), "");
		for (const type of CANONICAL_TYPES) {
			assert.equal(encodeParameter(type, null, "f"), null);
		}
	});

	test("text the server would alter or reject is refused before it is sent", () => {
		refused(() => encodeParameter("string", "a\u0000b", "note"), "NUL");
		// UTF-8 encoding would silently turn each of these into U+FFFD.
		refused(
			() => encodeParameter("string", "\ud800", "note"),
			"high surrogate",
		);
		refused(
			() => encodeParameter("string", "x\udc00y", "note"),
			"low surrogate",
		);
		refused(
			() => encodeParameter("string", "\udc00\ud800", "note"),
			"reversed pair",
		);
		// A well-formed pair is one code point and passes.
		assert.equal(encodeParameter("string", "😀", "note"), "😀");
	});
});

describe("native → canonical", () => {
	test("the select expressions do not depend on session settings", () => {
		assert.equal(
			selectExpression("float64", "w"),
			"encode(float8send(\"w\"), 'hex')",
		);
		assert.equal(selectExpression("bytes", "b"), "encode(\"b\", 'hex')");
		assert.equal(
			selectExpression("timestamp", "t"),
			"to_json(\"t\" AT TIME ZONE 'UTC') #>> '{}'",
		);
		assert.equal(selectExpression("date", "d"), "to_json(\"d\") #>> '{}'");
		assert.equal(selectExpression("string", "s"), '"s"');
		for (const type of [
			"bool",
			"int64",
			"decimal",
			"uuid",
			"json",
			"encrypted",
		] as const) {
			assert.equal(selectExpression(type, "c"), '"c"::text');
		}
	});

	test("both native dialects convert to the same canonical value", () => {
		const cases: readonly (readonly [
			CanonicalType,
			string,
			string,
			JsonValue,
		])[] = [
			["bool", "true", "t", true],
			["bool", "false", "f", false],
			[
				"int64",
				"-9223372036854775808",
				"-9223372036854775808",
				"-9223372036854775808",
			],
			[
				"float64",
				"7fefffffffffffff",
				"1.7976931348623157e+308",
				1.7976931348623157e308,
			],
			["float64", "3fb999999999999a", "0.1", 0.1],
			["float64", "0000000000000001", "5e-324", 5e-324],
			["float64", "c000000000000000", "-2", -2],
			["decimal", "1234.5600", "1234.5600", "1234.5600"],
			["string", "plain", "plain", "plain"],
			["bytes", "00010203ff", "\\x00010203ff", "AAECA/8="],
			["bytes", "", "\\x", ""],
			[
				"timestamp",
				"2026-01-02T03:04:05.678901",
				"2026-01-02 03:04:05.678901+00",
				"2026-01-02T03:04:05.678901Z",
			],
			[
				"timestamp",
				"2026-01-02T03:04:05",
				"2026-01-02 03:04:05+00",
				"2026-01-02T03:04:05.000000Z",
			],
			[
				"timestamp",
				"2026-01-02T03:04:05.5",
				"2026-01-02 03:04:05.5+00",
				"2026-01-02T03:04:05.500000Z",
			],
			["date", "2026-02-28", "2026-02-28", "2026-02-28"],
			[
				"uuid",
				"0f8fad5b-d9cb-469f-a165-70867728950e",
				"0f8fad5b-d9cb-469f-a165-70867728950e",
				"0f8fad5b-d9cb-469f-a165-70867728950e",
			],
			[
				"json",
				'{"a": [1, null], "n": 1000000000000000000000}',
				'{"a": [1, null], "n": 1000000000000000000000}',
				{ a: [1, null], n: 1e21 },
			],
		];
		for (const [type, selected, decoded, expected] of cases) {
			assert.deepEqual(
				nativeTextToCanonical(type, selected, "select", "f"),
				expected,
				`${type} select`,
			);
			assert.deepEqual(
				nativeTextToCanonical(type, decoded, "decoded", "f"),
				expected,
				`${type} decoded`,
			);
		}
	});

	test("a native value with no canonical form is refused, never altered", () => {
		const cases: readonly (readonly [
			CanonicalType,
			string,
			NativeTextSource,
		])[] = [
			["bool", "yes", "select"],
			["float64", "NaN", "decoded"],
			["float64", "Infinity", "decoded"],
			["float64", "-Infinity", "decoded"],
			["float64", "0x10", "decoded"],
			["float64", "7ff8", "select"],
			["bytes", "\\xzz", "decoded"],
			["bytes", "abc", "select"],
			["timestamp", "infinity", "select"],
			["timestamp", "-infinity", "decoded"],
			["timestamp", "0044-03-15T12:00:00 BC", "select"],
			["timestamp", "0044-03-15 12:00:00+00 BC", "decoded"],
			["timestamp", "10000-01-01T00:00:00", "select"],
			// Not UTC: the capture session pins UTC, so anything else is wrong.
			["timestamp", "2026-01-02 05:04:05+02", "decoded"],
			["json", "{not json", "select"],
		];
		for (const [type, text, source] of cases) {
			refused(
				() => nativeTextToCanonical(type, text, source, "f"),
				`${type} ${text}`,
			);
		}
		// NaN and the infinities do arrive as eight bytes; the canonical
		// normaliser is what refuses them.
		const schema = parseDatasetSchema({
			name: "t",
			keyFields: ["id"],
			fields: [
				{ name: "id", type: "string", nullable: false },
				{ name: "w", type: "float64", nullable: true },
				{ name: "p", type: "decimal", nullable: true },
				{ name: "d", type: "date", nullable: true },
			],
		});
		const row = (cells: PostgresRow) => () =>
			canonicalFromNative(schema, cellsOf({ id: "a", ...cells }), "select");
		refused(row({ w: "7ff8000000000000" }), "NaN bytes");
		refused(row({ w: "7ff0000000000000" }), "+Infinity bytes");
		refused(row({ p: "NaN" }), "numeric NaN");
		refused(row({ p: "Infinity" }), "numeric Infinity");
		refused(row({ d: "0044-03-15 BC" }), "BC date");
		refused(row({ d: "infinity" }), "infinite date");
		refused(row({ d: "12345-01-01" }), "five-digit year");
	});

	test("a whole row reads back byte-identical to the canonical record", () => {
		const expected = parseCanonicalRecord(EVERY_TYPE_SCHEMA, EVERY_TYPE_RECORD);
		// What the select expressions return for that record on a real server.
		const selected: PostgresRow = {
			tenant_id: "",
			id: "order-1",
			qty: "9007199254740993",
			price: "1234.5600",
			weight: "3fb999999999999a",
			active: "true",
			note: 'quote \' "double" and ünïcödé — 雪',
			blob: "00010203ff",
			placed_at: "2026-01-02T03:04:05.678901",
			due: "2026-02-28",
			ref: "0f8fad5b-d9cb-469f-a165-70867728950e",
			attrs:
				'{"a": "b", "n": 1000000000000000000000, "z": [1, 2, {"nested": null}]}',
			card: '{"alg": "AES-256-GCM", "keyRef": "key://subject/1", "ciphertext": "3q2+7w=="}',
		};
		assert.equal(
			canonicalEncode(
				canonicalFromNative(
					EVERY_TYPE_SCHEMA,
					(column) => selected[column],
					"select",
				),
			),
			canonicalEncode(expected),
		);
		// And the same record as logical decoding spells it.
		const decoded: PostgresRow = {
			...selected,
			weight: "0.1",
			active: "t",
			blob: "\\x00010203ff",
			placed_at: "2026-01-02 03:04:05.678901+00",
		};
		assert.equal(
			canonicalEncode(
				canonicalFromNative(
					EVERY_TYPE_SCHEMA,
					(column) => decoded[column],
					"decoded",
				),
			),
			canonicalEncode(expected),
		);
	});

	test("NULL and absent cells become null, and an open schema merges its overflow", () => {
		const open = parseDatasetSchema({
			name: "events",
			open: true,
			keyFields: ["id"],
			fields: [
				{ name: "id", type: "string", nullable: false },
				{ name: "body", type: "json", nullable: true },
			],
		});
		const cells: PostgresRow = {
			id: "a",
			body: null,
			hobo_extra: '{"extra": [1, "two"], "id": "shadowed"}',
		};
		assert.deepEqual(
			canonicalFromNative(open, (column) => cells[column], "select"),
			{
				// A declared column always wins over an overflow key of the same name.
				id: "a",
				body: null,
				extra: [1, "two"],
			},
		);
		assert.deepEqual(
			canonicalFromNative(open, cellsOf({ id: "b" }), "decoded"),
			{ id: "b", body: null },
		);
		refused(
			() => canonicalFromNative(open, () => undefined, "select"),
			"a missing key column",
		);
	});
});
