import { expect, it, vi } from "vitest";
import { createInMemoryActorHost } from "../../../runtimes/runtime-local/dist/actor-host/in-memory.js";
import { activateActor, defineActor } from "../../src/actor.js";
import type { ActorHost, FoldEvent } from "../../src/ports.js";

it("reuses local snapshots when an actor is passivated and reactivated", async () => {
	const host = createInMemoryActorHost();
	const fold = vi.fn((state: number, event: FoldEvent) =>
		event.type === "added" ? state + 1 : state,
	);
	const actor = defineActor({
		name: "Counter",
		initialState: () => 0,
		fold,
		handlers: {
			add: (ctx) => {
				ctx.emit({ type: "added" });
			},
		},
	});
	const first = activateActor(host, actor, "one", { holderId: "first" });
	await first.send({ type: "add" });
	first.passivate();
	fold.mockClear();
	const second = activateActor(host, actor, "one", { holderId: "second" });
	expect(second.state()).toBe(1);
	expect(fold).not.toHaveBeenCalled();
	await second.send({ type: "add" });
	expect(second.state()).toBe(2);
	expect(fold).toHaveBeenCalledTimes(1);
	second.passivate();
});

it("keeps passivation compatible with hosts that do not provide snapshots", async () => {
	const local = createInMemoryActorHost();
	const host: ActorHost = {
		acquire: (key, request) => local.acquire(key, request),
		state(key, request) {
			const state = local.state(key, request);
			return {
				append: (lease, event) => state.append(lease, event),
				read: () => state.read(),
			};
		},
	};
	const actor = defineActor({
		name: "Counter",
		initialState: () => 0,
		fold: (state: number, event: FoldEvent) =>
			event.type === "added" ? state + 1 : state,
		handlers: {
			add: (ctx) => {
				ctx.emit({ type: "added" });
			},
		},
	});
	const first = activateActor(host, actor, "one", { holderId: "first" });
	await first.send({ type: "add" });
	first.passivate();
	const second = activateActor(host, actor, "one", { holderId: "second" });
	expect(second.state()).toBe(1);
	second.passivate();
});

it("releases the lease and stops the actor if snapshot folding fails", async () => {
	const host = createInMemoryActorHost();
	let fail = false;
	const actor = defineActor({
		name: "Counter",
		initialState: () => 0,
		fold: (state: number, event: FoldEvent) => {
			if (fail) throw new Error("fold failed");
			return event.type === "added" ? state + 1 : state;
		},
		handlers: {
			add: (ctx) => {
				ctx.emit({ type: "added" });
			},
		},
	});
	const first = activateActor(host, actor, "one", { holderId: "first" });
	await first.send({ type: "add" });
	fail = true;
	expect(() => first.passivate()).toThrow("fold failed");
	await expect(first.send({ type: "add" })).rejects.toThrow(/passivated/);
	const next = host.acquire("Counter/one", { holderId: "second" });
	next.release();
});
