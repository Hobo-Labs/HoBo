// Regressions for defects a review confirmed in the binding. Each test names
// the failure it prevents. Everything here is pure or runs over a scripted
// executor; the live counterparts are in engine-hardening-live.test.ts.
import assert from "node:assert/strict";
import {
	type CanonicalType,
	canonicalEncode,
	DataCoreError,
	type DatasetSchema,
	type JsonValue,
	parseCanonicalRecord,
	parseDatasetSchema,
	type RecordMutation,
	requirePort,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import { BOOTSTRAP_MARKER, bootstrapProbe } from "../src/engine/statements.js";
import { openFieldsOf } from "../src/engine/types.js";
import {
	bootstrapStatements,
	canonicalFromNative,
	createPostgresEngine,
	encodeParameter,
	mutationsOf,
	type NativeTextSource,
	nativeTextToCanonical,
	type PgOutputCell,
	type PgOutputRelation,
	type PgOutputRowChange,
	type PgOutputTuple,
	POSTGRES_TYPE_MAPPING,
	type PostgresExecutor,
	type PostgresRow,
	SCHEMA_SNAPSHOT_REFUSALS,
} from "../src/index.js";

function refused<T>(action: () => T, label: string): DataCoreError {
	try {
		action();
	} catch (cause) {
		assert.ok(cause instanceof DataCoreError, label);
		assert.equal(cause.code, "INVALID_RECORD", label);
		return cause;
	}
	throw new Error(`${label} was not refused`);
}

describe("years 0001–0099 round-trip (they were accepted on write and refused on every read)", () => {
	const EVENTS: DatasetSchema = parseDatasetSchema({
		name: "events",
		keyFields: ["id"],
		fields: [
			{ name: "id", type: "string", nullable: false },
			{ name: "at", type: "timestamp", nullable: false },
			{ name: "on", type: "date", nullable: false },
		],
	});

	test("a first-century instant reads back as the instant that was written, in both dialects", () => {
		const cases: readonly (readonly [string, NativeTextSource, string])[] = [
			["0001-01-01T00:00:00", "select", "0001-01-01T00:00:00.000000Z"],
			["0099-12-31T23:59:59.999999", "select", "0099-12-31T23:59:59.999999Z"],
			["0001-01-01 00:00:00+00", "decoded", "0001-01-01T00:00:00.000000Z"],
			["0050-06-15 12:30:00.5+00", "decoded", "0050-06-15T12:30:00.500000Z"],
		];
		for (const [text, source, canonical] of cases) {
			assert.equal(
				nativeTextToCanonical("timestamp", text, source, "at"),
				canonical,
				text,
			);
		}
	});

	test("a whole record with first-century values survives write encoding and read parsing unchanged", () => {
		for (const raw of [
			{ id: "a", at: "0001-01-01T00:00:00Z", on: "0001-01-01" },
			{ id: "b", at: "0099-12-31T23:59:59.999999Z", on: "0099-12-31" },
			{ id: "c", at: "0001-01-01T02:00:00+02:00", on: "0042-02-28" },
		]) {
			const record = parseCanonicalRecord(EVENTS, raw);
			// What goes to the server as parameters…
			const at = encodeParameter("timestamp", record.at ?? null, "at");
			const on = encodeParameter("date", record.on ?? null, "on");
			assert.equal(at, record.at);
			assert.equal(on, record.on);
			// …comes back in the form the select expressions produce.
			const row: PostgresRow = {
				id: raw.id,
				at: String(record.at).replace(".000000Z", "").replace("Z", ""),
				on: String(record.on),
			};
			const read = canonicalFromNative(
				EVENTS,
				(column) => row[column],
				"select",
			);
			assert.equal(canonicalEncode(read), canonicalEncode(record), raw.id);
		}
	});

	test("what has no canonical form is still refused on read: BC, five-digit years, another zone", () => {
		for (const [text, source] of [
			["0044-03-15T12:00:00 BC", "select"],
			["0044-03-15 12:00:00+00 BC", "decoded"],
			["10000-01-01T00:00:00", "select"],
			["0001-01-01 02:00:00+02", "decoded"],
			["infinity", "select"],
		] as const) {
			refused(
				() => nativeTextToCanonical("timestamp", text, source, "at"),
				text,
			);
		}
	});

	test("the annex says what the binding does: year 0000 is the server's to refuse, at write", () => {
		const edges = POSTGRES_TYPE_MAPPING.edges;
		assert.ok(Array.isArray(edges));
		for (const type of ["timestamp", "date"]) {
			const edge: JsonValue | undefined = edges.find(
				(entry) => Object(entry).canonical === type,
			);
			const note = String(Object(edge).note);
			assert.match(note, /years 0001-9999/u, type);
			assert.match(note, /year 0000 and refuses it at write/u, type);
			assert.doesNotMatch(note, /0100/u, type);
			assert.equal(Object(edge).write, "constrained");
		}
	});
});

describe("an update of a row with a large key is decoded (it poisoned the subscription for ever)", () => {
	const ITEMS: DatasetSchema = parseDatasetSchema({
		name: "items",
		keyFields: ["id"],
		fields: [
			{ name: "id", type: "string", nullable: false },
			{ name: "qty", type: "int64", nullable: false },
			{ name: "note", type: "string", nullable: true },
		],
	});
	const relation: PgOutputRelation = {
		oid: 1,
		namespace: "app",
		name: "items",
		replicaIdentity: "d",
		columns: [],
	};
	const text = (value: string): PgOutputCell => ({ kind: "text", text: value });
	const UNCHANGED: PgOutputCell = { kind: "unchanged" };
	const NULL: PgOutputCell = { kind: "null" };
	const tuple = (cells: Record<string, PgOutputCell>): PgOutputTuple =>
		new Map(Object.entries(cells));
	const LARGE = "k".repeat(2_500);
	const never = async (): Promise<RecordMutation | undefined> => {
		throw new Error("the store must not be re-read for this change");
	};

	test("a key the update left alone arrives in the old-key image, and is taken from there", async () => {
		// What the server sends for `UPDATE … SET qty = 2` on a row whose key
		// is stored out of line: a placeholder for the key in the new row, the
		// real key in the old-key image, where non-key columns are null.
		const change: PgOutputRowChange = {
			op: "update",
			relation,
			oldImage: "key",
			old: tuple({
				tenant_id: text(""),
				id: text(LARGE),
				qty: NULL,
				note: NULL,
			}),
			row: tuple({
				tenant_id: text(""),
				id: UNCHANGED,
				qty: text("2"),
				note: text("n"),
			}),
		};
		const mutations = await mutationsOf(ITEMS, change, never);
		assert.equal(mutations.length, 1, "an update in place, not a move");
		assert.equal(mutations[0]?.op, "upsert");
		assert.equal(mutations[0]?.key, canonicalEncode([LARGE]));
		assert.deepEqual(mutations[0]?.record, {
			id: LARGE,
			qty: "2",
			note: "n",
		});
	});

	test("an unchanged tenant is completed the same way", async () => {
		const change: PgOutputRowChange = {
			op: "update",
			relation,
			oldImage: "key",
			old: tuple({
				tenant_id: text("tenant-a"),
				id: text("a"),
				qty: NULL,
				note: NULL,
			}),
			row: tuple({
				tenant_id: UNCHANGED,
				id: text("a"),
				qty: text("3"),
				note: NULL,
			}),
		};
		const [mutation] = await mutationsOf(ITEMS, change, never);
		assert.equal(mutation?.tenant, "tenant-a");
		assert.equal(mutation?.key, '["a"]');
	});

	test("a key image completes the key only: an unchanged non-key value is still re-read", async () => {
		let asked: string | undefined;
		const current: RecordMutation = {
			tenant: "",
			key: canonicalEncode([LARGE]),
			op: "upsert",
			record: parseCanonicalRecord(ITEMS, { id: LARGE, qty: 4, note: "big" }),
		};
		const change: PgOutputRowChange = {
			op: "update",
			relation,
			oldImage: "key",
			old: tuple({
				tenant_id: text(""),
				id: text(LARGE),
				qty: NULL,
				note: NULL,
			}),
			row: tuple({
				tenant_id: text(""),
				id: UNCHANGED,
				qty: text("4"),
				note: UNCHANGED,
			}),
		};
		const mutations = await mutationsOf(ITEMS, change, async (tenant, key) => {
			asked = `${tenant}|${key}`;
			return current;
		});
		assert.equal(asked, `|${canonicalEncode([LARGE])}`);
		assert.deepEqual(mutations, [current]);
	});

	test("a full old row completes everything, with no re-read", async () => {
		const change: PgOutputRowChange = {
			op: "update",
			relation,
			oldImage: "full",
			old: tuple({
				tenant_id: text(""),
				id: text(LARGE),
				qty: text("1"),
				note: text("big"),
			}),
			row: tuple({
				tenant_id: text(""),
				id: UNCHANGED,
				qty: text("5"),
				note: UNCHANGED,
			}),
		};
		const [mutation] = await mutationsOf(ITEMS, change, never);
		assert.deepEqual(mutation?.record, { id: LARGE, qty: "5", note: "big" });
	});

	test("a key that really changed is still a move: delete, then upsert", async () => {
		const change: PgOutputRowChange = {
			op: "update",
			relation,
			oldImage: "key",
			old: tuple({
				tenant_id: text(""),
				id: text("old"),
				qty: NULL,
				note: NULL,
			}),
			row: tuple({
				tenant_id: text(""),
				id: text("new"),
				qty: text("1"),
				note: NULL,
			}),
		};
		const mutations = await mutationsOf(ITEMS, change, never);
		assert.deepEqual(
			mutations.map((mutation) => `${mutation.op} ${mutation.key}`),
			['delete ["old"]', 'upsert ["new"]'],
		);
	});
});

describe("the fence cannot be bypassed by a role that merely writes the dataset", () => {
	const statements = bootstrapStatements("app");
	const fence = statements.find((statement) =>
		statement.includes('FUNCTION "app"."hobo_fence_guard"()'),
	);

	test("the trigger runs with its owner's rights and a pinned search path", () => {
		assert.ok(fence !== undefined);
		// With the invoker's rights a writer needed SELECT on the fence table,
		// and could read the token out of it.
		assert.match(fence, /LANGUAGE plpgsql SECURITY DEFINER /u);
		// With the invoker's path a writer could shadow `=` and write through.
		assert.match(fence, /SET search_path = pg_catalog, pg_temp AS \$hobo\$/u);
		// Every relation in the body is named in full.
		assert.ok(fence.includes('FROM "app"."hobo_data_datasets" d'));
		assert.ok(fence.includes('FROM "app"."hobo_data_fences" f'));
		const truncate = statements.find((statement) =>
			statement.includes('FUNCTION "app"."hobo_truncate_guard"()'),
		);
		assert.match(truncate ?? "", /SET search_path = pg_catalog, pg_temp/u);
	});

	test("the metadata tables are the binding's alone, and revoked before the trigger is replaced", () => {
		const revoke = statements.findIndex((statement) =>
			statement.startsWith("REVOKE ALL ON TABLE "),
		);
		assert.ok(revoke > 0);
		const revoked = statements[revoke] ?? "";
		for (const table of [
			"hobo_data_datasets",
			"hobo_data_fences",
			"hobo_data_watermarks",
			"hobo_data_subscriptions",
			"hobo_data_schema_snapshots",
		]) {
			assert.ok(revoked.includes(`"app"."${table}"`), table);
		}
		assert.ok(revoked.endsWith(" FROM PUBLIC"));
		assert.ok(revoke < statements.indexOf(fence ?? ""));
	});

	test("a namespace bootstrapped before the change is bootstrapped again", () => {
		// The marker is what lets a binding skip the DDL; a new one means an
		// existing namespace gets the hardened function and the revoke.
		assert.equal(BOOTSTRAP_MARKER, "hobo-data-postgres bootstrap 2");
		assert.equal(
			statements[statements.length - 1],
			`COMMENT ON FUNCTION ${bootstrapProbe("app")} IS '${BOOTSTRAP_MARKER}'`,
		);
	});
});

describe("a schema snapshot refuses a table it would restore under another owner or outside its publication", () => {
	function scripted(reasons: readonly string[], schemaPublications = "true") {
		const issued: string[] = [];
		const executor: PostgresExecutor = {
			async query(sql) {
				issued.push(sql);
				if (sql.includes("obj_description")) {
					return {
						rows: [{ database: "app", marker: BOOTSTRAP_MARKER }],
						rowCount: 1,
					};
				}
				if (sql.includes("pg_publication_namespace') IS NOT NULL")) {
					return { rows: [{ present: schemaPublications }], rowCount: 1 };
				}
				if (sql.includes("WITH target AS")) {
					return {
						rows: reasons.map((reason) => ({ reason })),
						rowCount: reasons.length,
					};
				}
				if (sql.includes("FROM pg_class c JOIN pg_namespace n")) {
					return { rows: [{ name: "accounts" }], rowCount: 1 };
				}
				return { rows: [], rowCount: 0 };
			},
			transaction: (body) => body(executor),
		};
		return { executor, issued };
	}

	test("the preflight asks who owns the table and whether it is published", async () => {
		for (const [reason, text] of [
			["owner", SCHEMA_SNAPSHOT_REFUSALS.owner],
			["publication", SCHEMA_SNAPSHOT_REFUSALS.publication],
		] as const) {
			const server = scripted([reason]);
			const binding = createPostgresEngine({
				executor: server.executor,
				namespace: "app",
				schemaTables: ["accounts"],
			});
			await assert.rejects(
				async () => requirePort(binding, "schema").snapshot(),
				(cause) => {
					assert.ok(cause instanceof DataCoreError, reason);
					assert.equal(cause.code, "INVALID_MIGRATION_PLAN");
					assert.ok(cause.message.includes(text.split(":")[0] ?? ""), reason);
					return true;
				},
			);
			const preflight = server.issued.find((sql) =>
				sql.includes("WITH target AS"),
			);
			assert.ok(preflight !== undefined);
			assert.match(
				preflight,
				/t\.relowner <> \(SELECT r\.oid FROM pg_roles r WHERE r\.rolname = current_user\)/u,
			);
			// Every way a table can be in a publication: by name, by FOR ALL
			// TABLES, and — on a server that has the catalog — by its schema.
			// Read from the catalogs, not through pg_publication_tables, which
			// fails when another session drops a publication meanwhile.
			assert.match(
				preflight,
				/FROM pg_publication_rel r WHERE r\.prrelid = t\.oid/u,
			);
			assert.match(preflight, /FROM pg_publication p WHERE p\.puballtables/u);
			assert.match(
				preflight,
				/FROM pg_publication_namespace s WHERE s\.pnnspid = t\.relnamespace/u,
			);
			assert.doesNotMatch(preflight, /pg_publication_tables/u);
			// Refused before any table was copied or dropped. (The snapshot's
			// own schema is created in the same transaction, which the
			// refusal rolls back.)
			assert.ok(
				server.issued.every(
					(sql) => !/^(CREATE TABLE|DROP|INSERT|ALTER)/u.test(sql),
				),
			);
		}
		// A server without schema-level publications is not asked about them.
		const older = scripted(["publication"], "false");
		await assert.rejects(async () =>
			requirePort(
				createPostgresEngine({
					executor: older.executor,
					namespace: "app",
					schemaTables: ["accounts"],
				}),
				"schema",
			).snapshot(),
		);
		const olderPreflight = older.issued.find((sql) =>
			sql.includes("WITH target AS"),
		);
		assert.doesNotMatch(olderPreflight ?? "", /pg_publication_namespace/u);
		assert.match(olderPreflight ?? "", /pg_publication_rel/u);
		assert.match(
			SCHEMA_SNAPSHOT_REFUSALS.owner,
			/^POSTGRES_SCHEMA_SNAPSHOT_SAME_OWNER_ONLY: /u,
		);
		assert.match(
			SCHEMA_SNAPSHOT_REFUSALS.publication,
			/^POSTGRES_SCHEMA_SNAPSHOT_NOT_PUBLISHED: /u,
		);
	});
});

describe("an open-schema field named __proto__ is kept (it was dropped on write and on read)", () => {
	const OPEN: DatasetSchema = parseDatasetSchema({
		name: "open_items",
		open: true,
		keyFields: ["id"],
		fields: [{ name: "id", type: "string", nullable: false }],
	});
	const record = parseCanonicalRecord(
		OPEN,
		Object.fromEntries<JsonValue>([
			["id", "a"],
			["__proto__", { nested: [1, "two"] }],
			["constructor", "c"],
			["extra", 5],
		]),
	);

	test("the overflow object carries every undeclared field, as its own property", () => {
		const overflow = openFieldsOf(OPEN, record);
		assert.ok(Object.hasOwn(overflow, "__proto__"));
		assert.deepEqual(Object.keys(overflow).sort(), [
			"__proto__",
			"constructor",
			"extra",
		]);
		assert.equal(Object.getPrototypeOf(overflow), Object.prototype);
		// And it reaches the statement parameter.
		assert.equal(
			encodeParameter("json", overflow, "hobo_extra"),
			'{"__proto__":{"nested":[1,"two"]},"constructor":"c","extra":5}',
		);
	});

	test("a row whose overflow column holds __proto__ reads back with the field", () => {
		const row: PostgresRow = {
			id: "a",
			hobo_extra:
				'{"extra": 5, "__proto__": {"nested": [1, "two"]}, "constructor": "c"}',
		};
		const read = canonicalFromNative(OPEN, (column) => row[column], "select");
		assert.ok(Object.hasOwn(read, "__proto__"));
		assert.equal(canonicalEncode(read), canonicalEncode(record));
	});

	test("an overflow member can never shadow a declared column", () => {
		const row: PostgresRow = { id: "real", hobo_extra: '{"id": "forged"}' };
		const read = canonicalFromNative(OPEN, (column) => row[column], "select");
		assert.equal(read.id, "real");
	});
});

describe("a jsonb number beyond float64 is refused on read (it read back as null)", () => {
	test("1e400 does not parse to a canonical value; a merely over-precise number reads as the nearest float64", () => {
		for (const type of ["json", "encrypted"] satisfies CanonicalType[]) {
			for (const text of [
				'{"n": 1e400}',
				'{"a": [1, {"deep": -1e999}]}',
				"1e400",
			]) {
				const cause = refused(
					() => nativeTextToCanonical(type, text, "select", "attrs"),
					`${type} ${text}`,
				);
				assert.match(cause.message, /beyond float64's range/u);
				refused(
					() => nativeTextToCanonical(type, text, "decoded", "attrs"),
					`${type} ${text} decoded`,
				);
			}
		}
		assert.deepEqual(
			nativeTextToCanonical(
				"json",
				'{"n": 0.1000000000000000000000001, "big": 1e308}',
				"select",
				"attrs",
			),
			{ n: 0.1, big: 1e308 },
		);
	});

	test("the annex says so", () => {
		const edges = POSTGRES_TYPE_MAPPING.edges;
		assert.ok(Array.isArray(edges));
		const note = String(
			Object(edges.find((entry) => Object(entry).canonical === "json")).note,
		);
		assert.match(note, /reads as the nearest float64/u);
		assert.match(note, /beyond float64's range is refused on read/u);
	});
});
