/**
 * The value coercions, payload codecs, id generator and Node driver adapter.
 *
 * These sit between SQLite's loose value model and the EventStore's strict
 * one. The failure they guard is silent and durable: a fence or position that
 * arrives as a `number` and loses precision, a payload written as an
 * ambiguous JSON-looking BLOB with no codec metadata, or two events minted
 * with the same id inside one millisecond. None of those surface until a
 * replay disagrees with what was written.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { asNullableText } from "../src/driver.js";
import {
	asBigInt,
	asBytes,
	asNumber,
	asText,
	createDeterministicId,
	createMemoryNodeSqliteDriver,
	createNodeSqliteDriver,
	createUlidGenerator,
	DEFAULT_METADATA_CODEC,
	DEFAULT_PAYLOAD_CODEC,
	DEFAULT_STATE_CODEC,
	decodeJson,
	decodeLegacyJsonText,
	decodeMetadata,
	decodePayload,
	encodeJson,
	encodeLegacyJsonText,
	encodeMetadata,
	encodePayload,
	type PayloadCodec,
	parseCodec,
	UnsupportedCodecError,
} from "../src/index.js";
import { isJsonString } from "../src/json.js";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-sqlite-"));
	temps.push(dir);
	return dir;
}

describe("asBigInt", () => {
	it("passes a bigint through and widens a safe integer", () => {
		expect(asBigInt(7n, "seq")).toBe(7n);
		expect(asBigInt(7, "seq")).toBe(7n);
		expect(asBigInt(0, "seq")).toBe(0n);
		expect(asBigInt(-3, "seq")).toBe(-3n);
	});

	it("parses a decimal string, including a negative one", () => {
		// SQLite may hand back a fence as text depending on the driver and the
		// column affinity; refusing it would make a perfectly valid row
		// unreadable.
		expect(asBigInt("9007199254740993", "fence")).toBe(9007199254740993n);
		expect(asBigInt("-42", "fence")).toBe(-42n);
	});

	it("refuses an unsafe integer rather than silently truncating", () => {
		// This is the whole point: a fence past `Number.MAX_SAFE_INTEGER` that
		// came back as a float has *already* lost precision, so converting it
		// would durably record a value nobody wrote.
		expect(() => asBigInt(2 ** 53, "fence")).toThrowError(
			/fence must be integer\/bigint/u,
		);
		expect(() => asBigInt(1.5, "fence")).toThrowError(/must be integer/u);
	});

	it("refuses a non-numeric string and every other type", () => {
		for (const value of ["", "12a", "1.0", "0x10", null, undefined, {}, true]) {
			expect(() => asBigInt(value, "fence"), String(value)).toThrowError(
				TypeError,
			);
		}
	});

	it("names the field in the error", () => {
		// A row has many integer columns; an error that did not say which one
		// leaves an operator reading the whole schema.
		expect(() => asBigInt(null, "streamHead")).toThrowError(/streamHead/u);
	});
});

describe("asNumber", () => {
	it("passes a finite number through", () => {
		expect(asNumber(1.5, "n")).toBe(1.5);
		expect(asNumber(0, "n")).toBe(0);
		expect(asNumber(-1, "n")).toBe(-1);
	});

	it("narrows a bigint that fits", () => {
		expect(asNumber(7n, "n")).toBe(7);
		expect(asNumber(BigInt(Number.MAX_SAFE_INTEGER), "n")).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	});

	it("refuses a bigint outside the safe range in both directions", () => {
		// Narrowing an out-of-range bigint would produce a plausible-looking
		// wrong number — far worse than refusing, because nothing downstream
		// would notice.
		expect(() =>
			asNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "n"),
		).toThrowError(/out of safe number range/u);
		expect(() =>
			asNumber(BigInt(Number.MIN_SAFE_INTEGER) - 1n, "n"),
		).toThrowError(/out of safe number range/u);
	});

	it("parses a numeric string but refuses an empty one", () => {
		expect(asNumber("42", "n")).toBe(42);
		expect(asNumber("-1.5", "n")).toBe(-1.5);
		// `Number("")` is 0, which would turn a missing value into a real one.
		expect(() => asNumber("", "n")).toThrowError(/must be a number/u);
	});

	it("refuses non-finite values and other types", () => {
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			"abc",
			null,
			undefined,
			{},
			true,
		]) {
			expect(() => asNumber(value, "n"), String(value)).toThrowError(TypeError);
		}
	});
});

describe("asText / asNullableText", () => {
	it("passes strings through, including the empty one", () => {
		expect(asText("", "t")).toBe("");
		expect(asText("x", "t")).toBe("x");
	});

	it("refuses anything that is not a string", () => {
		// No stringification: a number silently becoming `"7"` would let a
		// mistyped column round-trip and look correct.
		for (const value of [7, null, undefined, {}, true]) {
			expect(() => asText(value, "t"), String(value)).toThrowError(TypeError);
		}
	});

	it("maps both null and undefined onto null", () => {
		// SQLite has one absent value; JavaScript has two. Collapsing them here
		// keeps every nullable column reading the same way.
		expect(asNullableText(null)).toBeNull();
		expect(asNullableText(undefined)).toBeNull();
		expect(asNullableText("x")).toBe("x");
		expect(() => asNullableText(7)).toThrowError(/expected string or null/u);
	});
});

describe("asBytes", () => {
	it("passes a Uint8Array through by reference", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(asBytes(bytes, "payload")).toBe(bytes);
	});

	it("converts a Node Buffer to a plain Uint8Array", () => {
		const buffer = Buffer.from([1, 2, 3]);
		const bytes = asBytes(buffer, "payload");
		expect([...bytes]).toEqual([1, 2, 3]);
		// A Buffer *is* a Uint8Array, so the instanceof check above already
		// catches it — this pins that the result is usable as plain bytes either
		// way, which is what the browser driver will also produce.
		expect(bytes).toBeInstanceOf(Uint8Array);
	});

	it("encodes a string as UTF-8", () => {
		// Legacy rows stored payloads in TEXT columns; reading one back must
		// produce the same bytes the codec would have written.
		expect([...asBytes("hi", "payload")]).toEqual([104, 105]);
		expect([...asBytes("é", "payload")]).toEqual([195, 169]);
	});

	it("refuses anything else", () => {
		for (const value of [7, null, undefined, {}, [1, 2]]) {
			expect(() => asBytes(value, "payload"), String(value)).toThrowError(
				/payload must be bytes/u,
			);
		}
	});
});

describe("payload codecs", () => {
	it("defaults every column to json-v1", () => {
		// The defaults are a wire contract: a row written with no explicit codec
		// must be readable by a process that also assumes the default.
		expect(DEFAULT_PAYLOAD_CODEC).toBe("json-v1");
		expect(DEFAULT_METADATA_CODEC).toBe("json-v1");
		expect(DEFAULT_STATE_CODEC).toBe("json-v1");
	});

	it("round-trips JSON values", () => {
		for (const value of [
			{ a: 1 },
			[1, 2],
			"text",
			42,
			true,
			null,
			{ nested: { deep: [1, { x: null }] } },
		]) {
			expect(decodeJson(encodeJson(value)), JSON.stringify(value)).toEqual(
				value,
			);
		}
	});

	it("encodes undefined as null rather than as nothing", () => {
		// `JSON.stringify(undefined)` is `undefined`, not a string — encoding it
		// unguarded would write a zero-byte BLOB that reads back as a decode
		// failure rather than as an absent value.
		expect(decodeJson(encodeJson(undefined))).toBeNull();
		expect(encodeLegacyJsonText(undefined)).toBe("null");
	});

	it("decodes an empty byte string as null", () => {
		// A zero-length BLOB is what a legacy row with no payload looks like;
		// `JSON.parse("")` would throw and make the row unreadable.
		expect(decodeJson(new Uint8Array())).toBeNull();
	});

	it("round-trips legacy TEXT columns", () => {
		expect(decodeLegacyJsonText(encodeLegacyJsonText({ a: 1 }))).toEqual({
			a: 1,
		});
	});

	it("passes protobuf-v1 payloads through untouched", () => {
		const bytes = new Uint8Array([0x08, 0x96, 0x01]);
		// Bytes in, same bytes out — re-encoding a protobuf payload as JSON
		// would corrupt it while looking like a successful write.
		expect(encodePayload("protobuf-v1", bytes)).toBe(bytes);
		expect(decodePayload("protobuf-v1", bytes)).toBe(bytes);
	});

	it("refuses a protobuf-v1 payload that is not bytes", () => {
		expect(() => encodePayload("protobuf-v1", { a: 1 })).toThrowError(
			/protobuf-v1 payload must be Uint8Array/u,
		);
	});

	it("refuses an unknown codec on the way in and on the way out", () => {
		// This is the "no ambiguous JSON-looking BLOB" rule: a row whose codec
		// column names something this build does not implement must fail loudly
		// rather than be guessed at as JSON.
		// SAFETY: `encodePayload("gzip-v1" as PayloadCodec, { a: 1 })` is required at this I/O or test boundary.
		const encoding = (): Uint8Array =>
			encodePayload("gzip-v1" as PayloadCodec, { a: 1 });
		expect(encoding).toThrowError(UnsupportedCodecError);
		try {
			decodePayload("gzip-v1", new Uint8Array());
			expect.unreachable("an unknown codec must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(UnsupportedCodecError);
			if (!(error instanceof UnsupportedCodecError)) throw error;
			expect(error.code).toBe("UNSUPPORTED_CODEC");
			expect(error.codec).toBe("gzip-v1");
			expect(error.field).toBe("payload");
		}
	});

	it("round-trips metadata and coerces a non-object to an empty record", () => {
		expect(
			decodeMetadata("json-v1", encodeMetadata("json-v1", { a: 1 })),
		).toEqual({ a: 1 });
		// Metadata is always a record to its callers. A stored `null` or array
		// becomes `{}` rather than propagating a shape the caller cannot index.
		for (const value of [null, [1, 2], "text", 42]) {
			expect(
				decodeMetadata("json-v1", encodeJson(value)),
				JSON.stringify(value),
			).toEqual({});
		}
	});

	it("coerces protobuf metadata bytes to an empty record", () => {
		// `decodePayload` hands back the raw Uint8Array. A typed array is not a
		// JsonObject under the tagOf-based guard (`[object Uint8Array]`, not
		// `[object Object]`), so — like nulls, arrays, and scalars above — it
		// becomes the empty record metadata callers can always index. Earlier
		// guard semantics passed the bytes through as a JsonObject in name only.
		const bytes = new Uint8Array([1, 2]);
		expect(decodeMetadata("protobuf-v1", bytes)).toEqual({});
	});

	it("parseCodec accepts the two known codecs and names the field otherwise", () => {
		expect(parseCodec("json-v1", "payload")).toBe("json-v1");
		expect(parseCodec("protobuf-v1", "state")).toBe("protobuf-v1");
		try {
			parseCodec(undefined, "metadata");
			expect.unreachable("an unknown codec must be refused");
		} catch (error) {
			// The field is what tells an operator which column of the row is
			// wrong — payload, metadata and state each carry their own codec.
			if (!(error instanceof UnsupportedCodecError)) throw error;
			expect(error.field).toBe("metadata");
			expect(error.message).toContain("metadata");
		}
	});
});

describe("createUlidGenerator", () => {
	function fixedClock(iso: string) {
		return { now: () => iso };
	}

	it("produces 26-character Crockford base32 ids", () => {
		const next = createUlidGenerator(fixedClock("2026-08-08T00:00:00.000Z"));
		const id = next();
		expect(id).toHaveLength(26);
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
	});

	it("never repeats within one millisecond, past the old 32-id cycle", () => {
		// The comment in the source records the bug this replaced: sampling the
		// LOW bits of a mod-2^32 LCG gave a period of 32, so the 33rd id in one
		// millisecond collided with the first and hit the UNIQUE constraint on
		// `events.id`. 200 ids is well past that boundary.
		const next = createUlidGenerator(fixedClock("2026-08-08T00:00:00.000Z"));
		const ids = Array.from({ length: 200 }, () => next());
		expect(new Set(ids).size).toBe(200);
	});

	it("keeps the time prefix identical within one millisecond", () => {
		const next = createUlidGenerator(fixedClock("2026-08-08T00:00:00.000Z"));
		const prefixes = new Set(
			Array.from({ length: 8 }, () => next().slice(0, 10)),
		);
		// Lexicographic ordering by time is the property ULIDs exist for; only
		// the entropy suffix may vary inside a millisecond.
		expect(prefixes.size).toBe(1);
	});

	it("sorts lexicographically in time order", () => {
		let iso = "2026-08-08T00:00:00.000Z";
		const next = createUlidGenerator({ now: () => iso });
		const first = next();
		iso = "2026-08-08T00:00:01.000Z";
		const second = next();
		iso = "2026-08-08T00:01:00.000Z";
		const third = next();
		// A journal ordered by id must agree with a journal ordered by time, or
		// a replay would reorder events.
		expect([first, second, third].sort()).toEqual([first, second, third]);
	});

	it("resets the counter when the millisecond advances", () => {
		let iso = "2026-08-08T00:00:00.000Z";
		const next = createUlidGenerator({ now: () => iso });
		const firstOfMs = next();
		next();
		iso = "2026-08-08T00:00:00.001Z";
		const firstOfNextMs = next();
		// Same counter value, different time prefix — so the entropy suffix
		// repeats. That is fine and is what the reset is for: the ids still
		// differ because the prefix does.
		expect(firstOfNextMs.slice(10)).toBe(firstOfMs.slice(10));
		expect(firstOfNextMs).not.toBe(firstOfMs);
	});

	it("falls back to the wall clock when the clock returns nonsense", () => {
		// A clock port that returns an unparseable string must not produce
		// `NaN` in the time prefix, which would collapse every id onto the same
		// value and start colliding immediately.
		const next = createUlidGenerator({ now: () => "not-a-date" });
		const ids = [next(), next(), next()];
		for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
		expect(new Set(ids).size).toBe(3);
	});

	it("gives each generator its own counter", () => {
		const clock = fixedClock("2026-08-08T00:00:00.000Z");
		// Two journals in one process must not share a counter, but they will
		// produce the same sequence — which is why the id is only unique per
		// stream, and the UNIQUE constraint is per table.
		expect(createUlidGenerator(clock)()).toBe(createUlidGenerator(clock)());
	});
});

describe("createDeterministicId", () => {
	it("joins the prefix and parts with colons", () => {
		expect(createDeterministicId("evt", ["stream", "1"])).toBe("evt:stream:1");
	});

	it("is stable for the same parts and differs for different ones", () => {
		// Deterministic ids are how an idempotent append recognizes a retry; if
		// the same inputs produced two ids, a retry would double-write.
		expect(createDeterministicId("a", ["x"])).toBe(
			createDeterministicId("a", ["x"]),
		);
		expect(createDeterministicId("a", ["x"])).not.toBe(
			createDeterministicId("a", ["y"]),
		);
	});

	it("handles an empty parts list", () => {
		expect(createDeterministicId("evt", [])).toBe("evt:");
	});
});

describe("node sqlite driver", () => {
	it("opens an in-memory database and reports its kind", () => {
		const driver = createMemoryNodeSqliteDriver();
		try {
			expect(driver.kind).toBe("memory");
		} finally {
			driver.close();
		}
	});

	it("creates the parent directory for a file database", () => {
		const path = join(tempDir(), "nested", "deeper", "journal.sqlite");
		// The caller passes a path under HOBO_HOME that may not exist yet;
		// requiring them to mkdir first would make the common open fail.
		const driver = createNodeSqliteDriver({ path });
		try {
			expect(driver.kind).toBe("node");
			driver.exec("CREATE TABLE t (a INTEGER)");
		} finally {
			driver.close();
		}
	});

	it("round-trips values through prepared statements", () => {
		const driver = createMemoryNodeSqliteDriver();
		try {
			driver.exec(
				"CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, blob BLOB)",
			);
			const insert = driver.prepare("INSERT INTO t (name, blob) VALUES (?, ?)");
			const result = insert.run("a", new Uint8Array([1, 2, 3]));
			expect(result.changes).toBe(1);
			expect(Number(result.lastInsertRowid)).toBe(1);

			const row = driver.prepare("SELECT * FROM t WHERE id = ?").get(1n);
			expect(row?.name).toBe("a");
			// A Uint8Array parameter is converted to a Buffer for node:sqlite and
			// comes back as bytes; without that conversion the bind would throw.
			expect([...asBytes(row?.blob, "blob")]).toEqual([1, 2, 3]);

			expect(driver.prepare("SELECT * FROM t").all()).toHaveLength(1);
		} finally {
			driver.close();
		}
	});

	it("returns undefined from get when nothing matches", () => {
		const driver = createMemoryNodeSqliteDriver();
		try {
			driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			// Undefined rather than an empty row, so a caller's `if (!row)` reads
			// correctly instead of seeing an object full of undefined columns.
			expect(
				driver.prepare("SELECT * FROM t WHERE id = ?").get(99),
			).toBeUndefined();
			expect(driver.prepare("SELECT * FROM t").all()).toEqual([]);
		} finally {
			driver.close();
		}
	});

	it("reads 64-bit integers back as bigints without losing precision", () => {
		const driver = createMemoryNodeSqliteDriver();
		try {
			driver.exec("CREATE TABLE t (fence INTEGER)");
			const big = 9007199254740993n; // MAX_SAFE_INTEGER + 2
			driver.prepare("INSERT INTO t (fence) VALUES (?)").run(big);
			const row = driver.prepare("SELECT fence FROM t").get();
			// `readBigInts: true` is the reason this works. Without it the fence
			// would come back as a float and two distinct fences could compare
			// equal — which is a lost-update bug in the CAS path.
			expect(asBigInt(row?.fence, "fence")).toBe(big);
		} finally {
			driver.close();
		}
	});

	it("commits and rolls back an immediate transaction", () => {
		const driver = createMemoryNodeSqliteDriver();
		try {
			driver.exec("CREATE TABLE t (a INTEGER)");
			driver.beginImmediate();
			driver.prepare("INSERT INTO t VALUES (?)").run(1);
			driver.commit();
			expect(driver.prepare("SELECT * FROM t").all()).toHaveLength(1);

			driver.beginImmediate();
			driver.prepare("INSERT INTO t VALUES (?)").run(2);
			driver.rollback();
			// A rollback that left the row behind would break the one-writer CAS
			// guarantee the whole EventStore rests on.
			expect(driver.prepare("SELECT * FROM t").all()).toHaveLength(1);
		} finally {
			driver.close();
		}
	});

	it("reads and writes pragmas", () => {
		const driver = createMemoryNodeSqliteDriver();
		try {
			expect(driver.pragma("journal_mode", "WAL")).toBe("WAL");
			const mode = driver.pragma("journal_mode");
			// An in-memory database reports `memory` rather than `wal`; the point
			// is that the read path returns the first column as a scalar rather
			// than a row object.
			expect(isJsonString(mode)).toBe(true);
			expect(driver.pragma("user_version", 4)).toBe(4);
			expect(Number(driver.pragma("user_version"))).toBe(4);
		} finally {
			driver.close();
		}
	});

	it("returns null for a pragma that yields no row", () => {
		const driver = createMemoryNodeSqliteDriver();
		try {
			// Some pragmas return nothing at all. Returning `undefined` or
			// throwing would make a caller's optional-pragma probe fail.
			expect(driver.pragma("optimize")).toBeNull();
		} finally {
			driver.close();
		}
	});

	it("honours the extension-loading flag in both directions", () => {
		// Extensions are disabled by default because a journal file is
		// attacker-adjacent input; `disableExtensions: false` is the explicit
		// opt-out and must not throw on a build that lacks the API.
		const off = createMemoryNodeSqliteDriver();
		off.close();
		const on = createMemoryNodeSqliteDriver({ disableExtensions: false });
		on.close();
		const explicit = createMemoryNodeSqliteDriver({ disableExtensions: true });
		explicit.close();
		expect(true).toBe(true);
	});

	it("persists across a close and reopen of the same file", () => {
		const path = join(tempDir(), "journal.sqlite");
		const first = createNodeSqliteDriver({ path });
		first.exec("CREATE TABLE t (a INTEGER)");
		first.prepare("INSERT INTO t VALUES (?)").run(1);
		first.close();

		const second = createNodeSqliteDriver({ path });
		try {
			// Durability is the reason this package exists; an in-memory fallback
			// masquerading as a file database would lose every event on restart.
			expect(second.prepare("SELECT * FROM t").all()).toHaveLength(1);
		} finally {
			second.close();
		}
	});
});
