import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	createTaggedCache,
	type EphemeralKey,
	type EphemeralStatePort,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createManualClock, createMemoryEphemeralState } from "../src/index.js";
import { isJsonString } from "../src/json.js";

const ttl = parseEphemeralTtlMs(1000);
const user = parseEphemeralKey("user:1");

describe("tagged cache", () => {
	it("reloads durable SQLite records after invalidation, expiration, and eviction", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-tagged-cache-"));
		const path = join(directory, "source.db");
		let database = new DatabaseSync(path);
		const clock = createManualClock();
		const state = createMemoryEphemeralState({ now: clock.now });
		const cache = createTaggedCache(state, "shop");
		const other = createTaggedCache(state, "other");
		let reads = 0;
		const load = () => {
			reads++;
			const row = database.prepare("SELECT name FROM users WHERE id = 1").get();
			if (!row || !isJsonString(row.name)) return undefined;
			return row.name;
		};
		try {
			database.exec(
				"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
			);
			database.exec("INSERT INTO users VALUES (1, 'Ada')");
			database.close();
			database = new DatabaseSync(path);
			expect(await cache.readThrough(user, ttl, ["users"], load)).toEqual({
				hit: false,
				value: "Ada",
			});
			expect(await cache.readThrough(user, ttl, ["users"], load)).toEqual({
				hit: true,
				value: "Ada",
			});
			await cache.put(parseEphemeralKey("product:1"), "Book", ttl, [
				"products",
			]);
			await other.put(user, "Other", ttl, ["users"]);
			database.exec("UPDATE users SET name = 'Grace' WHERE id = 1");
			await cache.invalidate("users");
			expect(await cache.readThrough(user, ttl, ["users"], load)).toEqual({
				hit: false,
				value: "Grace",
			});
			expect(await cache.get(parseEphemeralKey("product:1"))).toBe("Book");
			expect(await other.get(user)).toBe("Other");
			database.exec("UPDATE users SET name = 'Lin' WHERE id = 1");
			clock.advance(1000);
			expect(await cache.readThrough(user, ttl, ["users"], load)).toEqual({
				hit: false,
				value: "Lin",
			});
			database.exec("UPDATE users SET name = 'Sam' WHERE id = 1");
			await cache.delete(user);
			expect(await cache.readThrough(user, ttl, ["users"], load)).toEqual({
				hit: false,
				value: "Sam",
			});
			expect(reads).toBe(4);
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("never resurrects an invalidated entry when tag metadata is evicted", async () => {
		const state = createMemoryEphemeralState();
		const epochKeys: EphemeralKey[] = [];
		const recording: EphemeralStatePort = {
			...state,
			async putIfAbsent(key, value, duration) {
				if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(value)) epochKeys.push(key);
				return state.putIfAbsent(key, value, duration);
			},
		};
		const cache = createTaggedCache(recording, "shop");
		await cache.put(user, "stale", ttl, ["users"]);
		await cache.invalidate("users");
		const epochKey = epochKeys[0];
		if (!epochKey) throw new Error("expected a tag epoch");
		await state.delete(epochKey);
		expect(await cache.get(user)).toBeUndefined();
		await cache.invalidate("users");
		expect(await cache.get(user)).toBeUndefined();
	});

	it("does not cache a stale load across a concurrent invalidation", async () => {
		const cache = createTaggedCache(createMemoryEphemeralState(), "shop");
		let release = () => {
			throw new Error("load was not started");
		};
		let started = () => {
			throw new Error("load was not started");
		};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const loading = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = cache.readThrough(user, ttl, ["users"], async () => {
			started();
			await gate;
			return "old";
		});
		await loading;
		await cache.invalidate("users");
		release();
		expect(await pending).toEqual({ hit: false, value: "old" });
		expect(await cache.readThrough(user, ttl, ["users"], () => "new")).toEqual({
			hit: false,
			value: "new",
		});
		expect(
			await cache.readThrough(user, ttl, ["users"], () => "unused"),
		).toEqual({ hit: true, value: "new" });
	});

	it("preserves the first completed load and reloads when requested tags change", async () => {
		const cache = createTaggedCache(createMemoryEphemeralState(), "shop");
		let release = () => {
			throw new Error("load was not started");
		};
		let started = () => {
			throw new Error("load was not started");
		};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const loading = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = cache.readThrough(user, ttl, ["users"], async () => {
			started();
			await gate;
			return "first";
		});
		await loading;
		expect(
			await cache.readThrough(user, ttl, ["users"], () => "second"),
		).toEqual({ hit: false, value: "second" });
		release();
		expect(await pending).toEqual({ hit: false, value: "first" });
		expect(await cache.get(user)).toBe("second");
		expect(
			await cache.readThrough(user, ttl, ["accounts"], () => "third"),
		).toEqual({ hit: false, value: "third" });
		await cache.invalidate("accounts");
		expect(await cache.get(user)).toBeUndefined();
	});

	it("supports empty values and arbitrary tag names without caching absent results", async () => {
		const cache = createTaggedCache(createMemoryEphemeralState(), "shop");
		expect(
			await cache.readThrough(user, ttl, ["__proto__"], () => undefined),
		).toEqual({ hit: false });
		expect(
			await cache.readThrough(user, ttl, ["__proto__", "__proto__"], () => ""),
		).toEqual({ hit: false, value: "" });
		expect(
			await cache.readThrough(user, ttl, ["__proto__"], () => "unused"),
		).toEqual({ hit: true, value: "" });
		await cache.invalidate("__proto__");
		expect(await cache.get(user)).toBeUndefined();
	});
});
