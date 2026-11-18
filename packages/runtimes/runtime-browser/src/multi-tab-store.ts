import type {
	AppendOptions,
	ClaimSubscriptionOptions,
	CommitCheckpointOptions,
	DurableCommitRequest,
	EventEnvelope,
	EventInput,
	ReadAllOptions,
	ResetCheckpointOptions,
	StreamFilter,
} from "@hobo/core/eventstore";
import type { BrowserEventStore } from "./browser-store.js";
import type { JsonValue } from "./json.js";
import { openWorkerStore } from "./worker-store.js";

type EventHandler = {
	filter: StreamFilter;
	handle(event: EventEnvelope): void | Promise<void>;
};

export async function openMultiTabStore(input: {
	partitionId: string;
	wasmUrl: string;
}): Promise<BrowserEventStore> {
	const name = `hobo:browser-store:${input.partitionId}`;
	const channel = new BroadcastChannel(name);
	const handlers = new Set<EventHandler>();
	const pending = new Set<Promise<void>>();
	let closed = false;

	function notify(events: readonly EventEnvelope[]): void {
		for (const event of events)
			for (const handler of handlers) {
				if (
					handler.filter.streamId &&
					handler.filter.streamId !== event.streamId
				)
					continue;
				if (handler.filter.type && handler.filter.type !== event.type) continue;
				void Promise.resolve()
					.then(() => handler.handle(event))
					.catch(() => {});
			}
	}

	channel.addEventListener(
		"message",
		(message: MessageEvent<EventEnvelope[]>) => notify(message.data),
	);

	function useStore<T>(
		action: (store: BrowserEventStore) => Promise<T>,
	): Promise<T> {
		if (closed) return Promise.reject(new Error("Browser storage is closed"));
		const result = navigator.locks.request(name, async () => {
			if (closed) throw new Error("Browser storage is closed");
			const store = await openWorkerStore({
				partitionId: input.partitionId,
				mode: "opfs-sahpool",
				wasmUrl: input.wasmUrl,
			});
			try {
				return await action(store);
			} finally {
				await store.close();
			}
		});
		const settled = result.then(
			() => {},
			() => {},
		);
		pending.add(settled);
		void settled.then(() => pending.delete(settled));
		return result;
	}

	function publish(events: readonly EventEnvelope[]): void {
		if (events.length === 0) return;
		notify(events);
		channel.postMessage(events);
	}

	try {
		await useStore(async () => {});
	} catch (error) {
		channel.close();
		throw error;
	}

	return {
		persistenceMode: "opfs-sahpool",
		append(streamId: string, events: EventInput[], options: AppendOptions) {
			return useStore(async (store) => {
				const result = await store.append(streamId, events, options);
				publish(result.appended);
				return result;
			});
		},
		commit(request: DurableCommitRequest) {
			return useStore(async (store) => {
				const result = await store.commit(request);
				publish(result.appended);
				return result;
			});
		},
		async *read(streamId: string, fromSeq?: number) {
			const events = await useStore(async (store) => {
				const result: EventEnvelope[] = [];
				for await (const event of store.read(streamId, fromSeq))
					result.push(event);
				return result;
			});
			yield* events;
		},
		async *readAll(options: ReadAllOptions = {}) {
			const events = await useStore(async (store) => {
				const result = [];
				for await (const event of store.readAll(options)) result.push(event);
				return result;
			});
			yield* events;
		},
		subscribe(filter: StreamFilter, handle: EventHandler["handle"]) {
			if (closed) throw new Error("Browser storage is closed");
			const handler = { filter, handle };
			handlers.add(handler);
			return {
				ready: Promise.resolve(),
				unsubscribe() {
					handlers.delete(handler);
				},
			};
		},
		snapshot(streamId: string, state: JsonValue, seq: number) {
			return useStore((store) => store.snapshot(streamId, state, seq));
		},
		loadSnapshot<S>(streamId: string) {
			return useStore((store) => {
				if (!store.loadSnapshot)
					throw new Error("Snapshot reads are unavailable");
				return store.loadSnapshot<S>(streamId);
			});
		},
		claimSubscription(options: ClaimSubscriptionOptions) {
			return useStore((store) => {
				if (!store.claimSubscription)
					throw new Error("Subscription claims are unavailable");
				return store.claimSubscription(options);
			});
		},
		loadCheckpoint(options: { subscriptionId: string; partitionId: string }) {
			return useStore((store) => {
				if (!store.loadCheckpoint)
					throw new Error("Checkpoint reads are unavailable");
				return store.loadCheckpoint(options);
			});
		},
		commitCheckpoint(options: CommitCheckpointOptions) {
			return useStore((store) => {
				if (!store.commitCheckpoint)
					throw new Error("Checkpoint commits are unavailable");
				return store.commitCheckpoint(options);
			});
		},
		resetCheckpoint(options: ResetCheckpointOptions) {
			return useStore((store) => {
				if (!store.resetCheckpoint)
					throw new Error("Checkpoint resets are unavailable");
				return store.resetCheckpoint(options);
			});
		},
		async close() {
			closed = true;
			await Promise.all(pending);
			handlers.clear();
			channel.close();
		},
	};
}
