import { SqliteJournal } from "@hobo/storage-sqlite/browser";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { expect, it } from "vitest";
import { createSqliteWasmDriver } from "../src/sqlite-wasm-driver.js";

it("preserves SQLite values and rolls back a transaction", async () => {
	const sqlite = await sqlite3InitModule();
	const driver = createSqliteWasmDriver(new sqlite.oo1.DB(":memory:"));
	try {
		driver.exec(
			"CREATE TABLE sample (id INTEGER PRIMARY KEY, value INTEGER, bytes BLOB)",
		);
		const insert = driver.prepare(
			"INSERT INTO sample (value, bytes) VALUES (?, ?)",
		);
		const inserted = insert.run(
			9_007_199_254_740_993n,
			new Uint8Array([0, 1, 255]),
		);
		expect(inserted.changes).toBe(1);
		expect(inserted.lastInsertRowid).toBe(1);
		expect(driver.prepare("SELECT value, bytes FROM sample").get()).toEqual({
			value: 9_007_199_254_740_993n,
			bytes: new Uint8Array([0, 1, 255]),
		});
		driver.beginImmediate();
		insert.run(2, new Uint8Array());
		driver.rollback();
		expect(driver.prepare("SELECT id FROM sample ORDER BY id").all()).toEqual([
			{ id: 1 },
		]);
	} finally {
		driver.close();
	}
});

it("runs the shared journal on a real SQLite WASM database", async () => {
	const sqlite = await sqlite3InitModule();
	const driver = createSqliteWasmDriver(new sqlite.oo1.DB(":memory:"));
	const journal = new SqliteJournal(driver, {
		nativePragmas: false,
		partitionId: "browser-test",
	});
	try {
		const result = await journal.append(
			"notes:1",
			[{ type: "note.Saved", data: { text: "Hello" } }],
			{ expectedSeq: 0, actor: { kind: "system", id: "test" }, tenant: "t" },
		);
		expect(result.firstPosition).toBe(1n);
		const events = [];
		for await (const event of journal.read("notes:1")) events.push(event);
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toEqual({ text: "Hello" });
		await journal.snapshot("notes:1", { text: "Hello" }, 1);
		expect((await journal.loadSnapshot("notes:1"))?.state).toEqual({
			text: "Hello",
		});
	} finally {
		journal.close();
	}
});
