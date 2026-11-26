// The canonical model is the hub. If two spellings of one value do not
// normalise to the same bytes, a cross-engine digest reports a difference
// that is not there — so every normal form is pinned here.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	bucketOf,
	canonicalEncode,
	compareDigests,
	composeTypeMapping,
	DatasetDigestBuilder,
	decodeRecordKey,
	encodeRecordKey,
	instantMicros,
	normalizeCanonicalValue,
	parseCanonicalRecord,
	parseChangeEnvelope,
	parseDatasetSchema,
	parseTypeMappingAnnex,
	REFERENCE_TYPE_MAPPING,
	recordDigest,
	schemaDigest,
} from "../src/index.js";

const SCHEMA = parseDatasetSchema({
	name: "ledger",
	keyFields: ["account", "seq"],
	fields: [
		{ name: "account", type: "string", nullable: false },
		{ name: "seq", type: "int64", nullable: false },
		{ name: "amount", type: "decimal", nullable: false },
		{ name: "at", type: "timestamp", nullable: false },
		{ name: "memo", type: "string", nullable: true },
	],
});

describe("canonical values", () => {
	test("each type has exactly one normal form", () => {
		const n = normalizeCanonicalValue;
		assert.equal(n("int64", 42, "f"), "42");
		assert.equal(n("int64", "-0", "f"), "0");
		assert.equal(n("int64", "9223372036854775807", "f"), "9223372036854775807");
		assert.equal(n("decimal", "001234.5600", "f"), "1234.56");
		assert.equal(n("decimal", "-0.0", "f"), "0");
		assert.equal(n("decimal", "10", "f"), "10");
		assert.equal(
			n("timestamp", "2026-01-02T05:04:05.678+02:00", "f"),
			"2026-01-02T03:04:05.678000Z",
		);
		assert.equal(
			n("timestamp", "2026-01-02 03:04:05Z", "f"),
			"2026-01-02T03:04:05.000000Z",
		);
		assert.equal(
			n("timestamp", "2026-01-02T03:04:05.123456000Z", "f"),
			"2026-01-02T03:04:05.123456Z",
		);
		assert.equal(
			n("uuid", "0F8FAD5B-D9CB-469F-A165-70867728950E", "f"),
			"0f8fad5b-d9cb-469f-a165-70867728950e",
		);
		assert.equal(n("bytes", "AAECA/8=", "f"), "AAECA/8=");
		assert.equal(n("date", "2024-02-29", "f"), "2024-02-29");
	});

	test("values that cannot be represented are refused, never rounded", () => {
		const n = normalizeCanonicalValue;
		assert.throws(
			() => n("int64", "9223372036854775808", "f"),
			/out of range/u,
		);
		assert.throws(() => n("int64", 2 ** 53, "f"), /safe integer/u);
		assert.throws(() => n("int64", 1.5, "f"), /safe integer/u);
		assert.throws(
			() => n("timestamp", "2026-01-02T03:04:05.1234567Z", "f"),
			/microseconds/u,
		);
		assert.throws(
			() => n("timestamp", "2026-01-02T03:04:05", "f"),
			/explicit offset/u,
		);
		assert.throws(() => n("date", "2026-02-30", "f"), /real calendar date/u);
		assert.throws(() => n("decimal", "1e3", "f"), /plain decimal/u);
		assert.throws(() => n("float64", Number.POSITIVE_INFINITY, "f"), /finite/u);
		assert.throws(() => n("bytes", "not base64!", "f"), /base64/u);
		assert.throws(
			() => n("encrypted", { alg: "x", keyRef: "", ciphertext: "AA==" }, "f"),
			/keyRef/u,
		);
	});

	test("first-century dates are not moved nineteen centuries", () => {
		const n = normalizeCanonicalValue;
		// `Date.UTC` maps years 0–99 onto 1900–1999; the model must not.
		assert.equal(
			n("timestamp", "0001-01-01T00:00:00Z", "f"),
			"0001-01-01T00:00:00.000000Z",
		);
		assert.equal(
			n("timestamp", "0050-06-15T12:30:00+00:00", "f"),
			"0050-06-15T12:30:00.000000Z",
		);
		assert.equal(n("date", "0001-01-01", "f"), "0001-01-01");
		assert.equal(n("date", "0099-12-31", "f"), "0099-12-31");
		assert.throws(
			() => n("timestamp", "2026-02-30T00:00:00Z", "f"),
			/real instant/u,
		);
		assert.throws(
			() => n("timestamp", "2026-01-01T25:00:00Z", "f"),
			/real instant/u,
		);
		assert.throws(
			() => n("timestamp", "9999-12-31T23:59:59-01:00", "f"),
			/0000-9999/u,
		);
	});

	test("an unpaired surrogate is refused: it has no bytes to digest", () => {
		const n = normalizeCanonicalValue;
		assert.throws(() => n("string", "a\ud800b", "f"), /unpaired surrogate/u);
		assert.throws(() => n("string", "\udc00", "f"), /unpaired surrogate/u);
		assert.throws(
			() => n("json", { k: ["\ud83d"] }, "f"),
			/unpaired surrogate/u,
		);
		assert.throws(() => n("json", { "\ud83d": 1 }, "f"), /unpaired surrogate/u);
		// A real pair is fine.
		assert.equal(n("string", "ok \ud83d\ude80", "f"), "ok \ud83d\ude80");
	});

	test("an open schema keeps a field named __proto__ instead of dropping it", () => {
		const open = parseDatasetSchema({
			name: "bag",
			keyFields: ["id"],
			fields: [{ name: "id", type: "string", nullable: false }],
			open: true,
		});
		const record = parseCanonicalRecord(
			open,
			JSON.parse('{"id":"a","__proto__":{"x":1}}'),
		);
		assert.deepEqual(Object.keys(record).sort(), ["__proto__", "id"]);
		assert.match(canonicalEncode(record), /"__proto__":\{"x":1\}/u);
	});

	test("two spellings of one record are the same record", () => {
		const a = parseCanonicalRecord(SCHEMA, {
			account: "acme",
			seq: 7,
			amount: "12.50",
			at: "2026-03-01T12:00:00+00:00",
		});
		const b = parseCanonicalRecord(SCHEMA, {
			memo: null,
			at: "2026-03-01T13:00:00.000000+01:00",
			amount: "012.5",
			seq: "7",
			account: "acme",
		});
		assert.equal(canonicalEncode(a), canonicalEncode(b));
		assert.equal(
			recordDigest("t", encodeRecordKey(SCHEMA, a), a),
			recordDigest("t", encodeRecordKey(SCHEMA, b), b),
		);
	});

	test("a key round-trips and a composite key keeps its order", () => {
		const record = parseCanonicalRecord(SCHEMA, {
			account: "acme",
			seq: "9007199254740993",
			amount: "1",
			at: "2026-03-01T12:00:00Z",
		});
		const key = encodeRecordKey(SCHEMA, record);
		assert.equal(key, '["acme","9007199254740993"]');
		assert.deepEqual(decodeRecordKey(SCHEMA, key), {
			account: "acme",
			seq: "9007199254740993",
		});
		assert.throws(() => decodeRecordKey(SCHEMA, '["only-one"]'), /key fields/u);
	});

	test("a closed schema refuses undeclared fields; an open one keeps them", () => {
		const raw = {
			account: "a",
			seq: 1,
			amount: "1",
			at: "2026-03-01T12:00:00Z",
			extra: [1],
		};
		assert.throws(() => parseCanonicalRecord(SCHEMA, raw), /not declared/u);
		const open = parseDatasetSchema({
			...JSON.parse(JSON.stringify(SCHEMA)),
			open: true,
		});
		assert.deepEqual(parseCanonicalRecord(open, raw).extra, [1]);
		assert.notEqual(schemaDigest(open), schemaDigest(SCHEMA));
	});

	test("the schema parser refuses nullable keys, float keys, duplicates, and bad names", () => {
		const base = {
			name: "t",
			keyFields: ["id"],
			fields: [{ name: "id", type: "string", nullable: false }],
		};
		assert.throws(
			() => parseDatasetSchema({ ...base, name: "Bad-Name" }),
			/snake_case/u,
		);
		assert.throws(
			() =>
				parseDatasetSchema({
					...base,
					fields: [{ name: "id", type: "string", nullable: true }],
				}),
			/non-nullable/u,
		);
		assert.throws(
			() =>
				parseDatasetSchema({
					...base,
					fields: [{ name: "id", type: "float64", nullable: false }],
				}),
			/must be non-nullable and one of/u,
		);
		assert.throws(
			() =>
				parseDatasetSchema({
					...base,
					fields: [...base.fields, ...base.fields],
				}),
			/duplicate field/u,
		);
		assert.throws(
			() => parseDatasetSchema({ ...base, keyFields: ["missing"] }),
			/not declared/u,
		);
	});

	test("an envelope must agree with its op", () => {
		const base = {
			dataset: "ledger",
			position: "5",
			key: '["a","1"]',
			tenant: "",
			schemaVersion: 1,
		};
		assert.throws(
			() => parseChangeEnvelope(SCHEMA, { ...base, op: "upsert" }),
			/carries a record/u,
		);
		assert.throws(
			() => parseChangeEnvelope(SCHEMA, { ...base, op: "delete", record: {} }),
			/carries no record/u,
		);
		assert.throws(
			() =>
				parseChangeEnvelope(SCHEMA, {
					...base,
					dataset: "other",
					op: "delete",
				}),
			/different dataset/u,
		);
		assert.equal(
			parseChangeEnvelope(SCHEMA, { ...base, op: "delete" }).op,
			"delete",
		);
	});
});

describe("dataset digests", () => {
	const record = (seq: number) =>
		parseCanonicalRecord(SCHEMA, {
			account: "a",
			seq,
			amount: "1",
			at: "2026-03-01T12:00:00Z",
		});

	test("a digest does not depend on the order rows arrive in", () => {
		const forward = new DatasetDigestBuilder("ledger", "", 8);
		const backward = new DatasetDigestBuilder("ledger", "", 8);
		const rows = Array.from({ length: 50 }, (_, index) => record(index));
		for (const row of rows) forward.add("", encodeRecordKey(SCHEMA, row), row);
		for (const row of [...rows].reverse())
			backward.add("", encodeRecordKey(SCHEMA, row), row);
		assert.ok(compareDigests(forward.finish(), backward.finish()).equal);
		assert.equal(forward.finish().count, 50);
	});

	test("one changed record is localised to one bucket", () => {
		const left = new DatasetDigestBuilder("ledger", "", 8);
		const right = new DatasetDigestBuilder("ledger", "", 8);
		for (let index = 0; index < 50; index += 1) {
			const row = record(index);
			left.add("", encodeRecordKey(SCHEMA, row), row);
			const altered =
				index === 17
					? parseCanonicalRecord(SCHEMA, { ...row, amount: "2" })
					: row;
			right.add("", encodeRecordKey(SCHEMA, altered), altered);
		}
		const comparison = compareDigests(left.finish(), right.finish());
		assert.equal(comparison.equal, false);
		assert.deepEqual(comparison.mismatchedBuckets, [
			bucketOf("", encodeRecordKey(SCHEMA, record(17)), 8),
		]);
	});

	test("digests with different bucket counts are not comparable, and say so", () => {
		const a = new DatasetDigestBuilder("ledger", "", 8).finish();
		const b = new DatasetDigestBuilder("ledger", "", 16).finish();
		assert.throws(() => compareDigests(a, b), /different bucket counts/u);
		assert.throws(
			() => new DatasetDigestBuilder("ledger", "", 0),
			/bucket count/u,
		);
	});
});

describe("type-mapping annex", () => {
	const lossy = parseTypeMappingAnnex({
		engine: "legacy",
		edges: [
			{
				canonical: "string",
				native: "varchar",
				write: "exact",
				read: "exact",
				note: "",
			},
			{
				canonical: "int64",
				native: "bigint",
				write: "exact",
				read: "exact",
				note: "",
			},
			{
				canonical: "decimal",
				native: "double",
				write: "lossy",
				read: "exact",
				note: "binary floating point",
			},
			{
				canonical: "timestamp",
				native: "datetime(3)",
				write: "constrained",
				read: "exact",
				note: "millisecond precision; finer values are refused",
			},
		],
	});

	test("a composed mapping reports every non-exact field and why", () => {
		const findings = composeTypeMapping(SCHEMA, REFERENCE_TYPE_MAPPING, lossy);
		assert.deepEqual(
			findings.map((finding) => [finding.field, finding.code]),
			[
				["amount", "MAPPING_LOSSY"],
				["at", "MAPPING_CONSTRAINED"],
			],
		);
		assert.equal(findings[0]?.waiverKey, "MAPPING_LOSSY:ledger.amount");
		assert.match(findings[0]?.detail ?? "", /binary floating point/u);
	});

	test("a type an engine cannot carry is unsupported, not skipped", () => {
		const narrow = parseTypeMappingAnnex({
			engine: "narrow",
			edges: [
				{
					canonical: "string",
					native: "text",
					write: "exact",
					read: "exact",
					note: "",
				},
			],
		});
		const findings = composeTypeMapping(SCHEMA, REFERENCE_TYPE_MAPPING, narrow);
		assert.ok(
			findings.every((finding) => finding.code === "MAPPING_UNSUPPORTED_TYPE"),
		);
		assert.equal(findings.length, 3);
	});

	test("a non-exact edge with no explanation is refused", () => {
		assert.throws(
			() =>
				parseTypeMappingAnnex({
					engine: "silent",
					edges: [
						{
							canonical: "decimal",
							native: "double",
							write: "lossy",
							read: "exact",
							note: "",
						},
					],
				}),
			/must explain itself/u,
		);
	});
});

// Each of these normalised to a value nobody wrote while both sides of a move
// still digested equal. A normal form either keeps the value or refuses it.
describe("normal forms never alter a value silently", () => {
	const n = normalizeCanonicalValue;
	const ENCRYPTED = { alg: "AES-256-GCM", keyRef: "key:7", ciphertext: "QQ==" };

	test("an encrypted value has exactly alg, keyRef and ciphertext; any other member is refused, never dropped", () => {
		assert.deepEqual(n("encrypted", ENCRYPTED, "f"), ENCRYPTED);
		for (const extra of [
			{ iv: "AAAA" },
			{ tag: "BBBB" },
			{ iv: "AAAA", tag: "BBBB" },
			{ aad: null },
		]) {
			assert.throws(
				() => n("encrypted", { ...ENCRYPTED, ...extra }, "f"),
				/member\(s\) other than alg, keyRef, ciphertext/u,
			);
		}
		// The refusal names no member and no value: either may be key material.
		assert.throws(
			() => n("encrypted", { ...ENCRYPTED, wrappedKey: "c2VjcmV0" }, "f"),
			(error: Error) =>
				!error.message.includes("wrappedKey") &&
				!error.message.includes("c2VjcmV0"),
		);
		const schema = parseDatasetSchema({
			name: "vault",
			keyFields: ["id"],
			fields: [
				{ name: "id", type: "string", nullable: false },
				{ name: "secret", type: "encrypted", nullable: false },
			],
		});
		assert.throws(
			() =>
				parseCanonicalRecord(schema, {
					id: "a",
					secret: { ...ENCRYPTED, iv: "AAAA", tag: "BBBB" },
				}),
			/member\(s\) other than/u,
		);
	});

	test("a timestamp offset is bounded to ±23:59 with minutes at most 59", () => {
		for (const offset of ["+99:99", "+24:00", "-24:00", "+23:60", "-00:60"]) {
			assert.throws(
				() => n("timestamp", `2026-01-02T05:04:05${offset}`, "f"),
				/explicit offset of at most ±23:59/u,
				offset,
			);
			assert.throws(
				() =>
					n("timestamp", `2026-01-02T05:04:05${offset.replace(":", "")}`, "f"),
				/explicit offset of at most ±23:59/u,
				offset,
			);
		}
		assert.equal(
			n("timestamp", "2026-01-02T05:04:05+23:59", "f"),
			"2026-01-01T05:05:05.000000Z",
		);
		assert.equal(
			n("timestamp", "2026-01-02T05:04:05-2359", "f"),
			"2026-01-03T05:03:05.000000Z",
		);
		assert.equal(
			n("timestamp", "2026-01-02T05:04:05-00:00", "f"),
			"2026-01-02T05:04:05.000000Z",
		);
	});

	test("float64 has no negative zero: -0 normalises to 0, as it already digests", () => {
		assert.ok(Object.is(n("float64", -0, "f"), 0));
		assert.ok(Object.is(n("float64", 0, "f"), 0));
		assert.equal(n("float64", -1.5, "f"), -1.5);
		assert.equal(n("float64", 5e-324, "f"), 5e-324);
		const schema = parseDatasetSchema({
			name: "scale",
			keyFields: ["id"],
			fields: [
				{ name: "id", type: "string", nullable: false },
				{ name: "weight", type: "float64", nullable: false },
				{ name: "attrs", type: "json", nullable: true },
			],
		});
		const negative = parseCanonicalRecord(schema, {
			id: "a",
			weight: -0,
			attrs: { readings: [-0, 1.5] },
		});
		const positive = parseCanonicalRecord(schema, {
			id: "a",
			weight: 0,
			attrs: { readings: [0, 1.5] },
		});
		// Equal digests now describe equal values, not two values an engine
		// may store apart.
		assert.deepEqual(negative, positive);
		assert.ok(Object.is(negative.weight, 0));
		const key = encodeRecordKey(schema, negative);
		assert.equal(
			recordDigest("", key, negative),
			recordDigest("", key, positive),
		);
	});

	test("NaN and the infinities are refused wherever a number can appear", () => {
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			assert.throws(() => n("float64", value, "f"), /no canonical form/u);
			// Inside a json value they would digest as `null`.
			assert.throws(() => n("json", { a: [value] }, "f"), /no canonical form/u);
		}
		assert.throws(() => n("float64", "1.5", "f"), /must be a number/u);
	});

	test("a json value comes back in normal form without touching the caller's value", () => {
		// A member named `__proto__` is data, and survives the rebuild.
		const output = n(
			"json",
			JSON.parse('{"__proto__":{"x":-0},"list":[1,{"y":"z"}]}'),
			"f",
		);
		assert.equal(
			canonicalEncode(output),
			'{"__proto__":{"x":0},"list":[1,{"y":"z"}]}',
		);
		const reading = { x: -0 };
		const normal = n("json", { readings: [reading] }, "f");
		assert.deepEqual(normal, { readings: [{ x: 0 }] });
		assert.ok(Object.is(reading.x, -0));
	});
});

describe("instantMicros", () => {
	test("reads an RFC 3339 instant to microseconds since the epoch", () => {
		assert.equal(instantMicros("1970-01-01T00:00:00Z"), 0n);
		assert.equal(instantMicros("1970-01-01T00:00:00.000001Z"), 1n);
		assert.equal(instantMicros("1969-12-31T23:59:59.999999Z"), -1n);
		assert.equal(
			instantMicros("2026-11-10T09:00:00+09:00"),
			instantMicros("2026-11-10T00:00:00.000Z"),
		);
		// Exact past 2^53 microseconds, where a double would round.
		assert.equal(
			instantMicros("9999-12-31T23:59:59.999999Z"),
			253402300799999999n,
		);
	});

	test("anything that is not a strict instant is undefined, never a guess", () => {
		for (const text of [
			"2026-11-10T00:00:00", // no offset: local time to Date.parse
			"2026-11-10", // a date
			"2026-11-10T00:00:00+99:99",
			"2026-02-30T00:00:00Z",
			"2026-11-10T00:00:00.1234567Z",
			"Tue, 10 Nov 2026 00:00:00 GMT",
			"1762732800000",
			"soon",
			"",
		]) {
			assert.equal(instantMicros(text), undefined, text);
		}
	});
});
