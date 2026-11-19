import {
	type EventEnvelope,
	type EventStore,
	parseRunId,
	type RunId,
	type Streamer,
	type StreamName,
} from "@hobo/core";
import { createInMemoryActorHost, defineAggregate } from "@hobo/data";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { createLocalStreamer } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	CommandObservationError,
	createReactor,
	defineMaterialization,
	type MaterializedFrame,
} from "../src/index.js";
import { CTX, freshStore } from "./helpers.js";

interface OrderRow {
	orderId: string;
	totalCents: number;
}

const openOrders = defineMaterialization<OrderRow[]>({
	name: "openOrders",
	readSet: ["order.Placed"],
	initialState: [],
	fold: (state, event) =>
		event.type === "order.Placed"
			? [
					...state,
					{
						orderId: (event.data as { orderId: string }).orderId,
						totalCents: (event.data as { totalCents: number }).totalCents,
					},
				]
			: state,
});

const orders = defineAggregate<
	{ placed: boolean },
	{ id: string; totalCents: number }
>({
	name: "order",
	initialState: { placed: false },
	evolve: (state, event) =>
		event.type === "order.Placed" ? { placed: true } : state,
	decide: (state, command, emitter) => {
		if (state.placed) throw new Error("already placed");
		emitter.emit("order.Placed", {
			orderId: command.id,
			totalCents: command.totalCents,
		});
	},
});

let stores: RuntimeLocalEventStore[] = [];
function store(): RuntimeLocalEventStore {
	const s = freshStore();
	stores.push(s);
	return s;
}
afterEach(() => {
	for (const s of stores) s.close();
	stores = [];
});

describe("reactor reads-your-writes", () => {
	it("acknowledges a command only after affected subscriptions observe it", async () => {
		const s = store();
		const deliveries: Array<{ listener: number; deliver: () => void }> = [];
		let listener = 0;
		const delayed: EventStore = {
			...s,
			subscribe(filter, handler) {
				const current = listener++;
				return s.subscribe(filter, (event) => {
					deliveries.push({
						listener: current,
						deliver: () => {
							void handler(event);
						},
					});
				});
			},
		};
		const reactor = createReactor({
			store: delayed,
			streamer: createLocalStreamer(),
		});
		const affected = await reactor.subscribe(openOrders, {
			subscriptionId: "sub:affected",
		});
		const secondAffected = await reactor.subscribe(openOrders, {
			subscriptionId: "sub:second-affected",
		});
		const other = await reactor.subscribe(
			defineMaterialization({
				name: "other",
				readSet: ["other.Changed"],
				initialState: 0,
				fold: (state) => state,
			}),
			{ subscriptionId: "sub:other" },
		);
		let acknowledged = false;
		const pending = reactor
			.execute(orders, {
				actorHost: createInMemoryActorHost(),
				streamId: "order:ack",
				command: { id: "ack", totalCents: 25 },
				context: CTX,
			})
			.then((result) => {
				acknowledged = true;
				return result;
			});
		await expect.poll(() => deliveries.length).toBe(3);
		expect(acknowledged).toBe(false);
		deliveries.find((delivery) => delivery.listener === 0)?.deliver();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(acknowledged).toBe(false);
		deliveries.find((delivery) => delivery.listener === 1)?.deliver();
		const result = await pending;
		expect(affected.currentStream(result.streamId)).toEqual({
			seq: result.seq,
			value: [{ orderId: "ack", totalCents: 25 }],
		});
		expect(other.currentStream(result.streamId).seq).toBe(0);
		affected.close();
		secondAffected.close();
		other.close();
	});

	it("does not wait on old events when a command emits nothing", async () => {
		const s = store();
		await s.append(
			"order:unchanged",
			[{ type: "order.Placed", data: { orderId: "unchanged", totalCents: 1 } }],
			{ ...CTX, expectedSeq: 0 },
		);
		const reactor = createReactor({
			store: s,
			streamer: createLocalStreamer(),
		});
		const sub = await reactor.subscribe(openOrders, {
			subscriptionId: "sub:unchanged",
		});
		const unchanged = defineAggregate({
			name: "unchanged",
			initialState: 0,
			evolve: (state: number) => state,
			decide: () => {},
		});
		const result = await reactor.execute(unchanged, {
			actorHost: createInMemoryActorHost(),
			streamId: "order:unchanged",
			command: {},
			context: CTX,
		});
		expect(result.seq).toBe(1);
		expect(result.appended).toEqual([]);
		expect(sub.currentStream(result.streamId).seq).toBe(0);
		sub.close();
	});

	it("reports a committed command when an affected subscription fails", async () => {
		const s = store();
		const reactor = createReactor({
			store: s,
			streamer: createLocalStreamer(),
		});
		await reactor.subscribe(
			defineMaterialization({
				name: "broken",
				readSet: ["order.Placed"],
				initialState: 0,
				fold: () => {
					throw new Error("fold failed");
				},
			}),
			{ subscriptionId: "sub:broken" },
		);
		const result = reactor.execute(orders, {
			actorHost: createInMemoryActorHost(),
			streamId: "order:failed-observation",
			command: { id: "failed-observation", totalCents: 10 },
			context: CTX,
		});
		await expect(result).rejects.toBeInstanceOf(CommandObservationError);
		await expect(result).rejects.toMatchObject({
			name: "CommandObservationError",
			result: { streamId: "order:failed-observation", seq: 1 },
			subscriptionId: "sub:broken",
			cause: expect.objectContaining({ message: "fold failed" }),
		});
		const events = [];
		for await (const event of s.read("order:failed-observation"))
			events.push(event);
		expect(events.map((event) => event.type)).toEqual(["order.Placed"]);
	});

	it("cancels a wait after commit without losing the committed position", async () => {
		const s = store();
		const deliveries: Array<() => void> = [];
		const delayed: EventStore = {
			...s,
			subscribe(filter, handler) {
				return s.subscribe(filter, (event) => {
					deliveries.push(() => {
						void handler(event);
					});
				});
			},
		};
		const reactor = createReactor({
			store: delayed,
			streamer: createLocalStreamer(),
		});
		const sub = await reactor.subscribe(openOrders, {
			subscriptionId: "sub:cancel",
		});
		const controller = new AbortController();
		const stopped = new Error("cancelled observation");
		const pending = reactor.execute(orders, {
			actorHost: createInMemoryActorHost(),
			streamId: "order:cancel",
			command: { id: "cancel", totalCents: 10 },
			context: CTX,
			signal: controller.signal,
		});
		const rejection = expect(pending).rejects.toMatchObject({
			name: "CommandObservationError",
			result: { streamId: "order:cancel", seq: 1 },
			subscriptionId: "sub:cancel",
			cause: stopped,
		});
		await expect.poll(() => deliveries.length).toBe(1);
		controller.abort(stopped);
		await rejection;
		deliveries[0]?.();
		expect((await sub.awaitStreamSeq("order:cancel", 1)).value).toEqual([
			{ orderId: "cancel", totalCents: 10 },
		]);
		sub.close();
	});

	it("does not execute a command when its signal was already cancelled", async () => {
		const s = store();
		const reactor = createReactor({
			store: s,
			streamer: createLocalStreamer(),
		});
		const stopped = new Error("cancelled before command");
		const controller = new AbortController();
		controller.abort(stopped);
		await expect(
			reactor.execute(orders, {
				actorHost: createInMemoryActorHost(),
				streamId: "order:pre-cancel",
				command: { id: "pre-cancel", totalCents: 10 },
				context: CTX,
				signal: controller.signal,
			}),
		).rejects.toBe(stopped);
		const events = [];
		for await (const event of s.read("order:pre-cancel")) events.push(event);
		expect(events).toEqual([]);
	});

	it("observes a just-appended event at >= its command seq", async () => {
		const s = store();
		const streamer = createLocalStreamer();
		const reactor = createReactor({ store: s, streamer });
		const deps = { store: s, actorHost: createInMemoryActorHost() };

		const sub = await reactor.subscribe(openOrders, {
			subscriptionId: "sub:orders-tenant-a",
		});
		expect(sub.current()).toEqual({ value: [], seq: 0 });

		const result = await orders.execute(
			deps,
			"order:1001",
			{ id: "1001", totalCents: 4200 },
			CTX,
		);

		const observed = await sub.awaitStreamSeq(result.streamId, result.seq);
		expect(observed.seq).toBeGreaterThanOrEqual(result.seq);
		expect(observed.value).toEqual([{ orderId: "1001", totalCents: 4200 }]);

		await expect
			.poll(() => sub.facts().map((fact) => fact.type))
			.toContain("subscription.Pushed");
		const factTypes = sub.facts().map((fact) => fact.type);
		expect(factTypes).toContain("subscription.Opened");
		expect(factTypes).toContain("subscription.Recomputed");
	});

	it("tracks progress independently for each command stream", async () => {
		const s = store();
		const streamer = createLocalStreamer();
		const reactor = createReactor({ store: s, streamer });
		const deps = { store: s, actorHost: createInMemoryActorHost() };

		const sub = await reactor.subscribe(openOrders, {
			subscriptionId: "sub:orders-mono",
		});

		const first = await orders.execute(
			deps,
			"order:2001",
			{ id: "2001", totalCents: 100 },
			CTX,
		);
		await sub.awaitStreamSeq(first.streamId, first.seq);
		const afterFirst = sub.currentStream(first.streamId).seq;

		const second = await orders.execute(
			deps,
			"order:2002",
			{ id: "2002", totalCents: 200 },
			CTX,
		);
		await sub.awaitStreamSeq(second.streamId, second.seq);

		expect(sub.currentStream(first.streamId).seq).toBe(afterFirst);
		expect(sub.currentStream(second.streamId).seq).toBe(second.seq);
		expect(sub.current().value).toHaveLength(2);
	});

	it("replay-then-live: a new subscriber gets the current value before any live push", async () => {
		const s = store();
		await s.append(
			"order:3001",
			[{ type: "order.Placed", data: { orderId: "3001", totalCents: 55 } }],
			{ expectedSeq: 0, actor: CTX.actor, tenant: CTX.tenant },
		);

		const streamer = createLocalStreamer();
		const reactor = createReactor({ store: s, streamer });
		const sub = await reactor.subscribe(openOrders, {
			subscriptionId: "sub:orders-replay",
			replayStreamId: "order:3001",
		});

		const current = sub.current();
		expect(current.seq).toBe(1);
		expect(current.value).toEqual([{ orderId: "3001", totalCents: 55 }]);
	});
});

describe("reactor replay and stream positions", () => {
	it("buffers events until the store subscription is ready", async () => {
		const s = store();
		let release = () => {};
		const ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		const intercepted: EventStore = {
			...s,
			subscribe(filter, handler) {
				const subscription = s.subscribe(filter, handler);
				return { ready, unsubscribe: () => subscription.unsubscribe() };
			},
		};
		const pending = createReactor({
			store: intercepted,
			streamer: createLocalStreamer(),
		}).subscribe(openOrders, {
			subscriptionId: "sub:ready-buffer",
		});
		await s.append(
			"order:ready",
			[{ type: "order.Placed", data: { orderId: "ready", totalCents: 4 } }],
			{ ...CTX, expectedSeq: 0 },
		);
		release();
		const sub = await pending;
		expect(sub.currentStream("order:ready")).toEqual({
			value: [{ orderId: "ready", totalCents: 4 }],
			seq: 1,
		});
		sub.close();
	});

	it.each([
		"before replay",
		"after the replay snapshot",
	])("captures an overlapping append %s exactly once", async (timing) => {
		const s = store();
		await s.append(
			"order:overlap",
			[{ type: "order.Placed", data: { orderId: "first", totalCents: 1 } }],
			{ ...CTX, expectedSeq: 0 },
		);
		const intercepted: EventStore = {
			...s,
			read(streamId, fromSeq) {
				return {
					async *[Symbol.asyncIterator]() {
						const append = () =>
							s.append(
								streamId,
								[
									{
										type: "order.Placed",
										data: { orderId: "second", totalCents: 2 },
									},
								],
								{ ...CTX, expectedSeq: 1 },
							);
						if (timing === "before replay") await append();
						const events: EventEnvelope[] = [];
						for await (const event of s.read(streamId, fromSeq))
							events.push(event);
						for (const event of events) yield event;
						if (timing === "after the replay snapshot") await append();
					},
				};
			},
		};
		const sub = await createReactor({
			store: intercepted,
			streamer: createLocalStreamer(),
		}).subscribe(openOrders, {
			subscriptionId: `sub:overlap-${timing.replaceAll(" ", "-")}`,
			replayStreamId: "order:overlap",
		});
		expect(sub.currentStream("order:overlap")).toEqual({
			value: [
				{ orderId: "first", totalCents: 1 },
				{ orderId: "second", totalCents: 2 },
			],
			seq: 2,
		});
		expect(
			sub.facts().filter((fact) => fact.type === "subscription.Recomputed"),
		).toHaveLength(2);
		sub.close();
	});

	it("waits for the requested stream rather than another stream's sequence", async () => {
		const s = store();
		const sub = await createReactor({
			store: s,
			streamer: createLocalStreamer(),
		}).subscribe(openOrders, {
			subscriptionId: "sub:stream-sequences",
		});
		await s.append(
			"order:other",
			[
				{ type: "order.Placed", data: { orderId: "one", totalCents: 1 } },
				{ type: "order.Placed", data: { orderId: "two", totalCents: 2 } },
			],
			{ ...CTX, expectedSeq: 0 },
		);
		let resolved = false;
		const pending = sub.awaitStreamSeq("order:target", 1).then((result) => {
			resolved = true;
			return result;
		});
		await new Promise<void>((done) => setImmediate(done));
		expect(resolved).toBe(false);
		await s.append(
			"order:target",
			[{ type: "order.Placed", data: { orderId: "target", totalCents: 3 } }],
			{ ...CTX, expectedSeq: 0 },
		);
		expect(await pending).toEqual({
			value: [
				{ orderId: "one", totalCents: 1 },
				{ orderId: "two", totalCents: 2 },
				{ orderId: "target", totalCents: 3 },
			],
			seq: 1,
		});
		await s.append("order:target", [{ type: "order.Ignored", data: {} }], {
			...CTX,
			expectedSeq: 1,
		});
		expect((await sub.awaitStreamSeq("order:target", 2)).seq).toBe(2);
		const waiting = expect(
			sub.awaitStreamSeq("order:target", 3),
		).rejects.toThrow(/subscription closed/);
		sub.close();
		await waiting;
		sub.close();
		expect(
			sub.facts().filter((fact) => fact.type === "subscription.Closed"),
		).toHaveLength(1);
	});

	it("closes a live subscription when its tracked stream limit is exceeded", async () => {
		const s = store();
		const sub = await createReactor({
			store: s,
			streamer: createLocalStreamer(),
		}).subscribe(openOrders, {
			subscriptionId: "sub:stream-limit",
			maxTrackedStreams: 1,
		});
		await s.append(
			"order:a",
			[{ type: "order.Placed", data: { orderId: "a", totalCents: 1 } }],
			{ ...CTX, expectedSeq: 0 },
		);
		const pending = expect(sub.awaitStreamSeq("order:b", 1)).rejects.toThrow(
			"subscription stream limit exceeded",
		);
		await s.append(
			"order:b",
			[{ type: "order.Placed", data: { orderId: "b", totalCents: 2 } }],
			{ ...CTX, expectedSeq: 0 },
		);
		await pending;
		expect(
			sub.facts().filter((fact) => fact.type === "subscription.Closed"),
		).toHaveLength(1);
	});

	it("pushes stream progress for an event outside the read set", async () => {
		const s = store();
		const streamer = createLocalStreamer();
		const sub = await createReactor({ store: s, streamer }).subscribe(
			openOrders,
			{
				subscriptionId: "sub:ignored-progress",
			},
		);
		const reader = streamer
			.getRun<MaterializedFrame<OrderRow[]>>(parseRunId("sub:ignored-progress"))
			.readable[Symbol.asyncIterator]();
		await s.append("order:ignored", [{ type: "order.Ignored", data: {} }], {
			...CTX,
			expectedSeq: 0,
		});
		expect((await reader.next()).value?.chunk).toEqual({
			seq: 0,
			value: [],
			streamSeqs: { "order:ignored": 1 },
		});
		await reader.return?.();
		sub.close();
	});

	it("coalesces snapshots while a reader applies backpressure", async () => {
		const s = store();
		const streamer = createLocalStreamer({ bufferLimit: 1 });
		const sub = await createReactor({
			store: s,
			streamer,
		}).subscribe(openOrders, {
			subscriptionId: "sub:slow-reader",
		});
		const reader = streamer
			.getRun<MaterializedFrame<OrderRow[]>>(parseRunId("sub:slow-reader"))
			.readable[Symbol.asyncIterator]();
		await s.append(
			"order:push",
			[{ type: "order.Placed", data: { orderId: "one", totalCents: 1 } }],
			{ ...CTX, expectedSeq: 0 },
		);
		await expect
			.poll(
				() =>
					sub.facts().filter((fact) => fact.type === "subscription.Pushed")
						.length,
				{ timeout: 10_000 },
			)
			.toBe(1);
		await s.append(
			"order:push",
			[
				{ type: "order.Placed", data: { orderId: "two", totalCents: 2 } },
				{ type: "order.Placed", data: { orderId: "three", totalCents: 3 } },
			],
			{ ...CTX, expectedSeq: 1 },
		);
		expect((await sub.awaitStreamSeq("order:push", 3)).seq).toBe(3);
		await new Promise<void>((done) => setImmediate(done));
		expect(
			sub.facts().filter((fact) => fact.type === "subscription.Closed"),
		).toHaveLength(0);
		expect((await reader.next()).value?.chunk).toMatchObject({
			seq: 1,
			streamSeqs: { "order:push": 1 },
		});
		expect((await reader.next()).value?.chunk).toMatchObject({
			seq: 3,
			streamSeqs: { "order:push": 3 },
			value: [
				{ orderId: "one", totalCents: 1 },
				{ orderId: "two", totalCents: 2 },
				{ orderId: "three", totalCents: 3 },
			],
		});
		await reader.return?.();
		sub.close();
	});

	it("closes and rejects pending waits when a Streamer push fails", async () => {
		const s = store();
		const base = createLocalStreamer();
		const streamer: Streamer = {
			...base,
			createRun<TChunk = unknown>(options?: { runId?: RunId }) {
				const run = base.createRun<TChunk>(options);
				return {
					...run,
					getWritable<T = TChunk>(stream?: StreamName) {
						const writable = run.getWritable<T>(stream);
						return {
							...writable,
							write: async () => {
								throw new Error("stream write failed");
							},
						};
					},
				};
			},
		};
		const sub = await createReactor({ store: s, streamer }).subscribe(
			openOrders,
			{ subscriptionId: "sub:push-failed" },
		);
		const pending = expect(sub.awaitStreamSeq("order:push", 2)).rejects.toThrow(
			"stream write failed",
		);
		await s.append(
			"order:push",
			[{ type: "order.Placed", data: { orderId: "one", totalCents: 1 } }],
			{ ...CTX, expectedSeq: 0 },
		);
		await pending;
		expect(
			sub.facts().filter((fact) => fact.type === "subscription.Closed"),
		).toHaveLength(1);
	});

	it("closes the store listener and streamer when replay fails", async () => {
		const s = store();
		const streamer = createLocalStreamer();
		let unsubscribed = 0;
		let finalized = false;
		const intercepted: EventStore = {
			...s,
			subscribe(filter, handler) {
				const subscription = s.subscribe(filter, handler);
				return {
					unsubscribe() {
						unsubscribed += 1;
						subscription.unsubscribe();
					},
				};
			},
			read() {
				return {
					[Symbol.asyncIterator]() {
						return {
							async next(): Promise<IteratorResult<EventEnvelope>> {
								try {
									throw new Error("replay failed");
								} finally {
									finalized = true;
								}
							},
						};
					},
				};
			},
		};
		await expect(
			createReactor({ store: intercepted, streamer }).subscribe(openOrders, {
				subscriptionId: "sub:read-failed",
				replayStreamId: "order:broken",
			}),
		).rejects.toThrow("replay failed");
		expect(finalized).toBe(true);
		expect(unsubscribed).toBe(1);
		expect(() => streamer.getRun(parseRunId("sub:read-failed"))).toThrow();
	});

	it("fails closed and cleans up when the replay buffer fills", async () => {
		const s = store();
		const streamer = createLocalStreamer();
		let unsubscribed = 0;
		const intercepted: EventStore = {
			...s,
			subscribe(filter, handler) {
				const subscription = s.subscribe(filter, handler);
				return {
					unsubscribe() {
						unsubscribed += 1;
						subscription.unsubscribe();
					},
				};
			},
			read(streamId) {
				return {
					[Symbol.asyncIterator]() {
						return {
							async next(): Promise<IteratorResult<EventEnvelope>> {
								await s.append(
									streamId,
									[
										{
											type: "order.Placed",
											data: { orderId: "one", totalCents: 1 },
										},
										{
											type: "order.Placed",
											data: { orderId: "two", totalCents: 2 },
										},
									],
									{ ...CTX, expectedSeq: 0 },
								);
								return { done: true, value: undefined };
							},
						};
					},
				};
			},
		};
		await expect(
			createReactor({ store: intercepted, streamer }).subscribe(openOrders, {
				subscriptionId: "sub:overflow",
				replayStreamId: "order:overflow",
				maxBufferedEvents: 1,
			}),
		).rejects.toThrow("subscription replay buffer limit exceeded");
		expect(unsubscribed).toBe(1);
		expect(() => streamer.getRun(parseRunId("sub:overflow"))).toThrow();
	});

	it("does not wait on a blocked replay after the buffer overflows", async () => {
		const s = store();
		const streamer = createLocalStreamer();
		let unsubscribed = 0;
		const intercepted: EventStore = {
			...s,
			subscribe(filter, handler) {
				const subscription = s.subscribe(filter, handler);
				return {
					unsubscribe() {
						unsubscribed += 1;
						subscription.unsubscribe();
					},
				};
			},
			read() {
				return {
					[Symbol.asyncIterator]() {
						return {
							next: () => new Promise<IteratorResult<EventEnvelope>>(() => {}),
						};
					},
				};
			},
		};
		const pending = createReactor({ store: intercepted, streamer }).subscribe(
			openOrders,
			{
				subscriptionId: "sub:blocked-overflow",
				replayStreamId: "order:blocked",
				maxBufferedEvents: 1,
			},
		);
		const rejected = expect(pending).rejects.toThrow(
			"subscription replay buffer limit exceeded",
		);
		await s.append(
			"order:blocked",
			[
				{ type: "order.Placed", data: { orderId: "one", totalCents: 1 } },
				{ type: "order.Placed", data: { orderId: "two", totalCents: 2 } },
			],
			{ ...CTX, expectedSeq: 0 },
		);
		await rejected;
		expect(unsubscribed).toBe(1);
		expect(() => streamer.getRun(parseRunId("sub:blocked-overflow"))).toThrow();
	});

	it("does not fold a replay result that arrives after overflow", async () => {
		const s = store();
		const streamer = createLocalStreamer();
		let releaseNext: (result: IteratorResult<EventEnvelope>) => void = () => {};
		let announceStart = () => {};
		const started = new Promise<void>((resolve) => {
			announceStart = resolve;
		});
		let returned = false;
		let folds = 0;
		const intercepted: EventStore = {
			...s,
			read() {
				return {
					[Symbol.asyncIterator]() {
						return {
							next() {
								announceStart();
								return new Promise<IteratorResult<EventEnvelope>>((resolve) => {
									releaseNext = resolve;
								});
							},
							async return(): Promise<IteratorResult<EventEnvelope>> {
								returned = true;
								return { done: true, value: undefined };
							},
						};
					},
				};
			},
		};
		const materialization = {
			...openOrders,
			fold(state: OrderRow[], event: EventEnvelope) {
				folds += 1;
				return openOrders.fold(state, event);
			},
		};
		const pending = createReactor({ store: intercepted, streamer }).subscribe(
			materialization,
			{
				subscriptionId: "sub:late-replay",
				replayStreamId: "order:late",
				maxBufferedEvents: 1,
			},
		);
		const rejected = expect(pending).rejects.toThrow(
			"subscription replay buffer limit exceeded",
		);
		await started;
		await s.append(
			"order:late",
			[
				{ type: "order.Placed", data: { orderId: "one", totalCents: 1 } },
				{ type: "order.Placed", data: { orderId: "two", totalCents: 2 } },
			],
			{ ...CTX, expectedSeq: 0 },
		);
		await rejected;
		const events: EventEnvelope[] = [];
		for await (const event of s.read("order:late")) events.push(event);
		const first = events[0];
		if (!first) throw new Error("expected a persisted event");
		releaseNext({ done: false, value: first });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(returned).toBe(true);
		expect(folds).toBe(0);
	});

	it("cleans up if a store subscription is not ready", async () => {
		const s = store();
		const streamer = createLocalStreamer();
		let unsubscribed = 0;
		const intercepted: EventStore = {
			...s,
			subscribe(filter, handler) {
				const subscription = s.subscribe(filter, handler);
				return {
					ready: Promise.reject(new Error("listener unavailable")),
					unsubscribe() {
						unsubscribed += 1;
						subscription.unsubscribe();
					},
				};
			},
		};
		await expect(
			createReactor({ store: intercepted, streamer }).subscribe(openOrders, {
				subscriptionId: "sub:not-ready",
			}),
		).rejects.toThrow("listener unavailable");
		expect(unsubscribed).toBe(1);
		expect(() => streamer.getRun(parseRunId("sub:not-ready"))).toThrow();
	});
});
