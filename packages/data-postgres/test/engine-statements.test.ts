// Statement text, identifiers and log positions. Always on: everything here
// is pure, so the exact SQL a dataset produces is pinned without a server.
import assert from "node:assert/strict";
import {
	CapturePositionError,
	DataCoreError,
	parseDatasetSchema,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import { BOOTSTRAP_MARKER, bootstrapProbe } from "../src/engine/statements.js";
import {
	bootstrapStatements,
	captureObjectNames,
	datasetStatements,
	datasetTableDdl,
	FENCE_TOKEN_SETTING,
	FENCED_WRITE_SQLSTATE,
	formatLsn,
	guardStatements,
	PostgresDataError,
	parseLsn,
	parseNamespace,
	quoteIdentifier,
	TRUNCATE_REFUSED_SQLSTATE,
} from "../src/index.js";
import { EVERY_TYPE_SCHEMA } from "./engine-support.js";

const ITEMS = parseDatasetSchema({
	name: "items",
	keyFields: ["region", "seq"],
	fields: [
		{ name: "region", type: "string", nullable: false },
		{ name: "seq", type: "int64", nullable: false },
		{ name: "note", type: "string", nullable: true },
		{ name: "blob", type: "bytes", nullable: true },
	],
});

describe("dataset DDL", () => {
	test("a schema becomes one typed table keyed by tenant plus the key fields", () => {
		assert.equal(
			datasetTableDdl("app", EVERY_TYPE_SCHEMA),
			[
				'CREATE TABLE "app"."hobo_fixture_orders" (',
				'\t"tenant_id" text COLLATE "C" NOT NULL DEFAULT \'\',',
				'\t"id" text COLLATE "C" NOT NULL,',
				'\t"qty" bigint NOT NULL,',
				'\t"price" numeric NOT NULL,',
				'\t"weight" double precision NOT NULL,',
				'\t"active" boolean NOT NULL,',
				'\t"note" text,',
				'\t"blob" bytea NOT NULL,',
				'\t"placed_at" timestamptz NOT NULL,',
				'\t"due" date NOT NULL,',
				'\t"ref" uuid NOT NULL,',
				'\t"attrs" jsonb NOT NULL,',
				'\t"card" jsonb,',
				'\tPRIMARY KEY ("tenant_id", "id")',
				")",
			].join("\n"),
		);
	});

	test("an open schema gets the overflow column; a composite key keeps its order", () => {
		const open = parseDatasetSchema({
			name: "events",
			open: true,
			keyFields: ["seq", "region"],
			fields: [
				{ name: "region", type: "string", nullable: false },
				{ name: "seq", type: "int64", nullable: false },
			],
		});
		const ddl = datasetTableDdl("public", open);
		assert.match(ddl, /"hobo_extra" jsonb NOT NULL DEFAULT '\{\}'::jsonb/u);
		assert.match(ddl, /PRIMARY KEY \("tenant_id", "seq", "region"\)/u);
		// Only key text is pinned to byte order.
		assert.match(ddl, /"region" text COLLATE "C" NOT NULL/u);
	});

	test("a field may not take a column the table needs", () => {
		for (const name of ["tenant_id", "hobo_extra"]) {
			assert.throws(
				() =>
					datasetTableDdl(
						"app",
						parseDatasetSchema({
							name: "clash",
							keyFields: ["id"],
							fields: [
								{ name: "id", type: "string", nullable: false },
								{ name, type: "string", nullable: true },
							],
						}),
					),
				(cause) =>
					cause instanceof DataCoreError &&
					cause.code === "INVALID_DATASET_SCHEMA",
			);
		}
	});

	test("the guard statements put the table behind the fence, in every session mode", () => {
		const guards = guardStatements("app", "items");
		assert.deepEqual(guards, [
			'CREATE OR REPLACE TRIGGER "hobo_fence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."items" FOR EACH ROW EXECUTE FUNCTION "app"."hobo_fence_guard"()',
			'ALTER TABLE "app"."items" ENABLE ALWAYS TRIGGER "hobo_fence_guard"',
			'CREATE OR REPLACE TRIGGER "hobo_truncate_guard" BEFORE TRUNCATE ON "app"."items" FOR EACH STATEMENT EXECUTE FUNCTION "app"."hobo_truncate_guard"()',
			'ALTER TABLE "app"."items" ENABLE ALWAYS TRIGGER "hobo_truncate_guard"',
		]);
	});

	test("the bootstrap creates the metadata and a fence that locks before it looks", () => {
		const statements = bootstrapStatements("app");
		assert.equal(statements[0], 'CREATE SCHEMA IF NOT EXISTS "app"');
		for (const table of [
			"hobo_data_datasets",
			"hobo_data_fences",
			"hobo_data_watermarks",
			"hobo_data_subscriptions",
			"hobo_data_schema_snapshots",
		]) {
			assert.ok(
				statements.some((statement) =>
					statement.startsWith(`CREATE TABLE IF NOT EXISTS "app"."${table}"`),
				),
				table,
			);
		}
		const fence = statements.find((statement) =>
			statement.includes('FUNCTION "app"."hobo_fence_guard"()'),
		);
		assert.ok(fence !== undefined);
		assert.ok(fence.includes(`ERRCODE = '${FENCED_WRITE_SQLSTATE}'`));
		assert.ok(
			fence.includes(`current_setting('${FENCE_TOKEN_SETTING}', true)`),
		);
		// The share lock comes before the fence lookup: that order is what
		// makes raising a fence wait for writers already past the check.
		assert.ok(fence.indexOf("FOR SHARE") < fence.indexOf("SELECT EXISTS"));
		assert.ok(fence.indexOf("FOR SHARE") > 0);
		const truncate = statements.find((statement) =>
			statement.includes('FUNCTION "app"."hobo_truncate_guard"()'),
		);
		assert.ok(truncate?.includes(`ERRCODE = '${TRUNCATE_REFUSED_SQLSTATE}'`));
		// The marker is stamped last, so finding it means everything exists.
		assert.equal(
			statements[statements.length - 1],
			`COMMENT ON FUNCTION "app"."hobo_truncate_guard"() IS '${BOOTSTRAP_MARKER}'`,
		);
		assert.equal(bootstrapProbe("app"), '"app"."hobo_truncate_guard"()');
	});
});

describe("dataset statements", () => {
	const statements = datasetStatements("app", ITEMS);

	test("an upsert casts every parameter and updates only non-key columns", () => {
		assert.equal(
			statements.upsert,
			'INSERT INTO "app"."items" ("tenant_id", "region", "seq", "note", "blob") VALUES ($1::text, $2::text, $3::bigint, $4::text, decode($5::text, \'hex\')) ON CONFLICT ("tenant_id", "region", "seq") DO UPDATE SET "note" = EXCLUDED."note", "blob" = EXCLUDED."blob"',
		);
		const keysOnly = datasetStatements(
			"app",
			parseDatasetSchema({
				name: "tags",
				keyFields: ["id"],
				fields: [{ name: "id", type: "uuid", nullable: false }],
			}),
		);
		assert.ok(
			keysOnly.upsert.endsWith('ON CONFLICT ("tenant_id", "id") DO NOTHING'),
		);
	});

	test("point statements address a record by tenant and key", () => {
		assert.equal(
			statements.remove,
			'DELETE FROM "app"."items" WHERE "tenant_id" = $1::text AND "region" = $2::text AND "seq" = $3::bigint',
		);
		assert.equal(
			statements.readOne,
			'SELECT "tenant_id" AS "tenant_id", "region" AS "region", "seq"::text AS "seq", "note" AS "note", encode("blob", \'hex\') AS "blob" FROM "app"."items" WHERE "tenant_id" = $1::text AND "region" = $2::text AND "seq" = $3::bigint',
		);
	});

	test("a scan pages by the real key columns, never by their text aliases", () => {
		const select =
			'SELECT "tenant_id" AS "tenant_id", "region" AS "region", "seq"::text AS "seq", "note" AS "note", encode("blob", \'hex\') AS "blob" FROM "app"."items" AS r';
		const order = ' ORDER BY r."tenant_id", r."region", r."seq"';
		assert.equal(
			statements.scan(false, false),
			`${select}${order} LIMIT $1::bigint`,
		);
		assert.equal(
			statements.scan(true, false),
			`${select} WHERE r."tenant_id" = $1::text${order} LIMIT $2::bigint`,
		);
		assert.equal(
			statements.scan(false, true),
			`${select} WHERE (r."tenant_id", r."region", r."seq") > ($1::text COLLATE "C", $2::text COLLATE "C", $3::bigint)${order} LIMIT $4::bigint`,
		);
		assert.equal(
			statements.scan(true, true),
			`${select} WHERE r."tenant_id" = $1::text AND (r."tenant_id", r."region", r."seq") > ($2::text COLLATE "C", $3::text COLLATE "C", $4::bigint)${order} LIMIT $5::bigint`,
		);
		assert.equal(statements.removeScope(false), 'DELETE FROM "app"."items"');
		assert.equal(
			statements.removeScope(true),
			'DELETE FROM "app"."items" WHERE "tenant_id" = $1::text',
		);
	});

	test("an open schema selects and writes its overflow column", () => {
		const open = datasetStatements(
			"app",
			parseDatasetSchema({
				name: "events",
				open: true,
				keyFields: ["id"],
				fields: [{ name: "id", type: "string", nullable: false }],
			}),
		);
		assert.ok(
			open.upsert.includes(
				'"hobo_extra") VALUES ($1::text, $2::text, $3::jsonb)',
			),
		);
		assert.ok(
			open.upsert.endsWith(
				'DO UPDATE SET "hobo_extra" = EXCLUDED."hobo_extra"',
			),
		);
		assert.ok(open.readOne.includes('"hobo_extra"::text AS "hobo_extra"'));
	});
});

describe("identifiers", () => {
	test("identifiers are quoted, and a quote inside one is doubled", () => {
		assert.equal(quoteIdentifier("order"), '"order"');
		assert.equal(quoteIdentifier('a"b'), '"a""b"');
	});

	test("a namespace is a portable identifier and never a system schema", () => {
		assert.equal(parseNamespace("tenant_42"), "tenant_42");
		for (const bad of [
			"",
			"Public",
			"9lives",
			"a-b",
			"pg_catalog",
			"x".repeat(64),
			'a"b',
		]) {
			assert.throws(
				() => parseNamespace(bad),
				(cause) =>
					cause instanceof PostgresDataError &&
					cause.code === "ENGINE_OPTIONS_INVALID",
				bad,
			);
		}
	});

	test("slot and publication names are valid, stable, and unique per binding", () => {
		const valid = /^[a-z0-9_]{1,63}$/u;
		const awkward = [
			"sub_a",
			"hobo_migration_zero-loss_forward",
			"hobo_migration_resume-fence-and-flip_reverse",
			"UPPER case, spaces & ünïcödé",
			"x".repeat(500),
			"",
		];
		const seen = new Set<string>();
		for (const subscription of awkward) {
			for (const [database, namespace] of [
				["app", "public"],
				["app", "other"],
				["other", "public"],
			] as const) {
				const names = captureObjectNames(database, namespace, subscription);
				assert.match(names.slot, valid);
				assert.match(names.publication, valid);
				assert.ok(names.slot.startsWith("hobo_s_"));
				assert.ok(names.publication.startsWith("hobo_p_"));
				assert.deepEqual(
					names,
					captureObjectNames(database, namespace, subscription),
				);
				seen.add(names.slot);
				seen.add(names.publication);
			}
		}
		assert.equal(seen.size, awkward.length * 3 * 2, "no two collide");
		// Every slot one namespace owns shares a prefix an operator can list.
		assert.equal(
			captureObjectNames("app", "public", "a").slot.slice(0, 19),
			captureObjectNames("app", "public", "b").slot.slice(0, 19),
		);
	});
});

describe("log positions", () => {
	test("a position parses to an integer, so order is numeric not textual", () => {
		assert.equal(parseLsn("0/0"), 0n);
		assert.equal(parseLsn("16/B374D848"), 0x16_b374_d848n);
		assert.equal(parseLsn("ffffffff/FFFFFFFF"), 0xffff_ffff_ffff_ffffn);
		// As text "9/0" sorts after "10/0"; as positions it comes first.
		assert.ok(parseLsn("9/0") < parseLsn("10/0"));
		assert.ok(parseLsn("0/9") < parseLsn("0/10"));
		for (const text of ["0/0", "16/B374D848", "1/1", "FFFFFFFF/FFFFFFFF"]) {
			assert.equal(formatLsn(parseLsn(text)), text);
		}
		assert.equal(formatLsn(parseLsn("0/0000abcd")), "0/ABCD");
	});

	test("a position minted by another engine is refused", () => {
		for (const text of [
			"",
			"41",
			"offline-copy",
			"1/2/3",
			"g/0",
			"0/123456789",
			" 0/0",
		]) {
			assert.throws(
				() => parseLsn(text),
				(cause) =>
					cause instanceof CapturePositionError &&
					cause.code === "CAPTURE_POSITION_INVALID",
				text,
			);
		}
	});
});
