import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventStore } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	createInMemoryActorHost,
	defineAggregate,
	DurableEffectUnavailableError,
} from "../src/index.js";

const context = {
	tenant: "workspace",
	actor: { kind: "user", id: "operator" } as const,
};
type Command = "write-and-notify" | "notify" | "write" | "invalid-effect";

const aggregate = defineAggregate<{ count: number }, Command>({
	name: "items",
	initialState: { count: 0 },
	evolve: (state) => ({ count: state.count + 1 }),
	decide(_state, command, emitter) {
		if (command !== "notify") emitter.emit("item.Added", {});
		if (command === "invalid-effect")
			emitter.stageEffect({
				kind: "cron",
				scheduleId: "invalid",
				everyMs: 0,
				startAt: "2026-01-01T00:00:00.000Z",
				nextFireAt: "2026-01-01T00:00:00.000Z",
			});
		else if (command !== "write")
			emitter.stageEffect({
				kind: "outbox",
				destination: "notifications",
				idempotencyKey: "item-created",
				payload: { item: "one" },
			});
	},
});

it.each([
	"write-and-notify",
	"notify",
] as const)("refuses %s when the store cannot commit effects", async (command) => {
	const directory = mkdtempSync(
		join(tmpdir(), "hobo-aggregate-effects-basic-"),
	);
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	const eventOnly: EventStore = {
		append: store.append.bind(store),
		read: store.read.bind(store),
		subscribe: store.subscribe.bind(store),
		snapshot: store.snapshot.bind(store),
	};
	const actorHost = createInMemoryActorHost();
	try {
		await expect(
			aggregate.execute(
				{ store: eventOnly, actorHost },
				"items",
				command,
				context,
			),
		).rejects.toBeInstanceOf(DurableEffectUnavailableError);
		const events = [];
		for await (const event of store.read("items")) events.push(event);
		expect(events).toEqual([]);
		const recovered = await aggregate.execute(
			{ store: eventOnly, actorHost },
			"items",
			"write",
			context,
		);
		expect(recovered.seq).toBe(1);
		expect(recovered.effects).toEqual([]);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("returns durable effect receipts and keeps an effect-only command across restart", async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "hobo-aggregate-effects-durable-"),
	);
	let store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		const result = await aggregate.execute(
			{ store, actorHost: createInMemoryActorHost() },
			"items",
			"notify",
			context,
		);
		expect(result.seq).toBe(0);
		expect(result.appended).toEqual([]);
		expect(result.effects).toEqual([
			{
				kind: "outbox",
				id: "outbox:notifications:item-created",
				idempotencyKey: "item-created",
				deduped: false,
			},
		]);
		expect(result.lifecycle.map((fact) => fact.type)).toEqual([
			"actor.Activated",
			"actor.Passivated",
		]);
		store.close();
		store = createRuntimeLocalEventStore({ dataDir: directory });
		const claimed = store.journal().claimOutbox({
			limit: 10,
			leaseId: "consumer",
			leaseFence: 1n,
			visibilityTimeoutMs: 1_000,
		});
		expect(claimed).toHaveLength(1);
		expect(claimed[0]).toMatchObject({
			destination: "notifications",
			idempotencyKey: "item-created",
			payload: { item: "one" },
		});
		const repeated = await aggregate.execute(
			{ store, actorHost: createInMemoryActorHost() },
			"items",
			"notify",
			context,
		);
		expect(repeated.effects[0]).toMatchObject({
			id: "outbox:notifications:item-created",
			deduped: true,
		});
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("commits a command event and its outbox effect together", async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "hobo-aggregate-effects-combined-"),
	);
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		const result = await aggregate.execute(
			{ store, actorHost: createInMemoryActorHost() },
			"items",
			"write-and-notify",
			context,
		);
		expect(result.seq).toBe(1);
		expect(result.state).toEqual({ count: 1 });
		expect(result.appended.map((event) => event.type)).toEqual(["item.Added"]);
		expect(result.effects).toHaveLength(1);
		const claimed = store
			.journal()
			.claimOutbox({
				limit: 10,
				leaseId: "consumer",
				leaseFence: 1n,
				visibilityTimeoutMs: 1_000,
			});
		expect(claimed).toHaveLength(1);
		expect(claimed[0]).toMatchObject({
			destination: "notifications",
			idempotencyKey: "item-created",
		});
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("does not append a command event when its staged effect is invalid", async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "hobo-aggregate-effects-invalid-"),
	);
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await expect(
			aggregate.execute(
				{ store, actorHost: createInMemoryActorHost() },
				"items",
				"invalid-effect",
				context,
			),
		).rejects.toThrow();
		const events = [];
		for await (const event of store.read("items")) events.push(event);
		expect(events).toEqual([]);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
