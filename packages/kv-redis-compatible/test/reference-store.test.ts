import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import {
	createReferenceRedisStore,
	createTimelessReferenceStore,
} from "../src/reference-store.js";

const store = (options: JsonObject = {}) =>
	createReferenceRedisStore(options as never);

const run = (s: ReturnType<typeof store>, ...command: string[]) =>
	s.execute(command as never);

describe("connection commands", () => {
	it("answers PING with PONG", async () => {
		expect(await run(store(), "PING")).toMatchObject({ value: "PONG" });
	});

	it("echoes its argument", async () => {
		expect(await run(store(), "ECHO", "hi")).toMatchObject({ value: "hi" });
	});

	it("rejects ECHO with no argument", async () => {
		expect(await run(store(), "ECHO")).toMatchObject({ kind: "error" });
	});

	it("matches the verb case-insensitively, as Redis does", async () => {
		expect(await run(store(), "ping")).toMatchObject({ value: "PONG" });
	});

	it("reports an unknown command by name", async () => {
		const reply = await run(store(), "FLUSHALL");
		expect(reply).toMatchObject({ kind: "error" });
		expect(JSON.stringify(reply)).toContain("FLUSHALL");
	});

	it("records every command it was given", async () => {
		const s = store();
		await run(s, "PING");
		await run(s, "GET", "k");
		expect(s.commands).toHaveLength(2);
	});
});

describe("SET and GET", () => {
	it("round-trips a value", async () => {
		const s = store();
		await run(s, "SET", "k", "v");
		expect(await run(s, "GET", "k")).toMatchObject({ value: "v" });
	});

	it("returns nil for a missing key", async () => {
		expect(await run(store(), "GET", "absent")).toMatchObject({ value: null });
	});

	it("rejects SET with no value", async () => {
		expect(await run(store(), "SET", "k")).toMatchObject({ kind: "error" });
	});

	it("overwrites an existing value", async () => {
		const s = store();
		await run(s, "SET", "k", "a");
		await run(s, "SET", "k", "b");
		expect(await run(s, "GET", "k")).toMatchObject({ value: "b" });
	});

	it("enforces a maximum value size when configured", async () => {
		const s = store({ maxValueBytes: 4 });
		expect(await run(s, "SET", "k", "toolong")).toMatchObject({
			kind: "error",
		});
	});

	it("measures the size in bytes rather than characters", async () => {
		const s = store({ maxValueBytes: 3 });
		expect(await run(s, "SET", "k", "€")).toMatchObject({ kind: "value" });
		expect(await run(s, "SET", "k", "€€")).toMatchObject({ kind: "error" });
	});

	it("rejects an unknown SET flag rather than ignoring it", async () => {
		const reply = await run(store(), "SET", "k", "v", "KEEPTTL");
		expect(reply).toMatchObject({ kind: "error" });
	});
});

describe("SET NX", () => {
	it("sets a key that does not exist", async () => {
		expect(await run(store(), "SET", "k", "v", "NX")).toMatchObject({
			kind: "value",
		});
	});

	it("refuses a key that already exists", async () => {
		const s = store();
		await run(s, "SET", "k", "a");
		expect(await run(s, "SET", "k", "b", "NX")).toMatchObject({ value: null });
	});

	it("leaves the existing value untouched when it refuses", async () => {
		const s = store();
		await run(s, "SET", "k", "a");
		await run(s, "SET", "k", "b", "NX");
		expect(await run(s, "GET", "k")).toMatchObject({ value: "a" });
	});

	it("succeeds once the existing key has expired", async () => {
		const s = store();
		await run(s, "SET", "k", "a", "EX", "1");
		await s.advanceTime(2000);
		expect(await run(s, "SET", "k", "b", "NX")).toMatchObject({
			kind: "value",
		});
	});
});

describe("expiry", () => {
	it("keeps a key inside its EX window", async () => {
		const s = store();
		await run(s, "SET", "k", "v", "EX", "10");
		await s.advanceTime(5000);
		expect(await run(s, "GET", "k")).toMatchObject({ value: "v" });
	});

	it("drops a key past its EX window", async () => {
		const s = store();
		await run(s, "SET", "k", "v", "EX", "1");
		await s.advanceTime(1500);
		expect(await run(s, "GET", "k")).toMatchObject({ value: null });
	});

	it("treats PX as milliseconds", async () => {
		const s = store();
		await run(s, "SET", "k", "v", "PX", "100");
		await s.advanceTime(150);
		expect(await run(s, "GET", "k")).toMatchObject({ value: null });
	});

	it("expires exactly at the boundary", async () => {
		const s = store();
		await run(s, "SET", "k", "v", "PX", "100");
		await s.advanceTime(100);
		expect(await run(s, "GET", "k")).toMatchObject({ value: null });
	});

	it("rejects a non-numeric expire time", async () => {
		expect(await run(store(), "SET", "k", "v", "EX", "soon")).toMatchObject({
			kind: "error",
		});
	});

	it("rejects a missing expire time", async () => {
		expect(await run(store(), "SET", "k", "v", "EX")).toMatchObject({
			kind: "error",
		});
	});

	it("reports EXISTS as 0 after expiry", async () => {
		const s = store();
		await run(s, "SET", "k", "v", "EX", "1");
		await s.advanceTime(2000);
		expect(await run(s, "EXISTS", "k")).toMatchObject({ value: 0 });
	});
});

describe("TTL", () => {
	it("reports -2 for a key that does not exist", async () => {
		expect(await run(store(), "TTL", "absent")).toMatchObject({ value: -2 });
	});

	it("reports -1 for a key with no expiry", async () => {
		const s = store();
		await run(s, "SET", "k", "v");
		expect(await run(s, "TTL", "k")).toMatchObject({ value: -1 });
	});

	it("reports the remaining seconds", async () => {
		const s = store();
		await run(s, "SET", "k", "v", "EX", "10");
		await s.advanceTime(3000);
		expect(await run(s, "TTL", "k")).toMatchObject({ value: 7 });
	});

	it("rounds a partial second up, so a live key never reports 0", async () => {
		const s = store();
		await run(s, "SET", "k", "v", "PX", "1500");
		await s.advanceTime(1000);
		expect(await run(s, "TTL", "k")).toMatchObject({ value: 1 });
	});

	it("reports -2 once expired", async () => {
		const s = store();
		await run(s, "SET", "k", "v", "EX", "1");
		await s.advanceTime(2000);
		expect(await run(s, "TTL", "k")).toMatchObject({ value: -2 });
	});
});

describe("PERSIST", () => {
	it("removes an expiry and reports 1", async () => {
		const s = store();
		await run(s, "SET", "k", "v", "EX", "1");
		expect(await run(s, "PERSIST", "k")).toMatchObject({ value: 1 });
		await s.advanceTime(5000);
		expect(await run(s, "GET", "k")).toMatchObject({ value: "v" });
	});

	it("reports 0 for a key with no expiry", async () => {
		const s = store();
		await run(s, "SET", "k", "v");
		expect(await run(s, "PERSIST", "k")).toMatchObject({ value: 0 });
	});

	it("reports 0 for a key that does not exist", async () => {
		expect(await run(store(), "PERSIST", "absent")).toMatchObject({ value: 0 });
	});
});

describe("DEL and TYPE", () => {
	it("reports 1 when it deleted something", async () => {
		const s = store();
		await run(s, "SET", "k", "v");
		expect(await run(s, "DEL", "k")).toMatchObject({ value: 1 });
	});

	it("reports 0 for a key that was not there", async () => {
		expect(await run(store(), "DEL", "absent")).toMatchObject({ value: 0 });
	});

	it("reports 0 for an already-expired key", async () => {
		const s = store();
		await run(s, "SET", "k", "v", "EX", "1");
		await s.advanceTime(2000);
		expect(await run(s, "DEL", "k")).toMatchObject({ value: 0 });
	});

	it("reports none for a missing key's type", async () => {
		expect(await run(store(), "TYPE", "absent")).toMatchObject({
			value: "none",
		});
	});

	it.each([
		[["SET", "k", "v"], "string"],
		[["RPUSH", "k", "a"], "list"],
		[["HSET", "k", "f", "v"], "hash"],
		[["ZADD", "k", "1", "m"], "zset"],
	])("reports the type after %s", async (setup, type) => {
		const s = store();
		await run(s, ...(setup as string[]));
		expect(await run(s, "TYPE", "k")).toMatchObject({ value: type });
	});
});

describe("INCR and INCRBY", () => {
	it("starts an absent counter at the increment", async () => {
		expect(await run(store(), "INCR", "c")).toMatchObject({ value: 1 });
	});

	it("increments an existing counter", async () => {
		const s = store();
		await run(s, "INCR", "c");
		expect(await run(s, "INCR", "c")).toMatchObject({ value: 2 });
	});

	it("increments by an arbitrary amount", async () => {
		expect(await run(store(), "INCRBY", "c", "5")).toMatchObject({ value: 5 });
	});

	it("decrements with a negative amount", async () => {
		const s = store();
		await run(s, "INCRBY", "c", "10");
		expect(await run(s, "INCRBY", "c", "-3")).toMatchObject({ value: 7 });
	});

	it("refuses to increment a non-numeric string", async () => {
		const s = store();
		await run(s, "SET", "c", "abc");
		expect(await run(s, "INCR", "c")).toMatchObject({ kind: "error" });
	});

	it("refuses to increment a list", async () => {
		const s = store();
		await run(s, "RPUSH", "k", "a");
		expect(await run(s, "INCR", "k")).toMatchObject({ kind: "error" });
	});

	it("rejects a non-integer increment", async () => {
		expect(await run(store(), "INCRBY", "c", "1.5")).toMatchObject({
			kind: "error",
		});
	});
});

describe("lists", () => {
	it("pushes and reports the new length", async () => {
		const s = store();
		expect(await run(s, "RPUSH", "l", "a", "b")).toMatchObject({ value: 2 });
	});

	it("appends to an existing list", async () => {
		const s = store();
		await run(s, "RPUSH", "l", "a");
		expect(await run(s, "RPUSH", "l", "b")).toMatchObject({ value: 2 });
	});

	it("pops from the head", async () => {
		const s = store();
		await run(s, "RPUSH", "l", "a", "b");
		expect(await run(s, "LPOP", "l")).toMatchObject({ value: "a" });
	});

	it("returns nil popping an empty list", async () => {
		const s = store();
		await run(s, "RPUSH", "l", "a");
		await run(s, "LPOP", "l");
		expect(await run(s, "LPOP", "l")).toMatchObject({ value: null });
	});

	it("returns nil popping a missing key", async () => {
		expect(await run(store(), "LPOP", "absent")).toMatchObject({ value: null });
	});

	it("reports zero length for a missing key", async () => {
		expect(await run(store(), "LLEN", "absent")).toMatchObject({ value: 0 });
	});

	it("returns the whole list for 0 to -1", async () => {
		const s = store();
		await run(s, "RPUSH", "l", "a", "b", "c");
		expect(await run(s, "LRANGE", "l", "0", "-1")).toMatchObject({
			value: ["a", "b", "c"],
		});
	});

	it("returns a bounded slice", async () => {
		const s = store();
		await run(s, "RPUSH", "l", "a", "b", "c");
		expect(await run(s, "LRANGE", "l", "1", "1")).toMatchObject({
			value: ["b"],
		});
	});

	it("returns an empty array for a missing key rather than nil", async () => {
		expect(await run(store(), "LRANGE", "absent", "0", "-1")).toMatchObject({
			value: [],
		});
	});

	it("defaults to the whole list when no range is given", async () => {
		const s = store();
		await run(s, "RPUSH", "l", "a", "b");
		expect(await run(s, "LRANGE", "l")).toMatchObject({ value: ["a", "b"] });
	});
});

describe("WRONGTYPE", () => {
	it.each([
		["GET", ["GET", "k"]],
		["LPOP", ["LPOP", "k"]],
		["LLEN", ["LLEN", "k"]],
		["LRANGE", ["LRANGE", "k", "0", "-1"]],
	])("refuses %s against the wrong type", async (_label, command) => {
		const s = store();
		await run(s, "HSET", "k", "f", "v");
		expect(await run(s, ...(command as string[]))).toMatchObject({
			kind: "error",
		});
	});

	it("refuses RPUSH against a string", async () => {
		const s = store();
		await run(s, "SET", "k", "v");
		expect(await run(s, "RPUSH", "k", "a")).toMatchObject({ kind: "error" });
	});

	it("refuses HGET against a list", async () => {
		const s = store();
		await run(s, "RPUSH", "k", "a");
		expect(await run(s, "HGET", "k", "f")).toMatchObject({ kind: "error" });
	});

	it("refuses ZSCORE against a hash", async () => {
		const s = store();
		await run(s, "HSET", "k", "f", "v");
		expect(await run(s, "ZSCORE", "k", "m")).toMatchObject({ kind: "error" });
	});
});

describe("hashes", () => {
	it("reports 1 for a new field and 0 for an update", async () => {
		const s = store();
		expect(await run(s, "HSET", "h", "f", "1")).toMatchObject({ value: 1 });
		expect(await run(s, "HSET", "h", "f", "2")).toMatchObject({ value: 0 });
	});

	it("reads back the latest value", async () => {
		const s = store();
		await run(s, "HSET", "h", "f", "1");
		await run(s, "HSET", "h", "f", "2");
		expect(await run(s, "HGET", "h", "f")).toMatchObject({ value: "2" });
	});

	it("returns nil for a missing field", async () => {
		const s = store();
		await run(s, "HSET", "h", "f", "1");
		expect(await run(s, "HGET", "h", "other")).toMatchObject({ value: null });
	});

	it("returns nil for a missing key", async () => {
		expect(await run(store(), "HGET", "absent", "f")).toMatchObject({
			value: null,
		});
	});

	it("rejects HSET with no value", async () => {
		expect(await run(store(), "HSET", "h", "f")).toMatchObject({
			kind: "error",
		});
	});
});

describe("sorted sets", () => {
	it("reports 1 for a new member and 0 for a rescore", async () => {
		const s = store();
		expect(await run(s, "ZADD", "z", "1", "m")).toMatchObject({ value: 1 });
		expect(await run(s, "ZADD", "z", "2", "m")).toMatchObject({ value: 0 });
	});

	it("orders members by score", async () => {
		const s = store();
		await run(s, "ZADD", "z", "3", "c");
		await run(s, "ZADD", "z", "1", "a");
		await run(s, "ZADD", "z", "2", "b");
		expect(await run(s, "ZRANGE", "z", "0", "-1")).toMatchObject({
			value: ["a", "b", "c"],
		});
	});

	it("breaks a score tie lexically, so the order is deterministic", async () => {
		const s = store();
		await run(s, "ZADD", "z", "1", "b");
		await run(s, "ZADD", "z", "1", "a");
		expect(await run(s, "ZRANGE", "z", "0", "-1")).toMatchObject({
			value: ["a", "b"],
		});
	});

	it("reflects a rescore in the ordering", async () => {
		const s = store();
		await run(s, "ZADD", "z", "1", "a");
		await run(s, "ZADD", "z", "2", "b");
		await run(s, "ZADD", "z", "3", "a");
		expect(await run(s, "ZRANGE", "z", "0", "-1")).toMatchObject({
			value: ["b", "a"],
		});
	});

	it("reads a member's score back as a string", async () => {
		const s = store();
		await run(s, "ZADD", "z", "1.5", "m");
		expect(await run(s, "ZSCORE", "z", "m")).toMatchObject({ value: "1.5" });
	});

	it("returns nil for a missing member", async () => {
		const s = store();
		await run(s, "ZADD", "z", "1", "m");
		expect(await run(s, "ZSCORE", "z", "other")).toMatchObject({ value: null });
	});

	it("returns an empty range for a missing key", async () => {
		expect(await run(store(), "ZRANGE", "absent", "0", "-1")).toMatchObject({
			value: [],
		});
	});
});

describe("the deliberate-break option", () => {
	it("fails only the named verb", async () => {
		const s = store({ breakVerb: "GET" });
		expect(await run(s, "SET", "k", "v")).toMatchObject({ kind: "value" });
		expect(await run(s, "GET", "k")).toMatchObject({ kind: "error" });
	});

	it("matches the verb case-insensitively", async () => {
		const s = store({ breakVerb: "get" });
		expect(await run(s, "GET", "k")).toMatchObject({ kind: "error" });
	});
});

describe("the timeless store", () => {
	it("executes commands", async () => {
		const s = createTimelessReferenceStore();
		expect(await s.execute(["PING"] as never)).toMatchObject({
			value: "PONG",
		});
	});

	it("exposes no time control, which is the point", () => {
		expect(createTimelessReferenceStore()).not.toHaveProperty("advanceTime");
	});
});
