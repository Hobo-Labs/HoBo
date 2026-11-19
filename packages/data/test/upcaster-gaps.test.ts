import type { EventEnvelope } from "@hobo/core";
import { describe, expect, it, vi } from "vitest";
import {
	createInMemoryActorHost,
	createUpcasterRegistry,
	defineAggregate,
	foldEvents,
	parseUpcasterVersion,
	UpcasterChainError,
	type UpcasterVersion,
} from "../src/index.js";
import { freshStore } from "./helpers.js";

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

	it("rejects a fold before evolving state instead of quarantining a valid event", () => {
		const registry = createUpcasterRegistry()
			.register("item.Added", 1, (data) => data)
			.register("item.Added", 3, (data) => data);
		const evolve = vi.fn((state: number) => state + 1);
		expect(() =>
			foldEvents([event("other.Added", 1, 1), event("item.Added", 1, 2)], {
				initialState: 0,
				evolve,
				upcasters: registry,
			}),
		).toThrow(UpcasterChainError);
		expect(evolve).not.toHaveBeenCalled();
	});

	it("does not require a migration for an event already quarantined", () => {
		const registry = createUpcasterRegistry()
			.register("item.Added", 1, (data) => data)
			.register("item.Added", 3, (data) => data);
		const quarantined = {
			...event("item.Quarantined", 1, 2),
			data: { offendingSeq: 1 },
		};
		const result = foldEvents([event("item.Added", 1), quarantined], {
			initialState: 0,
			evolve: (state) => state + 1,
			upcasters: registry,
		});
		expect(result.state).toBe(0);
		expect(result.quarantined).toEqual([]);
	});

	it("rejects an aggregate command before appending an unmigratable event", async () => {
		const store = freshStore();
		try {
			const upcasters = createUpcasterRegistry()
				.register("item.Added", 1, (data) => data)
				.register("item.Added", 3, (data) => data);
			const aggregate = defineAggregate<number, number>({
				name: "item",
				initialState: 0,
				evolve: (state) => state + 1,
				decide: (_state, value, emit) => emit.emit("item.Added", { value }),
				upcasters,
			});
			await expect(
				aggregate.execute(
					{ store, actorHost: createInMemoryActorHost() },
					"item:1",
					1,
					{ tenant: "local", actor: { kind: "system", id: "test" } },
				),
			).rejects.toThrow(UpcasterChainError);
			const events: EventEnvelope[] = [];
			for await (const item of store.read("item:1")) events.push(item);
			expect(events).toEqual([]);
		} finally {
			store.close();
		}
	});
});
