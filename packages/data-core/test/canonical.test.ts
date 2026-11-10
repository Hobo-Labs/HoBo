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
