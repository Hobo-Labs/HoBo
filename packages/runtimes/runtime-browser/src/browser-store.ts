
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
} from "@hobo/core";
import { PersistenceUnavailableError } from "@hobo/core";
import {
	createMemoryNodeSqliteDriver,
	SqliteJournal,
} from "@hobo/storage-sqlite";
import { detectBrowserPersistence, hasOpfs } from "./detect.js";
import type { JsonValue } from "./json.js";
import type {
	BrowserPersistenceMode,
	BrowserStorageOpenOptions,
} from "./types.js";

export interface BrowserEventStore extends DurableEventStore {
	readonly persistenceMode: BrowserPersistenceMode;
	close(): void;
	/** @internal */
	journal(): SqliteJournal;
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

	const opfsJournal = await tryOpenSqliteWasm(
		options.partitionId,
		detection.mode,
	);
	if (opfsJournal) {
		return wrapJournal(opfsJournal, "opfs-sahpool");
	}

	if (
		options.allowTransient === true ||
		detection.mode === "transient-memory"
	) {
		const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
			nativePragmas: false,
			partitionId: options.partitionId,
		});
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
		journal: () => journal,
		close() {
			journal.close();
		},
	});
}

async function tryOpenSqliteWasm(
	_partitionId: string,
	_mode: BrowserPersistenceMode,
): Promise<SqliteJournal | null> {
	try {
		await import("@sqlite.org/sqlite-wasm");
	} catch {
		return null;
	}
	if (!hasOpfs()) {
		return null;
	}
	return null;
}
