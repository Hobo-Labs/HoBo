
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
		void streamId;
		void idempotencyKey;
		return undefined;
	}

	readStream(streamId: string, fromSeq = 1): EventEnvelope[] {
		const out: EventEnvelope[] = [];
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
