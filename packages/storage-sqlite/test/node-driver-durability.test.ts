import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createMemoryNodeSqliteDriver,
	createNodeSqliteDriver,
} from "../src/node-driver.js";

describe("native SQLite storage durability", () => {
	it.each([
		":memory:",
		"file::memory:?cache=shared",
		"file:driver-memory?mode=memory&cache=shared",
		"",
	])("rejects volatile database %j as a native persistent driver", (path) => {
		expect(() => {
			const driver = createNodeSqliteDriver({ path });
			driver.close();
		}).toThrow();
	});
	it("keeps the explicit memory driver available", () => {
		const driver = createMemoryNodeSqliteDriver();
		expect(driver.kind).toBe("memory");
		driver.exec("CREATE TABLE sample (value INTEGER)");
		driver.close();
	});
	it("reopens an actual persistent file", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-node-driver-"));
		try {
			const path = join(dir, "journal.sqlite");
			const first = createNodeSqliteDriver({ path });
			expect(first.kind).toBe("node");
			first.exec(
				"CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (42)",
			);
			first.close();
			const second = createNodeSqliteDriver({ path });
			expect(second.prepare("SELECT value FROM sample").get()?.value).toBe(42n);
			second.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
