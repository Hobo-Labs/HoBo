import type {
	CacheClient,
	EventEnvelope,
	EventStore,
	Subscription,
} from "@hobo/core";

export interface CacheInvalidationConnection extends Subscription {
	readonly ready: Promise<void>;
	drain(): Promise<void>;
}

export function subscribeCacheInvalidation(
	store: EventStore,
	cache: Pick<CacheClient, "invalidate">,
	tagsForChange: (
		event: EventEnvelope,
	) => readonly string[] | Promise<readonly string[]>,
	options: Readonly<{
		replayStreams?: readonly string[];
		maxBufferedEvents?: number;
	}> = {},
): CacheInvalidationConnection {
	const maxBufferedEvents = options.maxBufferedEvents ?? 10_000;
	if (!Number.isSafeInteger(maxBufferedEvents) || maxBufferedEvents < 1)
		throw new RangeError("maxBufferedEvents must be a positive safe integer");
	let pending = Promise.resolve();
	let replaying = true;
	let overflow = false;
	const buffered: EventEnvelope[] = [];
	const replayedThrough = new Map<string, number>();
	const failures: Error[] = [];
	function enqueue(event: EventEnvelope): void {
		if (event.type !== "data.Changed") return;
		pending = pending
			.then(async () => {
				const tags = await tagsForChange(event);
				for (const tag of new Set(tags)) await cache.invalidate(tag);
			})
			.catch((error) => {
				failures.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			});
	}
	async function drain(): Promise<void> {
		const current = pending;
		await current;
		if (failures.length > 0)
			throw new AggregateError(failures.splice(0), "cache invalidation failed");
	}
	const subscription = store.subscribe({ type: "data.Changed" }, (event) => {
		if (event.type !== "data.Changed") return;
		if (!replaying) {
			enqueue(event);
			return;
		}
		if (buffered.length >= maxBufferedEvents) {
			overflow = true;
			return;
		}
		buffered.push(event);
	});
	const ready = (async () => {
		try {
			await subscription.ready;
			for (const stream of new Set(options.replayStreams ?? [])) {
				for await (const event of store.read(stream, 1)) {
					if (overflow)
						throw new Error(
							"cache invalidation replay buffer exceeded its limit",
						);
					enqueue(event);
					if (event.type === "data.Changed")
						replayedThrough.set(event.streamId, event.seq);
					await pending;
				}
			}
			if (overflow)
				throw new Error("cache invalidation replay buffer exceeded its limit");
			replaying = false;
			for (const event of buffered) {
				if (event.seq > (replayedThrough.get(event.streamId) ?? 0))
					enqueue(event);
			}
			await drain();
		} catch (error) {
			subscription.unsubscribe();
			throw error;
		}
	})();
	return {
		ready,
		drain,
		unsubscribe() {
			subscription.unsubscribe();
		},
	};
}
