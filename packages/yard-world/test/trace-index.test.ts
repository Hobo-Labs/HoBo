import { describe, expect, it } from "vitest";
import {
	TRACE_INDEX_MAX_ENTRIES,
	TRACE_INDEX_TTL_MS,
	TraceIndex,
} from "../src/trace-index.js";

function entry(traceId: string, spanId: string, campId = "camp-a") {
	return {
		traceId,
		spanId,
		parentSpanId: undefined,
		kind: "client" as const,
		characterId: "s1/svc",
		campId,
		startMs: 0,
		endMs: 0,
	};
}

describe("TraceIndex", () => {
	it("records and looks up spans by traceId+spanId", () => {
		const index = new TraceIndex();
		index.record(entry("t1", "s1"), 1000);
		expect(index.lookup("t1", "s1", 1000)?.campId).toBe("camp-a");
		expect(index.size).toBe(1);
	});

	it("span ids are scoped by trace id", () => {
		const index = new TraceIndex();
		index.record(entry("t1", "same", "camp-a"), 1000);
		expect(index.lookup("t2", "same", 1000)).toBeUndefined();
		index.record(entry("t2", "same", "camp-b"), 1000);
		expect(index.lookup("t2", "same", 1000)?.campId).toBe("camp-b");
		expect(index.lookup("t1", "same", 1000)?.campId).toBe("camp-a");
	});

	it("expires entries past the TTL on lookup", () => {
		const index = new TraceIndex(10_000, 1_000);
		index.record(entry("t1", "s1"), 1_000);
		expect(index.lookup("t1", "s1", 1_999)).toBeDefined();
		expect(index.lookup("t1", "s1", 2_500)).toBeUndefined();
		expect(index.size).toBe(0);
	});

	it("evicts expired entries on record", () => {
		const index = new TraceIndex(10_000, 1_000);
		index.record(entry("t1", "s1"), 1_000);
		index.record(entry("t2", "s2"), 5_000);
		expect(index.size).toBe(1);
		expect(index.lookup("t2", "s2", 5_000)).toBeDefined();
	});

	it("trims to max entries, dropping the oldest first", () => {
		const index = new TraceIndex(3, TRACE_INDEX_TTL_MS);
		for (let i = 0; i < 5; i += 1) index.record(entry("t", `s${i}`), i);
		expect(index.size).toBe(3);
		expect(index.lookup("t", "s0", 5)).toBeUndefined();
		expect(index.lookup("t", "s1", 5)).toBeUndefined();
		expect(index.lookup("t", "s4", 5)).toBeDefined();
	});

	it("re-recording a span refreshes its recency", () => {
		const index = new TraceIndex(2, TRACE_INDEX_TTL_MS);
		index.record(entry("t", "s1"), 0);
		index.record(entry("t", "s2"), 1);
		index.record(entry("t", "s1", "camp-c"), 2); // refresh s1
		index.record(entry("t", "s3"), 3); // evicts s2, not s1
		expect(index.lookup("t", "s1", 3)?.campId).toBe("camp-c");
		expect(index.lookup("t", "s2", 3)).toBeUndefined();
	});

	it("default bounds are 10k entries / 15 minutes", () => {
		expect(TRACE_INDEX_MAX_ENTRIES).toBe(10_000);
		expect(TRACE_INDEX_TTL_MS).toBe(15 * 60_000);
	});
});
