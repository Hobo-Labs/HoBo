import type {
	AppendOptions,
	AppendResult,
	DurableCommitRequest,
	DurableCommitResult,
	DurableEventStore,
	EventEnvelope,
	EventInput,
	PositionedEvent,
	ReadAllOptions,
	SnapshotRecord,
	StreamFilter,
	Subscription,
} from "@hobo/core/eventstore";
import { PersistenceUnavailableError } from "@hobo/core/eventstore";
import type { SqliteJournal } from "@hobo/storage-sqlite/browser";
import { detectBrowserPersistence } from "./detect.js";
import type { JsonValue } from "./json.js";
import { openMultiTabStore } from "./multi-tab-store.js";
import type {
	BrowserPersistenceMode,
	BrowserStorageOpenOptions,
} from "./types.js";
import { openWorkerStore } from "./worker-store.js";

export interface BrowserEventStore extends DurableEventStore {
	readonly persistenceMode: BrowserPersistenceMode;
	close(): Promise<void>;
}

export async function createBrowserEventStore(
	options: BrowserStorageOpenOptions,
): Promise<BrowserEventStore> {
	const detection = detectBrowserPersistence({
		...(options.allowTransient !== undefined
			? { allowTransient: options.allowTransient }
			: undefined),
		...(options.multiTab !== undefined
			? { multiTab: options.multiTab }
			: undefined),
	});

	if (detection.mode === "unavailable") {
		throw new PersistenceUnavailableError(
			detection.reason ?? "browser persistence unavailable",
		);
	}
	if (options.multiTab) {
		if (
			detection.mode !== "opfs-sahpool" ||
			!globalThis.navigator?.locks ||
			!("BroadcastChannel" in globalThis) ||
			!("Worker" in globalThis)
		) {
			throw new PersistenceUnavailableError(
				"Multi-tab storage requires OPFS, Web Locks, BroadcastChannel, and workers",
			);
		}
		try {
			return await openMultiTabStore({
				partitionId: options.partitionId,
				wasmUrl: new URL("./sqlite3.wasm", import.meta.url).href,
			});
		} catch (error) {
			throw new PersistenceUnavailableError(
				`Browser storage could not open: ${String(error)}`,
			);
		}
	}

	if ("Worker" in globalThis) {
		const wasmUrl = new URL("./sqlite3.wasm", import.meta.url).href;
		try {
			return await openWorkerStore({
				partitionId: options.partitionId,
				mode: detection.mode,
				wasmUrl,
			});
		} catch (error) {
			if (!options.allowTransient || detection.mode === "transient-memory") {
				throw new PersistenceUnavailableError(
					`Browser storage could not open: ${String(error)}`,
				);
			}
			try {
				return await openWorkerStore({
					partitionId: options.partitionId,
					mode: "transient-memory",
					wasmUrl,
				});
			} catch (fallbackError) {
				throw new PersistenceUnavailableError(
					`Browser storage could not open: ${String(fallbackError)}`,
				);
			}
		}
	}

	if (options.allowTransient === true) {
		const packageName = "@hobo/storage-sqlite";
		const nodeStorage: typeof import("@hobo/storage-sqlite") = await import(
			packageName
		);
		const journal = new nodeStorage.SqliteJournal(
			nodeStorage.createMemoryNodeSqliteDriver(),
			{
				nativePragmas: false,
				partitionId: options.partitionId,
			},
		);
		return wrapJournal(journal, "transient-memory");
	}

	throw new PersistenceUnavailableError(
		"SQLite WASM/OPFS durable open unavailable in this environment; pass allowTransient:true for explicit non-durable mode",
	);
}

function wrapJournal(
	journal: SqliteJournal,
	mode: BrowserPersistenceMode,
): BrowserEventStore {
	return Object.freeze({
		persistenceMode: mode,
		append(
			streamId: string,
			events: EventInput[],
			opts: AppendOptions,
		): Promise<AppendResult> {
			return journal.append(streamId, events, opts);
		},
		commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
			return journal.commit(request);
		},
		read(streamId: string, fromSeq?: number): AsyncIterable<EventEnvelope> {
			return journal.read(streamId, fromSeq);
		},
		readAll(options?: ReadAllOptions): AsyncIterable<PositionedEvent> {
			return journal.readAll(options);
		},
		subscribe(
			filter: StreamFilter,
			handler: (event: EventEnvelope) => void | Promise<void>,
		): Subscription {
			return journal.subscribe(filter, handler);
		},
		snapshot(
			streamId: string,
			state: JsonValue,
			seq: number,
		): Promise<SnapshotRecord> {
			return journal.snapshot(streamId, state, seq);
		},
		loadSnapshot<S>(streamId: string) {
			return journal.loadSnapshot<S>(streamId);
		},
		claimSubscription: journal.claimSubscription.bind(journal),
		loadCheckpoint: journal.loadCheckpoint.bind(journal),
		commitCheckpoint: journal.commitCheckpoint.bind(journal),
		resetCheckpoint: journal.resetCheckpoint.bind(journal),
		async close() {
			journal.close();
		},
	});
}
