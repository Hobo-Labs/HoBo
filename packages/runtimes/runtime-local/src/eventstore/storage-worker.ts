/**
 * Serialized storage-owner Worker Thread protocol for node:sqlite.
 * Production EventStore calls should route through this boundary so
 * DatabaseSync never blocks the main runtime event loop unboundedly.
 */

import { parentPort, workerData } from "node:worker_threads";
import type {
	AppendOptions,
	DurableCommitRequest,
	EventInput,
	ReadAllOptions,
} from "@hobo/core";
import { createNodeSqliteDriver, SqliteJournal } from "@hobo/storage-sqlite";
import {
	isJsonBigInt,
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

export type StorageWorkerResponse =
	| { id: string; ok: true; result: JsonValue }
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

interface CodedError {
	readonly code?: string;
}

function serializeError(error: Error): SerializedWorkerError {
	// SAFETY: worker errors may carry a string `code` at this boundary.
	const coded = error as CodedError;
	const code = isJsonString(coded.code) ? coded.code : undefined;
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
	// SAFETY: assertion to `workerData as { dbPath: string; partitionId?: string }` is required at this boundary.
	const data = workerData as { dbPath: string; partitionId?: string };
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
						result: serializeBigints(result),
					} satisfies StorageWorkerResponse);
					break;
				}
				case "commit": {
					const result = await journal.commit(msg.request);
					port.postMessage({
						id: msg.id,
						ok: true,
						result: serializeBigints(result),
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
						result: serializeBigints(events),
					} satisfies StorageWorkerResponse);
					break;
				}
				case "readAll": {
					const events = [];
					for await (const e of journal.readAll(msg.options)) {
						events.push(serializeBigints(e));
					}
					port.postMessage({
						id: msg.id,
						ok: true,
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
						result: serializeBigints(result),
					} satisfies StorageWorkerResponse);
					break;
				}
				case "loadSnapshot": {
					const result = await journal.loadSnapshot(msg.streamId);
					port.postMessage({
						id: msg.id,
						ok: true,
						result: result === undefined ? null : serializeBigints(result),
					} satisfies StorageWorkerResponse);
					break;
				}
				case "shutdown": {
					journal.close();
					port.postMessage({
						id: msg.id,
						ok: true,
						result: null,
					} satisfies StorageWorkerResponse);
					break;
				}
				default: {
					const _x: never = msg;
					port.postMessage({
						// SAFETY: assertion to `msg as { id: string }` is required at this boundary.
						id: (msg as { id: string }).id,
						ok: false,
						error: {
							name: "StorageWorkerProtocolMismatch",
							message: `unknown op: ${JSON.stringify(_x)}`,
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

/** JSON-safe: bigint → decimal string tagged form. */
function serializeBigints<T>(value: T): JsonValue {
	return parseJsonValue(
		JSON.stringify(value, (_k, v) =>
			isJsonBigInt(v) ? { $bigint: v.toString(10) } : v,
		),
	);
}

void main();
