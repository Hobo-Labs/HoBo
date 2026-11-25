import type {
	EventEnvelope,
	EventStore,
	Streamer,
	StreamerWritable,
	Subscription,
} from "@hobo/core";
import { parseRunId } from "@hobo/core";

import {
	createSubscriptionClosedEvent,
	createSubscriptionOpenedEvent,
	createSubscriptionPushedEvent,
	createSubscriptionRecomputedEvent,
	type ReactiveFact,
} from "./events.js";

// A materialization is a deterministic fold over subscribed event types, exposed
// as a subscribable observable (data-plane.md Plan 32 "The model in one
// paragraph"). The fold is read-only + replayable.
export interface Materialization<S> {
	name: string;
	readSet: readonly string[];
	initialState: S;
	fold: (state: S, event: EventEnvelope) => S;
}

export function defineMaterialization<S>(
	definition: Materialization<S>,
): Materialization<S> {
	if (!definition.name) throw new TypeError("materialization name is required");
	if (Object(definition.fold) !== definition.fold) {
		throw new TypeError("materialization fold must be a function");
	}
	return definition;
}

export interface SubscriptionHandle<S> {
	readonly subscriptionId: string;
	// Current materialized value + the monotonic log position it was computed at.
	current(): { value: S; seq: number };
	// Reads-your-writes: resolve once the subscription has advanced to >= seq.
	awaitSeq(seq: number): Promise<{ value: S; seq: number }>;
	// The subscription.*/push facts emitted so far (Opened/Recomputed/Pushed).
	facts(): ReactiveFact[];
	close(reason?: string): void;
}

export interface Reactor {
	subscribe<S>(
		materialization: Materialization<S>,
		options: { subscriptionId: string; replayStreamId?: string },
	): Promise<SubscriptionHandle<S>>;
}

function clone<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

function hashReadSet(readSet: readonly string[], seq: number): string {
	return `${[...readSet].sort().join(",")}@${seq}`;
}

// The Reactor grain: per subscription it holds { materialization, readSet,
// lastSeq, state } and pushes recomputed snapshots over the Streamer port.
export function createReactor(deps: {
	store: EventStore;
	streamer: Streamer;
}): Reactor {
	return {
		async subscribe(materialization, options) {
			const { subscriptionId } = options;
			const readSet = new Set(materialization.readSet);
			const run = deps.streamer.createRun({
				runId: parseRunId(subscriptionId),
			});
			const writable: StreamerWritable = run.getWritable();

			let state = clone(materialization.initialState);
			let lastSeq = 0;
			const facts: ReactiveFact[] = [
				createSubscriptionOpenedEvent({
					subscriptionId,
					materialization: materialization.name,
					readSet: materialization.readSet,
				}),
			];
			const waiters: Array<{ seq: number; resolve: () => void }> = [];

			function apply(event: EventEnvelope): void {
				if (!readSet.has(event.type)) return;
				state = materialization.fold(state, Object.freeze(clone(event)));
				lastSeq = Math.max(lastSeq, event.seq);
				facts.push(
					createSubscriptionRecomputedEvent({
						subscriptionId,
						seq: lastSeq,
						readSetHash: hashReadSet(materialization.readSet, lastSeq),
					}),
				);
				// Push the recomputed snapshot to the client over the Streamer port.
				void writable.write({ seq: lastSeq, value: clone(state) });
				facts.push(
					createSubscriptionPushedEvent({
						subscriptionId,
						seq: lastSeq,
						resultCount: Array.isArray(state) ? state.length : 1,
					}),
				);
				for (let i = waiters.length - 1; i >= 0; i -= 1) {
					if (lastSeq >= waiters[i].seq) {
						waiters[i].resolve();
						waiters.splice(i, 1);
					}
				}
			}

			// Replay-then-live: fold the current stream to its head, then go live.
			if (options.replayStreamId) {
				for await (const event of deps.store.read(options.replayStreamId)) {
					apply(event);
				}
			}

			const storeSub: Subscription = deps.store.subscribe({}, (event) => {
				apply(event);
			});

			return {
				subscriptionId,
				current() {
					return { value: clone(state), seq: lastSeq };
				},
				awaitSeq(seq) {
					if (lastSeq >= seq) {
						return Promise.resolve({ value: clone(state), seq: lastSeq });
					}
					return new Promise((resolve) => {
						waiters.push({
							seq,
							resolve: () => resolve({ value: clone(state), seq: lastSeq }),
						});
					});
				},
				facts() {
					return [...facts];
				},
				close(reason = "client-closed") {
					storeSub.unsubscribe();
					deps.streamer.teardownRun(parseRunId(subscriptionId), reason);
					facts.push(createSubscriptionClosedEvent({ subscriptionId, reason }));
				},
			};
		},
	};
}
