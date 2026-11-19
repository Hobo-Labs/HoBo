import { parentPort, workerData } from "node:worker_threads";
import type {
	AppendOptions,
	AppendResult,
	DurableCommitRequest,
	DurableCommitResult,
	EventEnvelope,
	EventInput,
	PositionedEvent,
	ReadAllOptions,
	SnapshotRecord,
} from "@hobo/core";
import { createNodeSqliteDriver, SqliteJournal } from "@hobo/storage-sqlite";
import {
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "../json.js";

export type StorageWorkerRequest =
	| {
			id: string;
			op: "append";
			streamId: string;
			events: EventInput[];
			options: AppendOptions;
	  }
	| {
			id: string;
			op: "commit";
			request: DurableCommitRequest;
	  }
	| {
			id: string;
			op: "read";
			streamId: string;
			fromSeq?: number;
	  }
	| {
			id: string;
			op: "readAll";
			options?: ReadAllOptions;
	  }
	| {
			id: string;
			op: "snapshot";
			streamId: string;
			state: JsonValue;
			seq: number;
	  }
	| {
			id: string;
			op: "loadSnapshot";
			streamId: string;
	  }
	| {
			id: string;
			op: "shutdown";
	  };

export interface StorageWorkerResults {
	append: AppendResult;
	commit: DurableCommitResult;
	read: EventEnvelope[];
	readAll: PositionedEvent[];
	snapshot: SnapshotRecord;
	loadSnapshot: SnapshotRecord | null;
	shutdown: null;
}

export type StorageWorkerSuccess = {
	[Op in keyof StorageWorkerResults]: {
		id: string;
		ok: true;
		op: Op;
		result: StorageWorkerResults[Op];
	};
}[keyof StorageWorkerResults];

export type StorageWorkerResponse =
	| StorageWorkerSuccess
	| {
			id: string;
			ok: false;
			error: { name: string; message: string; code?: string };
	  };

interface SerializedWorkerError {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
}

function serializeError(error: Error): SerializedWorkerError {
	const code =
		"code" in error && isJsonString(error.code) ? error.code : undefined;
	return {
		name: error.name,
		message: error.message,
		...(code !== undefined ? { code } : undefined),
	};
}

async function main(): Promise<void> {
	if (!parentPort) {
		throw new Error("storage-worker must run as a worker thread");
	}
	const data = parseJsonValue(JSON.stringify(workerData));
	if (
		!isJsonObject(data) ||
		!isJsonString(data.dbPath) ||
		(data.partitionId !== undefined && !isJsonString(data.partitionId))
	) {
		throw new TypeError(
			"storage worker requires a database path and optional partition id",
		);
	}
	const driver = createNodeSqliteDriver({ path: data.dbPath });
	const journal = new SqliteJournal(driver, {
		nativePragmas: true,
		partitionId: data.partitionId ?? "default",
	});

	parentPort.on("message", async (msg: StorageWorkerRequest) => {
		const port = parentPort;
		if (!port) return;
		try {
			switch (msg.op) {
				case "append": {
					const result = await journal.append(
						msg.streamId,
						msg.events,
						msg.options,
					);
					port.postMessage({
						id: msg.id,
						ok: true,
						op: msg.op,
						result,
					} satisfies StorageWorkerResponse);
					break;
				}
				case "commit": {
					const result = await journal.commit(msg.request);
					port.postMessage({
						id: msg.id,
						ok: true,
						op: msg.op,
						result,
					} satisfies StorageWorkerResponse);
					break;
				}
				case "read": {
					const events = [];
					for await (const e of journal.read(msg.streamId, msg.fromSeq ?? 1)) {
						events.push(e);
					}
					port.postMessage({
						id: msg.id,
						ok: true,
						op: msg.op,
						result: events,
					} satisfies StorageWorkerResponse);
					break;
				}
				case "readAll": {
					const events = [];
					for await (const e of journal.readAll(msg.options)) {
						events.push(e);
					}
					port.postMessage({
						id: msg.id,
						ok: true,
						op: msg.op,
						result: events,
					} satisfies StorageWorkerResponse);
					break;
				}
				case "snapshot": {
					const result = await journal.snapshot(
						msg.streamId,
						msg.state,
						msg.seq,
					);
					port.postMessage({
						id: msg.id,
						ok: true,
						op: msg.op,
						result,
					} satisfies StorageWorkerResponse);
					break;
				}
				case "loadSnapshot": {
					const result = await journal.loadSnapshot(msg.streamId);
					port.postMessage({
						id: msg.id,
						ok: true,
						op: msg.op,
						result: result ?? null,
					} satisfies StorageWorkerResponse);
					break;
				}
				case "shutdown": {
					journal.close();
					port.postMessage({
						id: msg.id,
						ok: true,
						op: msg.op,
						result: null,
					} satisfies StorageWorkerResponse);
					break;
				}
				default: {
					const unknownRequest: { id: string; op: string } = msg;
					port.postMessage({
						id: unknownRequest.id,
						ok: false,
						error: {
							name: "StorageWorkerProtocolMismatch",
							message: `unknown op: ${unknownRequest.op}`,
							code: "STORAGE_WORKER_PROTOCOL_MISMATCH",
						},
					} satisfies StorageWorkerResponse);
				}
			}
		} catch (error) {
			port.postMessage({
				id: msg.id,
				ok: false,
				error: serializeError(
					error instanceof Error ? error : new Error(String(error)),
				),
			} satisfies StorageWorkerResponse);
		}
	});
}

void main();
