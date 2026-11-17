import type {
	EventEnvelope,
	EventStore,
	Streamer,
	StreamerWritable,
	Subscription,
} from "@hobo/core";
import { parseRunId, StreamerBackpressureError } from "@hobo/core";

import {
	createSubscriptionClosedEvent,
	createSubscriptionOpenedEvent,
	createSubscriptionPushedEvent,
	createSubscriptionRecomputedEvent,
	type ReactiveFact,
} from "./events.js";

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

export interface MaterializedSnapshot<S> {
	value: S;
	seq: number;
}

export interface MaterializedFrame<S> extends MaterializedSnapshot<S> {
	streamSeqs: Readonly<Record<string, number>>;
}

export interface SubscriptionHandle<S> {
	readonly subscriptionId: string;
	current(): MaterializedSnapshot<S>;
	currentStream(streamId: string): MaterializedSnapshot<S>;
	awaitSeq(seq: number): Promise<MaterializedSnapshot<S>>;
	awaitStreamSeq(
		streamId: string,
		seq: number,
	): Promise<MaterializedSnapshot<S>>;
	facts(): ReactiveFact[];
	close(reason?: string): void;
}

export interface Reactor {
	subscribe<S>(
		materialization: Materialization<S>,
		options: {
			subscriptionId: string;
			replayStreamId?: string;
			maxBufferedEvents?: number;
			maxTrackedStreams?: number;
		},
	): Promise<SubscriptionHandle<S>>;
}

function clone<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

function hashReadSet(readSet: readonly string[], seq: number): string {
	return `${[...readSet].sort().join(",")}@${seq}`;
}

function limit(value: number | undefined, name: string): number {
	const result = value ?? 10_000;
	if (!Number.isSafeInteger(result) || result < 1)
		throw new RangeError(`${name} must be a positive safe integer`);
	return result;
}

export function createReactor(deps: {
	store: EventStore;
	streamer: Streamer;
}): Reactor {
	return {
		async subscribe(materialization, options) {
			const { subscriptionId } = options;
			const maxBufferedEvents = limit(
				options.maxBufferedEvents,
				"maxBufferedEvents",
			);
			const maxTrackedStreams = limit(
				options.maxTrackedStreams,
				"maxTrackedStreams",
			);
			const readSet = new Set(materialization.readSet);
			const runId = parseRunId(subscriptionId);
			let state = clone(materialization.initialState);
			const run = deps.streamer.createRun({ runId });
			let writable: StreamerWritable;
			try {
				writable = run.getWritable();
			} catch (error) {
				deps.streamer.teardownRun(runId, "subscription-failed");
				throw error;
			}
			let lastSeq = 0;
			let storeSub: Subscription | undefined;
			let replaying = true;
			let closed = false;
			let terminalError: Error | undefined;
			let replayError: Error | undefined;
			let pendingPush: MaterializedFrame<typeof state> | undefined;
			let pushing = false;
			let retryTimer: ReturnType<typeof setTimeout> | undefined;
			let retryDelayMs = 25;
			let rejectReplay: (error: Error) => void = () => {};
			const replayFailure = new Promise<never>((_resolve, reject) => {
				rejectReplay = reject;
			});
			void replayFailure.catch(() => {});
			const buffered: EventEnvelope[] = [];
			const streamSeqs = new Map<string, number>();
			const facts: ReactiveFact[] = [
				createSubscriptionOpenedEvent({
					subscriptionId,
					materialization: materialization.name,
					readSet: materialization.readSet,
				}),
			];
			const waiters: Array<{
				streamId: string | undefined;
				seq: number;
				resolve: (result: MaterializedSnapshot<typeof state>) => void;
				reject: (error: Error) => void;
			}> = [];

			function unsubscribeStore(): Error | undefined {
				const current = storeSub;
				storeSub = undefined;
				try {
					current?.unsubscribe();
					return undefined;
				} catch (error) {
					return error instanceof Error ? error : new Error(String(error));
				}
			}

			function terminate(reason: string, error?: Error): void {
				if (closed) return;
				closed = true;
				terminalError = error ?? new Error(`subscription closed: ${reason}`);
				if (retryTimer !== undefined) clearTimeout(retryTimer);
				retryTimer = undefined;
				pendingPush = undefined;
				if (replaying && error && !replayError) {
					replayError = error;
					rejectReplay(error);
				}
				const cleanupErrors: Error[] = [];
				const unsubscribeError = unsubscribeStore();
				if (unsubscribeError) cleanupErrors.push(unsubscribeError);
				try {
					deps.streamer.teardownRun(runId, reason);
				} catch (cleanupError) {
					cleanupErrors.push(
						cleanupError instanceof Error
							? cleanupError
							: new Error(String(cleanupError)),
					);
				}
				if (cleanupErrors.length > 0)
					terminalError = new AggregateError(
						[terminalError, ...cleanupErrors],
						"subscription cleanup failed",
					);
				for (const waiter of waiters.splice(0)) waiter.reject(terminalError);
				facts.push(createSubscriptionClosedEvent({ subscriptionId, reason }));
				if (!error && cleanupErrors.length > 0) throw terminalError;
			}

			function snapshot(streamId?: string): MaterializedSnapshot<typeof state> {
				return {
					value: clone(state),
					seq:
						streamId === undefined ? lastSeq : (streamSeqs.get(streamId) ?? 0),
				};
			}

			function resolveWaiters(): void {
				for (let index = waiters.length - 1; index >= 0; index -= 1) {
					const waiter = waiters[index];
					if (!waiter) continue;
					const position =
						waiter.streamId === undefined
							? lastSeq
							: (streamSeqs.get(waiter.streamId) ?? 0);
					if (position >= waiter.seq) {
						waiters.splice(index, 1);
						waiter.resolve(snapshot(waiter.streamId));
					}
				}
			}

			function push(): void {
				if (
					closed ||
					replaying ||
					pushing ||
					retryTimer !== undefined ||
					!pendingPush
				)
					return;
				const frame = pendingPush;
				pendingPush = undefined;
				pushing = true;
				void Promise.resolve()
					.then(() => writable.write(frame))
					.then(
						() => {
							if (closed) return;
							retryDelayMs = 25;
							facts.push(
								createSubscriptionPushedEvent({
									subscriptionId,
									seq: frame.seq,
									resultCount: Array.isArray(frame.value)
										? frame.value.length
										: 1,
								}),
							);
						},
						(error) => {
							if (closed) return;
							if (!(error instanceof StreamerBackpressureError)) {
								terminate(
									"stream-failed",
									error instanceof Error ? error : new Error(String(error)),
								);
								return;
							}
							pendingPush ??= frame;
							const delay = retryDelayMs;
							retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
							retryTimer = setTimeout(() => {
								retryTimer = undefined;
								push();
							}, delay);
							retryTimer.unref();
						},
					)
					.finally(() => {
						pushing = false;
						push();
					});
			}

			function apply(event: EventEnvelope): void {
				const previous = streamSeqs.get(event.streamId);
				if (previous !== undefined && event.seq <= previous) return;
				if (previous === undefined && streamSeqs.size >= maxTrackedStreams)
					throw new Error("subscription stream limit exceeded");
				const relevant = readSet.has(event.type);
				if (relevant)
					state = materialization.fold(state, Object.freeze(clone(event)));
				streamSeqs.set(event.streamId, event.seq);
				if (relevant) {
					lastSeq = Math.max(lastSeq, event.seq);
					facts.push(
						createSubscriptionRecomputedEvent({
							subscriptionId,
							seq: lastSeq,
							readSetHash: hashReadSet(materialization.readSet, lastSeq),
						}),
					);
				}
				if (!replaying) queuePush();
				resolveWaiters();
			}

			function queuePush(): void {
				pendingPush = {
					seq: lastSeq,
					value: clone(state),
					streamSeqs: Object.fromEntries(streamSeqs),
				};
				push();
			}

			function onEvent(event: EventEnvelope): void {
				if (closed || replayError) return;
				if (replaying) {
					if (buffered.length >= maxBufferedEvents) {
						replayError = new Error(
							"subscription replay buffer limit exceeded",
						);
						const cleanupError = unsubscribeStore();
						if (cleanupError)
							replayError = new AggregateError(
								[replayError, cleanupError],
								"subscription replay cleanup failed",
							);
						rejectReplay(replayError);
					} else buffered.push(event);
					return;
				}
				try {
					apply(event);
				} catch (error) {
					terminate(
						"fold-failed",
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			}

			function waitFor(
				streamId: string | undefined,
				seq: number,
			): Promise<MaterializedSnapshot<typeof state>> {
				if (!Number.isSafeInteger(seq) || seq < 0)
					return Promise.reject(
						new RangeError("seq must be a non-negative safe integer"),
					);
				if (streamId !== undefined && !streamId)
					return Promise.reject(new TypeError("streamId is required"));
				if (closed) return Promise.reject(terminalError);
				const current = snapshot(streamId);
				if (current.seq >= seq) return Promise.resolve(current);
				return new Promise((resolve, reject) => {
					waiters.push({ streamId, seq, resolve, reject });
				});
			}

			try {
				storeSub = deps.store.subscribe({}, onEvent);
				await Promise.race([
					storeSub.ready ?? Promise.resolve(),
					replayFailure,
				]);
				if (options.replayStreamId) {
					const iterator = deps.store
						.read(options.replayStreamId)
						[Symbol.asyncIterator]();
					let completed = false;
					const readReplay = async () => {
						for (;;) {
							const item = await iterator.next();
							if (replayError) throw replayError;
							if (item.done) {
								completed = true;
								return;
							}
							apply(item.value);
						}
					};
					try {
						await Promise.race([readReplay(), replayFailure]);
					} finally {
						if (!completed && iterator.return) {
							const cleanup = iterator.return();
							if (replayError) void cleanup.catch(() => {});
							else await cleanup;
						}
					}
				}
				while (buffered.length > 0) {
					if (replayError) throw replayError;
					for (const event of buffered.splice(0)) apply(event);
				}
				if (replayError) throw replayError;
				replaying = false;
				if (streamSeqs.size > 0) queuePush();
			} catch (error) {
				terminate(
					"subscription-failed",
					error instanceof Error ? error : new Error(String(error)),
				);
				throw terminalError ?? error;
			}

			return {
				subscriptionId,
				current: () => snapshot(),
				currentStream: (streamId) => {
					if (!streamId) throw new TypeError("streamId is required");
					return snapshot(streamId);
				},
				awaitSeq: (seq) => waitFor(undefined, seq),
				awaitStreamSeq: (streamId, seq) => waitFor(streamId, seq),
				facts: () => [...facts],
				close: (reason = "client-closed") => terminate(reason),
			};
		},
	};
}
