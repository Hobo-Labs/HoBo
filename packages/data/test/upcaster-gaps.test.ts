import type { EventEnvelope } from "@hobo/core";
import { describe, expect, it, vi } from "vitest";
import {
	createUpcasterRegistry,
	parseUpcasterVersion,
	UpcasterChainError,
	type UpcasterVersion,
} from "../src/index.js";

function event(type: string, version: number, seq = 1): EventEnvelope {
	return {
		id: `event-${seq}`,
		type,
		v: version,
		streamId: "items",
		seq,
		ts: "2026-01-01T00:00:00.000Z",
		actor: { kind: "system", id: "test" },
		tenant: "local",
		data: { value: seq },
	};
}

describe("incomplete upcaster chains", () => {
	it("parses a version with room for the next transition", () => {
		const version: UpcasterVersion = parseUpcasterVersion(3);
		expect(version).toBe(3);
		expect(() => parseUpcasterVersion(Number.MAX_SAFE_INTEGER)).toThrow(
			TypeError,
		);
	});

	it("detects a gap before executing any migration", () => {
		const first = vi.fn((data) => data);
		const registry = createUpcasterRegistry()
			.register("item.Added", 1, first)
			.register("item.Added", 3, (data) => data);
		expect(() => registry.upcast(event("item.Added", 1))).toThrow(
			UpcasterChainError,
		);
		expect(first).not.toHaveBeenCalled();
	});

	it("migrates an event that starts after the gap and accepts a repaired chain", () => {
		const registry = createUpcasterRegistry()
			.register("item.Added", 1, (data) => data)
			.register("item.Added", 3, (data) => data);
		expect(registry.upcast(event("item.Added", 3)).v).toBe(4);
		registry.register("item.Added", 2, (data) => data);
		expect(registry.latestVersion("item.Added")).toBe(4);
		expect(registry.upcast(event("item.Added", 1)).v).toBe(4);
	});
});
