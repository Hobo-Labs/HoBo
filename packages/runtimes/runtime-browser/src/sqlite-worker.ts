import {
	CheckpointRegressionError,
	MissingFenceError,
	OptimisticSequenceConflictError,
	SnapshotAheadError,
	StaleFenceError,
} from "@hobo/core/eventstore";
import { SqliteJournal } from "@hobo/storage-sqlite/browser";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { isJsonString } from "./json.js";
import { createSqliteWasmDriver } from "./sqlite-wasm-driver.js";
import type {
	WorkerFailure,
	WorkerMessage,
	WorkerRequest,
} from "./worker-rpc.js";

let journal: SqliteJournal | undefined;
const subscriptions = new Map<string, { unsubscribe(): void }>();
let pending = Promise.resolve();

function send(message: WorkerMessage): void {
	postMessage(message, { transfer: [] });
}

async function open(
	input: Extract<WorkerRequest, { op: "open" }>["input"],
): Promise<void> {
	if (journal) throw new Error("Browser journal is already open");
	const sqlite = await sqlite3InitModule({ locateFile: () => input.wasmUrl });
	let database: InstanceType<typeof sqlite.oo1.DB>;
	if (input.durable) {
		const digest = new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(input.partitionId),
			),
		);
		const partition = Array.from(digest, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const pool = await sqlite.installOpfsSAHPoolVfs({
			directory: `hobo-eventstore-${partition}`,
		});
		database = new pool.OpfsSAHPoolDb("/journal.sqlite3");
	} else {
		database = new sqlite.oo1.DB(":memory:");
	}
	try {
		journal = new SqliteJournal(createSqliteWasmDriver(database), {
			partitionId: input.partitionId,
			nativePragmas: false,
		});
	} catch (error) {
		database.close();
		throw error;
	}
}

function activeJournal(): SqliteJournal {
	if (!journal) throw new Error("Browser journal is not open");
	return journal;
}

function describeFailure<T>(error: T): WorkerFailure["error"] {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : String(error);
	const code =
		error instanceof Error && "code" in error && isJsonString(error.code)
			? error.code
			: undefined;
	const base = { name, message, ...(code ? { code } : undefined) };
	if (error instanceof OptimisticSequenceConflictError)
		return {
			...base,
			details: {
				kind: "sequence",
				streamId: error.streamId,
				expectedSeq: error.expectedSeq,
				actualSeq: error.actualSeq,
			},
		};
	if (error instanceof StaleFenceError)
		return {
			...base,
			details: {
				kind: "stale-fence",
				streamId: error.streamId,
				provided: error.provided,
				stored: error.stored,
			},
		};
	if (error instanceof MissingFenceError)
		return {
			...base,
			details: {
				kind: "missing-fence",
				streamId: error.streamId,
				stored: error.stored,
			},
		};
	if (error instanceof SnapshotAheadError)
		return {
			...base,
			details: {
				kind: "snapshot",
				streamId: error.streamId,
				snapshotSeq: error.snapshotSeq,
				headSeq: error.headSeq,
			},
		};
	if (error instanceof CheckpointRegressionError)
		return {
			...base,
			details: {
				kind: "checkpoint",
				subscriptionId: error.subscriptionId,
				partitionId: error.partitionId,
				attempted: error.attempted,
				current: error.current,
			},
		};
	return base;
}

async function dispatch(request: WorkerRequest): Promise<void> {
	try {
		const { id, op, input } = request;
		switch (op) {
			case "open":
				await open(input);
				send({ id, op, ok: true, result: undefined });
				break;
			case "append":
				send({
					id,
					op,
					ok: true,
					result: await activeJournal().append(
						input.streamId,
						input.events,
						input.options,
					),
				});
				break;
			case "commit":
				send({ id, op, ok: true, result: await activeJournal().commit(input) });
				break;
			case "read": {
				const result = [];
				for await (const event of activeJournal().read(
					input.streamId,
					input.fromSeq,
				))
					result.push(event);
				send({ id, op, ok: true, result });
				break;
			}
			case "readAll": {
				const result = [];
				for await (const event of activeJournal().readAll(input))
					result.push(event);
				send({ id, op, ok: true, result });
				break;
			}
			case "snapshot":
				send({
					id,
					op,
					ok: true,
					result: await activeJournal().snapshot(
						input.streamId,
						input.state,
						input.seq,
					),
				});
				break;
			case "loadSnapshot":
				send({
					id,
					op,
					ok: true,
					result: await activeJournal().loadSnapshot(input.streamId),
				});
				break;
			case "claimSubscription":
				send({
					id,
					op,
					ok: true,
					result: await activeJournal().claimSubscription(input),
				});
				break;
			case "loadCheckpoint":
				send({
					id,
					op,
					ok: true,
					result: await activeJournal().loadCheckpoint(input),
				});
				break;
			case "commitCheckpoint":
				send({
					id,
					op,
					ok: true,
					result: await activeJournal().commitCheckpoint(input),
				});
				break;
			case "resetCheckpoint":
				send({
					id,
					op,
					ok: true,
					result: await activeJournal().resetCheckpoint(input),
				});
				break;
			case "subscribe": {
				const subscription = activeJournal().subscribe(
					input.filter,
					(event) => {
						send({
							type: "event",
							subscriptionId: input.subscriptionId,
							event,
						});
					},
				);
				subscriptions.set(input.subscriptionId, subscription);
				send({ id, op, ok: true, result: undefined });
				break;
			}
			case "unsubscribe":
				subscriptions.get(input.subscriptionId)?.unsubscribe();
				subscriptions.delete(input.subscriptionId);
				send({ id, op, ok: true, result: undefined });
				break;
			case "close":
				for (const subscription of subscriptions.values())
					subscription.unsubscribe();
				subscriptions.clear();
				activeJournal().close();
				journal = undefined;
				send({ id, op, ok: true, result: undefined });
				break;
		}
	} catch (error) {
		send({ id: request.id, ok: false, error: describeFailure(error) });
	}
}

globalThis.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
	pending = pending.then(() => dispatch(event.data));
});
