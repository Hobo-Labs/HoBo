// The schema-apply port over a real SQLite file: where a snapshot is written,
// and that no SQL handed to a phase or a verify is silently left unrun.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "vitest";
import {
	createSqliteSchemaApplyPort,
	type SqliteSchemaApplyPort,
} from "../src/index.js";
import { NOW, tempDir } from "./support.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A store file holding one table, `t`, with one row. */
function storeFile(): string {
	const { dir, remove } = tempDir("hobo-sqlite-schema-");
	cleanups.push(remove);
	const file = path.join(dir, "store.db");
	const db = new DatabaseSync(file);
	db.exec(
		"CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t (id) VALUES ('1')",
	);
	db.close();
	return file;
}

/** A port as a new process would open it: its own instance, its own state. */
function port(file: string): SqliteSchemaApplyPort {
	const opened = createSqliteSchemaApplyPort({ path: file, clock: () => NOW });
	cleanups.push(() => opened.close());
	return opened;
}

function columns(schema: SqliteSchemaApplyPort): string[] {
	return schema
		.verify("SELECT name FROM pragma_table_info('t') ORDER BY cid")
		.map((row) => String(row.name));
}

describe("schema snapshots", () => {
	test("a re-run after a crash never snapshots over the pre-migration copy", () => {
		const file = storeFile();
		// First run: snapshot, then the migration gets half way and the process
		// dies. The port instance, and anything it counted, goes with it.
		const crashed = createSqliteSchemaApplyPort({ path: file });
		const before = crashed.snapshot();
		crashed.applyPhase("expand", ["ALTER TABLE t ADD COLUMN half_done TEXT"]);
		crashed.close();
		const original = readFileSync(before.ref);
		// The re-run snapshots again, from a new port.
		const rerun = port(file);
		const second = rerun.snapshot();
		assert.notEqual(second.ref, before.ref);
		assert.ok(
			readFileSync(before.ref).equals(original),
			"the pre-migration snapshot is byte for byte what it was",
		);
		// Rolling back to the first snapshot reaches the pre-migration schema.
		rerun.restore(before);
		assert.deepEqual(columns(rerun), ["id"]);
	});

	test("one port's snapshots do not share a ref either", () => {
		const schema = port(storeFile());
		const refs = [schema.snapshot(), schema.snapshot(), schema.snapshot()].map(
			(snapshot) => snapshot.ref,
		);
		assert.equal(new Set(refs).size, 3);
	});
});

describe("schema phases", () => {
	test("every statement of an entry runs, not only its first", () => {
		const schema = port(storeFile());
		const result = schema.applyPhase("expand", [
			"ALTER TABLE t ADD COLUMN a TEXT; ALTER TABLE t ADD COLUMN b TEXT",
		]);
		assert.deepEqual(columns(schema), ["id", "a", "b"]);
		assert.equal(result.statements, 1);
	});

	test("a failure in an entry's later statement rolls the whole phase back", () => {
		const schema = port(storeFile());
		assert.throws(() =>
			schema.applyPhase("expand", [
				"ALTER TABLE t ADD COLUMN a TEXT",
				"ALTER TABLE t ADD COLUMN b TEXT; ALTER TABLE t DROP COLUMN no_such_column",
			]),
		);
		assert.deepEqual(columns(schema), ["id"]);
	});

	test("changes counts the rows a phase touched, and DDL touches none", () => {
		const schema = port(storeFile());
		const backfill = schema.applyPhase("backfill", [
			"INSERT INTO t (id) VALUES ('2'); INSERT INTO t (id) VALUES ('3')",
			"UPDATE t SET id = id || '-x'",
		]);
		assert.equal(backfill.changes, 5);
		// DDL right after DML used to repeat the DML's count.
		const expand = schema.applyPhase("expand", [
			"ALTER TABLE t ADD COLUMN a TEXT",
		]);
		assert.equal(expand.changes, 0);
	});

	test("a verify query with SQL after its first statement is refused", () => {
		const schema = port(storeFile());
		assert.throws(
			() =>
				schema.verify("SELECT id FROM t WHERE id = 'absent'; SELECT id FROM t"),
			{ name: "SqliteDataError", code: "SCHEMA_QUERY_NOT_SINGLE" },
		);
		// A terminator, whitespace and comments after the statement are not SQL.
		assert.deepEqual(
			schema
				.verify("SELECT id FROM t ; -- every row\n /* done */ ;\n")
				.map((row) => row.id),
			["1"],
		);
	});
});
