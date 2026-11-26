// Canonical ↔ BSON, one type at a time. The rule under test is the annex's:
// a value is stored exactly, in the native type the annex names, or it is
// refused loudly. Storing it altered is the one outcome that never happens.
import assert from "node:assert/strict";
import {
	type CanonicalRecord,
	type CanonicalType,
	canonicalEncode,
	DataCoreError,
	type DatasetSchema,
	encodeRecordKey,
	type JsonObject,
	type JsonValue,
	normalizeCanonicalValue,
	parseCanonicalRecord,
	parseDatasetSchema,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import {
	datasetValidator,
	decodeDocument,
	decodeValue,
	documentId,
	encodeDocument,
	encodeValue,
	formatDecimal128,
	fromDecimal128Text,
	MongoDataError,
	type MongoValue,
	toDecimal128Text,
} from "../src/index.js";

const SCHEMA: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string" },
		{ name: "qty", type: "int64" },
		{ name: "price", type: "decimal" },
		{ name: "weight", type: "float64" },
		{ name: "active", type: "bool" },
		{ name: "note", type: "string", nullable: true },
		{ name: "blob", type: "bytes" },
		{ name: "placed_at", type: "timestamp" },
		{ name: "due", type: "date" },
		{ name: "ref", type: "uuid" },
		{ name: "attrs", type: "json" },
		{ name: "card", type: "encrypted", nullable: true },
	],
});

const RAW: JsonObject = {
	id: "order-1",
	qty: "9007199254740993",
	price: "001234.5600",
	weight: 0.1,
	active: true,
	note: 'quote \' "double" and ünïcödé — \u0000 NUL',
	blob: "AAECA/8=",
	placed_at: "2026-01-02T05:04:05.678901+02:00",
	due: "2026-02-28",
	ref: "0F8FAD5B-D9CB-469F-A165-70867728950E",
	attrs: { z: [1, 2.5, { nested: null }], a: "b" },
	card: {
		alg: "AES-256-GCM",
		keyRef: "key://subject/1",
		ciphertext: "3q2+7w==",
	},
};

function record(overrides: JsonObject = {}): CanonicalRecord {
	return parseCanonicalRecord(SCHEMA, { ...RAW, ...overrides });
}

/** Encode then decode one canonical value; the result is re-normalised. */
function roundTrip(type: CanonicalType, value: JsonValue): JsonValue {
	const canonical = normalizeCanonicalValue(type, value, "field");
	return normalizeCanonicalValue(
		type,
		decodeValue(type, encodeValue(type, canonical, "field"), "field"),
		"field",
	);
}

function assertRoundTrips(type: CanonicalType, value: JsonValue): void {
	assert.equal(
		canonicalEncode(roundTrip(type, value)),
		canonicalEncode(normalizeCanonicalValue(type, value, "field")),
	);
}

function refusal(action: () => void): MongoDataError {
	try {
		action();
	} catch (cause) {
		assert.ok(cause instanceof MongoDataError, String(cause));
		return cause;
	}
	return assert.fail("expected a refusal");
}

describe("document layout", () => {
	test("tenant and key sit in _id; each field is in its native BSON type", () => {
		const canonical = record();
		const key = encodeRecordKey(SCHEMA, canonical);
		assert.deepEqual(encodeDocument(SCHEMA, "tenant-a", key, canonical), {
			_id: { t: "tenant-a", k: '["order-1"]' },
			id: "order-1",
			qty: { $numberLong: "9007199254740993" },
			price: { $numberDecimal: "1234.56" },
			weight: { $numberDouble: "0.1" },
			active: true,
			note: 'quote \' "double" and ünïcödé — \u0000 NUL',
			blob: { $binary: { base64: "AAECA/8=", subType: "00" } },
			placed_at: "2026-01-02T03:04:05.678901Z",
			due: { $date: { $numberLong: "1772236800000" } },
			ref: { $binary: { base64: "D4+tW9nLRp+hZXCGdyiVDg==", subType: "04" } },
			attrs: {
				z: [
					{ $numberDouble: "1.0" },
					{ $numberDouble: "2.5" },
					{ nested: null },
				],
				a: "b",
			},
			card: {
				alg: "AES-256-GCM",
				keyRef: "key://subject/1",
				ciphertext: { $binary: { base64: "3q2+7w==", subType: "00" } },
			},
		});
	});

	test("a document decodes to the byte-identical canonical record", () => {
		const canonical = record({ note: null, card: null });
		const key = encodeRecordKey(SCHEMA, canonical);
		const decoded = decodeDocument(
			SCHEMA,
			encodeDocument(SCHEMA, "tenant-a", key, canonical),
		);
		assert.equal(decoded.tenant, "tenant-a");
		assert.equal(decoded.key, key);
		assert.equal(canonicalEncode(decoded.record), canonicalEncode(canonical));
	});

	test("a non-canonical record is normalised on the way in, not stored as given", () => {
		const document = encodeDocument(SCHEMA, "", '["order-1"]', RAW);
		assert.deepEqual(document.price, { $numberDecimal: "1234.56" });
		assert.equal(document.placed_at, "2026-01-02T03:04:05.678901Z");
	});

	test("an open schema keeps undeclared fields under _open", () => {
		const open = parseDatasetSchema({
			name: "events",
			keyFields: ["id"],
			open: true,
			fields: [{ name: "id", type: "string" }],
		});
		const canonical = parseCanonicalRecord(open, {
			id: "e1",
			"weird.name": [1, "two"],
			_id: "not the document id",
		});
		const document = encodeDocument(open, "", '["e1"]', canonical);
		assert.deepEqual(document, {
			_id: { t: "", k: '["e1"]' },
			id: "e1",
			_open: {
				"weird.name": [{ $numberDouble: "1.0" }, "two"],
				_id: "not the document id",
			},
		});
		assert.equal(
			canonicalEncode(decodeDocument(open, document).record),
			canonicalEncode(canonical),
		);
	});

	test("a field the schema does not declare is refused on read, not dropped", () => {
		const document = {
			...encodeDocument(SCHEMA, "", '["order-1"]', record()),
			added_natively: "x",
		};
		const error = refusal(() => decodeDocument(SCHEMA, document));
		assert.equal(error.code, "MONGODB_NON_CANONICAL_VALUE");
		assert.equal(error.detail.field, "added_natively");
	});

	test("the validator pins every field to its native BSON type", () => {
		const validator = datasetValidator(SCHEMA);
		const rule = validator.$jsonSchema;
		assert.ok(rule !== undefined && rule !== null);
		assert.deepEqual(JSON.parse(JSON.stringify(rule)).properties.qty, {
			bsonType: ["long"],
		});
		assert.deepEqual(JSON.parse(JSON.stringify(rule)).properties.note, {
			bsonType: ["string", "null"],
		});
		assert.deepEqual(JSON.parse(JSON.stringify(rule)).required, [
			"_id",
			...SCHEMA.fields.map((field) => field.name),
		]);
		assert.equal(JSON.parse(JSON.stringify(rule)).additionalProperties, false);
	});
});

describe("exact types", () => {
	test("int64 is a 64-bit integer across its whole range", () => {
		for (const value of [
			"9007199254740993",
			"-9223372036854775808",
			"9223372036854775807",
			"0",
		]) {
			assert.deepEqual(encodeValue("int64", value, "qty"), {
				$numberLong: value,
			});
			assertRoundTrips("int64", value);
		}
	});

	test("float64 keeps every finite double, including the extremes", () => {
		for (const value of [1.7976931348623157e308, 5e-324, 0.1, -0, 1e21, -1.5]) {
			assertRoundTrips("float64", value);
		}
		assert.deepEqual(encodeValue("float64", 1.7976931348623157e308, "w"), {
			$numberDouble: "1.7976931348623157e+308",
		});
	});

	test("a timestamp keeps its microseconds because it is stored as text", () => {
		assert.equal(
			encodeValue("timestamp", "2026-01-02T03:04:05.678901Z", "at"),
			"2026-01-02T03:04:05.678901Z",
		);
		assertRoundTrips("timestamp", "2026-01-02T03:04:05.678901Z");
		assertRoundTrips("timestamp", "9999-12-31T23:59:59.999999Z");
	});

	test("a date is a BSON date at UTC midnight", () => {
		for (const value of [
			"2026-02-28",
			"2024-02-29",
			"0100-01-01",
			"9999-12-31",
		]) {
			assertRoundTrips("date", value);
		}
		assert.deepEqual(encodeValue("date", "1970-01-02", "due"), {
			$date: { $numberLong: "86400000" },
		});
	});

	test("a date in years 0000–0099 is not shifted into the 1900s", () => {
		// The canonical parser currently refuses these years, so they cannot
		// reach the codec through a record; the codec itself is exact on them.
		const stored = encodeValue("date", "0001-01-01", "due");
		assert.deepEqual(stored, { $date: { $numberLong: "-62135596800000" } });
		assert.equal(decodeValue("date", stored, "due"), "0001-01-01");
		assert.equal(
			decodeValue("date", encodeValue("date", "0099-12-31", "due"), "due"),
			"0099-12-31",
		);
	});

	test("bytes, uuid and bool keep their native types", () => {
		assertRoundTrips("bytes", "AAECA/8=");
		assertRoundTrips("bytes", "");
		assertRoundTrips("uuid", "0f8fad5b-d9cb-469f-a165-70867728950e");
		assertRoundTrips("bool", false);
	});

	test("an encrypted value moves as ciphertext bytes, never interpreted", () => {
		assertRoundTrips("encrypted", {
			alg: "AES-256-GCM",
			keyRef: "key://subject/1",
			ciphertext: "3q2+7w==",
		});
	});
});

describe("constrained types refuse loudly", () => {
	test("decimal: 34 significant digits round-trip; one more is refused, never rounded", () => {
		const fits = "1234567890123456789012345678901234";
		assertRoundTrips("decimal", fits);
		assertRoundTrips("decimal", "0.000000000000000000000000000001");
		assertRoundTrips("decimal", "-1234.5600");
		// 37 digits, but only one of them significant: exact as 1E+36.
		assertRoundTrips("decimal", "1000000000000000000000000000000000000");

		const tooLong = "1234567890123456789012345678901234567890.123456789";
		const error = refusal(() => encodeValue("decimal", tooLong, "price"));
		assert.equal(error.code, "MONGODB_VALUE_NOT_REPRESENTABLE");
		assert.equal(error.detail.constraint, "DECIMAL128_PRECISION");
		assert.equal(error.detail.field, "price");
		// The refusal names the field and the rule, never the value.
		assert.ok(!error.message.includes("1234567890"));
		assert.ok(!JSON.stringify(error.detail).includes("1234567890"));
		refusal(() =>
			encodeValue("decimal", "12345678901234567890123456789012345", "price"),
		);
	});

	test("decimal: what a server prints in scientific notation decodes to plain text", () => {
		assert.equal(formatDecimal128("0.0000001234"), "1.234E-7");
		assert.equal(fromDecimal128Text("1.234E-7"), "0.0000001234");
		assert.equal(fromDecimal128Text("1E+3"), "1000");
		assert.equal(
			formatDecimal128("1000000000000000000000000000000000000"),
			"1.000000000000000000000000000000000E+36",
		);
		assert.equal(formatDecimal128("10E+6111"), "1.0E+6112");
		assert.equal(formatDecimal128("1.10"), "1.10");
		assert.equal(formatDecimal128("-0"), "-0");
		assert.equal(formatDecimal128("0.000001"), "0.000001");
		assert.equal(toDecimal128Text("1000"), "1000");
		assert.equal(toDecimal128Text("1E7000"), undefined);
		assert.equal(fromDecimal128Text("NaN"), undefined);
		assert.equal(
			decodeValue("decimal", { $numberDecimal: "1.234E-7" }, "price"),
			"0.0000001234",
		);
	});

	test("string: an unpaired surrogate is refused, because UTF-8 would store U+FFFD", () => {
		const error = refusal(() => encodeValue("string", "a\ud800b", "note"));
		assert.equal(error.code, "MONGODB_VALUE_NOT_REPRESENTABLE");
		assert.equal(error.detail.constraint, "WELL_FORMED_UNICODE");
		assert.equal(
			encodeValue("string", "pair \u{1F600} and NUL \u0000", "note"),
			"pair \u{1F600} and NUL \u0000",
		);
		refusal(() => documentId("tenant\udfff", '["k"]'));
		refusal(() => documentId("tenant", '["\ud83d"]'));
	});

	test("json: keys MongoDB reserves or cannot store are refused; everything else is exact", () => {
		for (const hostile of [
			{ $where: "x" },
			{ nested: [{ $numberLong: "5" }] },
			{ "a\u0000b": 1 },
		]) {
			const error = refusal(() => encodeValue("json", hostile, "attrs"));
			assert.equal(error.detail.constraint, "OBJECT_KEY");
		}
		refusal(() => encodeValue("json", ["a\ud800"], "attrs"));
		assertRoundTrips("json", {
			"dotted.key": 1,
			"": "empty key",
			deep: [[[{ a: null }]]],
		});
		assertRoundTrips("json", [
			1,
			-0,
			1.5,
			1e300,
			9007199254740992,
			true,
			null,
			"s",
		]);
		assertRoundTrips("json", "a bare string");
		assertRoundTrips("json", 42);
		// A key named __proto__ is data, not a prototype.
		const parsed: JsonValue = JSON.parse('{"__proto__":{"x":1},"b":2}');
		const back = roundTrip("json", parsed);
		assert.equal(canonicalEncode(back), '{"__proto__":{"x":1},"b":2}');
	});
});

describe("values written outside the binding are refused on read, never coerced", () => {
	const cases: readonly (readonly [CanonicalType, MongoValue, string])[] = [
		["float64", { $numberDouble: "NaN" }, "a NaN double"],
		["float64", { $numberDouble: "Infinity" }, "an infinite double"],
		["decimal", { $numberDecimal: "NaN" }, "a NaN decimal"],
		["decimal", { $numberDecimal: "-Infinity" }, "an infinite decimal"],
		["decimal", { $numberDouble: "1.5" }, "a double in a decimal field"],
		["int64", "5", "a string in an int64 field"],
		["int64", { $numberDouble: "5.0" }, "a double in an int64 field"],
		["bool", { $numberInt: "1" }, "an int in a bool field"],
		["string", { $numberInt: "1" }, "an int in a string field"],
		[
			"date",
			{ $date: { $numberLong: "1772236800001" } },
			"a date that is not midnight",
		],
		[
			"date",
			{ $date: { $numberLong: "253402300800000" } },
			"a date in year 10000",
		],
		["date", "2026-02-28", "a string in a date field"],
		[
			"uuid",
			{ $binary: { base64: "AAECAw==", subType: "04" } },
			"a 4-byte uuid",
		],
		[
			"uuid",
			{ $binary: { base64: "D4+tW9nLRp+hZXCGdyiVDg==", subType: "00" } },
			"generic binary in a uuid field",
		],
		["bytes", "AAEC", "a string in a bytes field"],
		[
			"json",
			{ at: { $date: { $numberLong: "0" } } },
			"a BSON date inside json",
		],
		[
			"json",
			{ id: { $oid: "507f1f77bcf86cd799439011" } },
			"an ObjectId inside json",
		],
		[
			"json",
			{ n: { $numberLong: "9007199254740993" } },
			"a long beyond 2^53 inside json",
		],
		["json", { n: { $numberDecimal: "1.5" } }, "a Decimal128 inside json"],
		[
			"encrypted",
			{ alg: "A", keyRef: "k" },
			"an encrypted value with no ciphertext",
		],
		[
			"encrypted",
			{ alg: "A", keyRef: "k", ciphertext: "3q2+7w==" },
			"ciphertext stored as text",
		],
	];

	for (const [type, stored, label] of cases) {
		test(label, () => {
			const error = refusal(() => decodeValue(type, stored, "field"));
			assert.equal(error.code, "MONGODB_NON_CANONICAL_VALUE");
			assert.equal(error.detail.type, type);
		});
	}

	test("a natively written int32 or safe long is still an exact number", () => {
		assert.equal(decodeValue("int64", { $numberInt: "7" }, "qty"), "7");
		assert.deepEqual(
			decodeValue(
				"json",
				{ n: { $numberInt: "7" }, m: { $numberLong: "8" } },
				"attrs",
			),
			{ n: 7, m: 8 },
		);
	});

	test("text in a timestamp field that is not a timestamp fails the canonical parse", () => {
		const document = {
			...encodeDocument(SCHEMA, "", '["order-1"]', record()),
			placed_at: "last tuesday",
		};
		assert.throws(
			() => decodeDocument(SCHEMA, document),
			(cause) =>
				cause instanceof DataCoreError && cause.code === "INVALID_RECORD",
		);
	});
});
