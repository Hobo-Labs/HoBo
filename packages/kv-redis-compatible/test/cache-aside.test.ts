import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	parseEphemeralKey,
	parseEphemeralTtlMs,
	readThroughCache,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createManualClock, createMemoryEphemeralState } from "../src/index.js";
import { isJsonString } from "../src/json.js";

describe("cache-aside reads", () => {
	it("recomputes from durable SQLite data after expiry or eviction", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cache-aside-"));
		const databasePath = join(directory, "source.db");
		let database = new DatabaseSync(databasePath);
		const clock = createManualClock();
		const cache = createMemoryEphemeralState({ now: clock.now });
		const key = parseEphemeralKey("users:1");
		const ttl = parseEphemeralTtlMs(100);
		let reads = 0;
		const load = () => {
			reads++;
			const row = database.prepare("SELECT name FROM users WHERE id = 1").get();
			if (row === undefined) return undefined;
			if (!isJsonString(row.name)) throw new Error("Invalid source value");
			return row.name;
		};
		try {
			database.exec(
				"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
			);
			database.exec("INSERT INTO users VALUES (1, 'Ada')");
			database.close();
			database = new DatabaseSync(databasePath);
			expect(await readThroughCache(cache, key, ttl, load)).toBe("Ada");
			expect(await readThroughCache(cache, key, ttl, load)).toBe("Ada");
			expect(reads).toBe(1);
			database.exec("UPDATE users SET name = 'Grace' WHERE id = 1");
			expect(await readThroughCache(cache, key, ttl, load)).toBe("Ada");
			clock.advance(100);
			expect(await readThroughCache(cache, key, ttl, load)).toBe("Grace");
			expect(reads).toBe(2);
			database.exec("UPDATE users SET name = 'Lin' WHERE id = 1");
			await cache.delete(key);
			expect(await readThroughCache(cache, key, ttl, load)).toBe("Lin");
			expect(reads).toBe(3);
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does not cache missing values or failed source reads", async () => {
		const cache = createMemoryEphemeralState();
		const key = parseEphemeralKey("users:missing");
		const ttl = parseEphemeralTtlMs(100);
		expect(
			await readThroughCache(cache, key, ttl, () => undefined),
		).toBeUndefined();
		await expect(
			readThroughCache(cache, key, ttl, () =>
				Promise.reject(new Error("source unavailable")),
			),
		).rejects.toThrow("source unavailable");
		expect(await readThroughCache(cache, key, ttl, () => "")).toBe("");
		expect(await readThroughCache(cache, key, ttl, () => "not used")).toBe("");
	});

	it("does not overwrite a value another reader cached first", async () => {
		const cache = createMemoryEphemeralState();
		const key = parseEphemeralKey("users:racing");
		const ttl = parseEphemeralTtlMs(1_000);
		let releaseFirst: () => void = () => {
			throw new Error("First load was not initialized");
		};
		let signalFirstLoad: () => void = () => {
			throw new Error("First load was not initialized");
		};
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstLoadStarted = new Promise<void>((resolve) => {
			signalFirstLoad = resolve;
		});
		const first = readThroughCache(cache, key, ttl, async () => {
			signalFirstLoad();
			await gate;
			return "first";
		});
		await firstLoadStarted;
		expect(await readThroughCache(cache, key, ttl, () => "second")).toBe(
			"second",
		);
		releaseFirst();
		expect(await first).toBe("first");
		expect((await cache.get(key))?.value).toBe("second");
	});
});
