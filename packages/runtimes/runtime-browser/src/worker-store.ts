import type {
	AppendOptions,
	ClaimSubscriptionOptions,
	CommitCheckpointOptions,
	DurableCommitRequest,
	EventEnvelope,
	EventInput,
	ReadAllOptions,
	ResetCheckpointOptions,
	SnapshotRecord,
	StreamFilter,
} from "@hobo/core/eventstore";
import {
	CheckpointRegressionError,
	MissingFenceError,
	OptimisticSequenceConflictError,
	SnapshotAheadError,
	StaleFenceError,
} from "@hobo/core/eventstore";
import type { BrowserEventStore } from "./browser-store.js";
import type { JsonValue } from "./json.js";
import type { BrowserPersistenceMode } from "./types.js";
import type {
	WorkerFailure,
	WorkerMessage,
	WorkerOperation,
	WorkerOperations,
	WorkerSuccess,
} from "./worker-rpc.js";

function successFor<K extends WorkerOperation>(
	message: WorkerSuccess,
	op: K,
): message is Extract<WorkerSuccess, { op: K }> {
	return message.op === op;
}

class BrowserWorkerError extends Error {
	readonly code: string | undefined;
	constructor(error: WorkerFailure["error"]) {
		super(error.message);
		this.name = error.name;
		this.code = error.code;
	}
}

function failureError(error: WorkerFailure["error"]): Error {
	const details = error.details;
	switch (details?.kind) {
		case "sequence":
			return new OptimisticSequenceConflictError(
				details.streamId,
				details.expectedSeq,
				details.actualSeq,
			);
		case "stale-fence":
			return new StaleFenceError(
				details.streamId,
				details.provided,
				details.stored,
			);
		case "missing-fence":
			return new MissingFenceError(details.streamId, details.stored);
		case "snapshot":
			return new SnapshotAheadError(
				details.streamId,
				details.snapshotSeq,
				details.headSeq,
			);
		case "checkpoint":
			return new CheckpointRegressionError(
				details.subscriptionId,
				details.partitionId,
				details.attempted,
				details.current,
			);
		default:
			return new BrowserWorkerError(error);
	}
}

class JournalWorker {
	private nextId = 0;
	private readonly pending = new Map<
		string,
		(message: WorkerSuccess | WorkerFailure) => void
	>();
	readonly handlers = new Map<
		string,
		(event: EventEnvelope) => void | Promise<void>
	>();
	private failed: Error | undefined;

	constructor(private readonly worker: Worker) {
		worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
			const message = event.data;
			if ("type" in message) {
				const handler = this.handlers.get(message.subscriptionId);
				if (handler)
					void Promise.resolve()
						.then(() => handler(message.event))
						.catch(() => {});
				return;
			}
			this.pending.get(message.id)?.(message);
			this.pending.delete(message.id);
		});
		worker.addEventListener("error", (event) =>
			this.fail(new Error(event.message || "Browser storage worker failed")),
		);
		worker.addEventListener("messageerror", () =>
			this.fail(new Error("Browser storage worker message failed")),
		);
	}

	private fail(error: Error): void {
		this.failed = error;
		for (const [id, finish] of this.pending)
			finish({
				id,
				ok: false,
				error: { name: error.name, message: error.message },
			});
		this.pending.clear();
		this.worker.terminate();
	}

	request<K extends WorkerOperation>(
		op: K,
		input: WorkerOperations[K]["input"],
	): Promise<WorkerOperations[K]["output"]> {
		if (this.failed) return Promise.reject(this.failed);
		const id = String(++this.nextId);
		return new Promise((resolve, reject) => {
			this.pending.set(id, (message) => {
				if (!message.ok) reject(failureError(message.error));
				else if (successFor(message, op)) resolve(message.result);
				else reject(new Error(`Unexpected storage response for ${op}`));
			});
			try {
				this.worker.postMessage({ id, op, input });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	terminate(): void {
		this.fail(new Error("Browser storage worker is closed"));
	}
}

export async function openWorkerStore(input: {
	partitionId: string;
	mode: BrowserPersistenceMode;
	wasmUrl: string;
}): Promise<BrowserEventStore> {
	const client = new JournalWorker(
		new Worker(new URL("./sqlite-worker.js", import.meta.url), {
			type: "module",
		}),
	);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			client.request("open", {
				partitionId: input.partitionId,
				durable: input.mode === "opfs-sahpool",
				wasmUrl: input.wasmUrl,
			}),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() =>
						reject(new Error("Browser storage worker did not open in time")),
					30_000,
				);
			}),
		]);
	} catch (error) {
		client.terminate();
		throw error;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
	let subscriptionId = 0;
	return {
		persistenceMode: input.mode,
		append(streamId: string, events: EventInput[], options: AppendOptions) {
			return client.request("append", { streamId, events, options });
		},
		commit(request: DurableCommitRequest) {
			return client.request("commit", request);
		},
		async *read(streamId: string, fromSeq?: number) {
			const events = await client.request("read", {
				streamId,
				...(fromSeq !== undefined ? { fromSeq } : undefined),
			});
			yield* events;
		},
		async *readAll(options: ReadAllOptions = {}) {
			yield* await client.request("readAll", options);
		},
		subscribe(
			filter: StreamFilter,
			handler: (event: EventEnvelope) => void | Promise<void>,
		) {
			const id = String(++subscriptionId);
			client.handlers.set(id, handler);
			const ready = client.request("subscribe", { subscriptionId: id, filter });
			return {
				ready,
				unsubscribe() {
					client.handlers.delete(id);
					void ready
						.then(() => client.request("unsubscribe", { subscriptionId: id }))
						.catch(() => {});
				},
			};
		},
		snapshot(streamId: string, state: JsonValue, seq: number) {
			return client.request("snapshot", { streamId, state, seq });
		},
		async loadSnapshot<S>(streamId: string) {
			return (await client.request("loadSnapshot", { streamId })) as
				| SnapshotRecord<S>
				| undefined;
		},
		claimSubscription(options: ClaimSubscriptionOptions) {
			return client.request("claimSubscription", options);
		},
		loadCheckpoint(options: { subscriptionId: string; partitionId: string }) {
			return client.request("loadCheckpoint", options);
		},
		commitCheckpoint(options: CommitCheckpointOptions) {
			return client.request("commitCheckpoint", options);
		},
		resetCheckpoint(options: ResetCheckpointOptions) {
			return client.request("resetCheckpoint", options);
		},
		async close() {
			try {
				await client.request("close", undefined);
			} finally {
				client.terminate();
			}
		},
	};
}
