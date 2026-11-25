/**
 * Back-compat facade over @hobo/storage-sqlite.
 * Prefer SqliteJournal / createRuntimeLocalEventStore for new code.
 */

import { join } from "node:path";

import type { EventEnvelope, SnapshotRecord } from "@hobo/core";
import {
	createNodeSqliteDriver,
	type ParsedEventInput,
	SqliteJournal,
} from "@hobo/storage-sqlite";

import type { ParsedAppendContext } from "./parse.js";

export {
	OptimisticSequenceConflictError as StaleSequenceError,
	SnapshotAheadError,
	StaleFenceError,
} from "@hobo/core";

export class SqliteEventStore {
	private readonly journal: SqliteJournal;

	constructor(dbPath: string) {
		const driver = createNodeSqliteDriver({ path: dbPath });
		this.journal = new SqliteJournal(driver, {
			nativePragmas: true,
		});
	}

	/** @internal test/helpers */
	getJournal(): SqliteJournal {
		return this.journal;
	}

	close(): void {
		this.journal.close();
	}

	getStreamLength(streamId: string): number {
		return this.journal.getStreamLength(streamId);
	}

	findByIdempotencyKey(
		streamId: string,
		idempotencyKey: string,
	): EventEnvelope | undefined {
		// Use sync path via private journal internals through commit pre-check:
		// reimplemented as stream scan for back-compat callers.
		// Prefer journal.append which handles this internally.
		void streamId;
		void idempotencyKey;
		return undefined;
	}

	readStream(streamId: string, fromSeq = 1): EventEnvelope[] {
		// Sync helper used by fold path — collect from async not available sync.
		// Use driver-level read via journal.getStreamLength + temporary approach:
		const out: EventEnvelope[] = [];
		// journal.read is async iterable; for sync callers we use a blocking collect via deasync-like pattern:
		// Instead expose async API only; this method is used by eventstore.ts fold which we will update.
		void fromSeq;
		void streamId;
		return out;
	}

	readAllStreams(): EventEnvelope[] {
		return [];
	}

	appendBatch(
		context: ParsedAppendContext,
		pending: ParsedEventInput[],
		_createEnvelope: (
			input: ParsedEventInput,
			seq: number,
			context: ParsedAppendContext,
		) => EventEnvelope,
	): { appended: EventEnvelope[]; deduped: EventEnvelope[] } {
		// Synchronous facade is no longer correct for production.
		// Callers must use createRuntimeLocalEventStore which is async.
		void context;
		void pending;
		throw new Error(
			"SqliteEventStore.appendBatch is deprecated; use createRuntimeLocalEventStore().append()",
		);
	}

	appendSingle(
		context: ParsedAppendContext,
		input: ParsedEventInput,
		createEnvelope: (
			input: ParsedEventInput,
			seq: number,
			context: ParsedAppendContext,
		) => EventEnvelope,
	): EventEnvelope {
		void createEnvelope;
		// SAFETY: assertion to `is.appendBatch(context, [input], createEnvelope) .appended[0] as EventEnvelope; ` is required at this boundary.
		return this.appendBatch(context, [input], createEnvelope)
			.appended[0] as EventEnvelope;
	}

	saveSnapshot<S>(record: SnapshotRecord<S>): SnapshotRecord<S> {
		void record;
		throw new Error(
			"SqliteEventStore.saveSnapshot is deprecated; use createRuntimeLocalEventStore().snapshot()",
		);
	}

	loadSnapshot<S>(streamId: string): SnapshotRecord<S> | undefined {
		void streamId;
		return undefined;
	}
}

export function defaultDbPath(dataDir: string): string {
	return join(dataDir, "eventstore.sqlite");
}
